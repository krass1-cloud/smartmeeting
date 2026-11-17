#!/usr/bin/env python3
"""
SmartMeeting - Módulo de Notificação Pós-Aprovação (Issue 10)
Responsável por validar a aprovação do gerente, agrupar tarefas por funcionário
e enviar notificações consolidadas por e-mail (ou simular no terminal).
"""

from __future__ import annotations

import html
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_PASTA_ATUAL = Path(__file__).resolve().parent
if str(_PASTA_ATUAL) not in sys.path:
    sys.path.insert(0, str(_PASTA_ATUAL))

from config_ia import carregar_variaveis_ambiente, gerar_email_corporativo_provisorio

# Carrega as variáveis de ambiente definidas no ficheiro .env (docs/ ou raiz)
carregar_variaveis_ambiente()

MARCADORES_SEM_RESPONSAVEL = {"", "a definir", "por atribuir", "indefinido", "n/a", "none", "null"}


class ErroValidacaoGerente(Exception):
    """Exceção lançada quando se tenta notificar sem aprovação do gerente."""
    pass


def _construir_corpo_texto(
    nome: str,
    funcao: str,
    titulo_reuniao: str,
    data_reuniao: str,
    tarefas: List[Dict[str, Any]],
) -> str:
    """Gera o conteúdo em texto simples do e-mail consolidado para o funcionário."""
    linhas = [
        f"Olá, {nome},",
        "",
        f"As decisões e tarefas da reunião \"{titulo_reuniao}\" ({data_reuniao}) "
        "foram revistas e aprovadas pela gestão.",
        "",
        f"A tua função identificada nesta iniciativa: {funcao}",
        "",
        f"Resumo das tuas tarefas atribuídas ({len(tarefas)}):",
        "-" * 60,
    ]

    for idx, tarefa in enumerate(tarefas, start=1):
        descricao = tarefa.get("descricao") or tarefa.get("titulo") or "Sem descrição"
        prazo = tarefa.get("prazo") or "A definir"
        prioridade = str(tarefa.get("prioridade", "Média")).upper()

        linhas.append(f"{idx}. {descricao}")
        linhas.append(f"   • Prazo: {prazo} | Prioridade: {prioridade}")
        if tarefa.get("notas"):
            linhas.append(f"   • Notas da gestão: {tarefa['notas']}")
        linhas.append("")

    linhas.extend([
        "-" * 60,
        "Este alerta foi gerado automaticamente pelo SmartMeeting após validação do gerente.",
        "Bom trabalho!",
    ])

    return "\n".join(linhas)


def _construir_corpo_html(
    nome: str,
    funcao: str,
    titulo_reuniao: str,
    data_reuniao: str,
    tarefas: List[Dict[str, Any]],
) -> str:
    """Gera a versão HTML formatada e escapada do e-mail para clientes de correio modernos."""
    itens_html = ""
    for tarefa in tarefas:
        descricao = html.escape(str(tarefa.get("descricao") or tarefa.get("titulo") or "Sem descrição"))
        prazo = html.escape(str(tarefa.get("prazo") or "A definir"))
        prioridade = html.escape(str(tarefa.get("prioridade", "Média")).upper())
        notas_html = (
            f"<p style='margin:4px 0 0;font-size:12px;color:#475569;'>"
            f"<em>Nota: {html.escape(str(tarefa['notas']))}</em></p>"
            if tarefa.get("notas")
            else ""
        )

        itens_html += f"""
        <li style="margin-bottom:12px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
          <strong style="color:#0f172a;font-size:14px;">{descricao}</strong>
          <div style="margin-top:6px;font-size:12px;color:#334155;">
            <span><strong>Prazo:</strong> {prazo}</span> &nbsp;·&nbsp;
            <span><strong>Prioridade:</strong> {prioridade}</span>
          </div>
          {notas_html}
        </li>
        """

    nome_esc = html.escape(nome)
    funcao_esc = html.escape(funcao)
    titulo_esc = html.escape(titulo_reuniao)
    data_esc = html.escape(data_reuniao)

    return f"""
    <html>
      <body style="font-family:Arial,Helvetica,sans-serif;color:#1e293b;line-height:1.5;max-width:640px;margin:0 auto;padding:20px;">
        <div style="border-bottom:2px solid #06b6d4;padding-bottom:12px;margin-bottom:20px;">
          <h2 style="margin:0;color:#0f172a;">SmartMeeting · Distribuição de Tarefas</h2>
          <p style="margin:4px 0 0;font-size:13px;color:#64748b;">
            Reunião: <strong>{titulo_esc}</strong> ({data_esc})
          </p>
        </div>

        <p>Olá, <strong>{nome_esc}</strong>,</p>
        <p>
          O mapa de tarefas desta reunião foi validado pelo gerente.
          A tua função atribuída no contexto desta reunião é:
          <strong style="color:#0284c7;">{funcao_esc}</strong>.
        </p>

        <h3 style="margin-top:24px;font-size:15px;color:#0f172a;">
          As tuas tarefas atribuídas ({len(tarefas)}):
        </h3>
        <ul style="list-style:none;padding:0;margin:12px 0;">
          {itens_html}
        </ul>

        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
        <p style="font-size:11px;color:#94a3b8;">
          Notificação automática enviada pelo SmartMeeting após aprovação do gerente.
        </p>
      </body>
    </html>
    """


def _agrupar_tarefas_por_funcionario(
    dados_reuniao: Dict[str, Any]
) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Mapeia cada participante pela sua identidade (e-mail ou nome) e agrupa
    todas as tarefas elegíveis atribuídas numa única entrada por pessoa.
    Tarefas sem responsável definido são devolvidas à parte em `tarefas_sem_responsavel`.
    """
    participantes = dados_reuniao.get("participantes", [])
    tarefas = dados_reuniao.get("tarefas", [])

    mapa_por_email: Dict[str, Dict[str, Any]] = {}
    mapa_por_nome: Dict[str, str] = {}

    for p in participantes:
        email = (p.get("email") or "").strip().lower()
        nome = (p.get("nome") or "").strip()
        if not nome and not email:
            continue
        nome_exibicao = nome or email
        funcao = (p.get("funcao") or "Membro da Equipa").strip()

        chave = email if email else nome_exibicao.lower()
        mapa_por_email[chave] = {
            "nome": nome_exibicao,
            "email": (p.get("email") or "").strip(),
            "funcao": funcao,
            "tarefas": [],
        }
        if nome:
            mapa_por_nome[nome.lower()] = chave

    tarefas_sem_responsavel: List[Dict[str, Any]] = []

    for tarefa in tarefas:
        estado = str(tarefa.get("estado", "")).strip().lower()
        if estado == "rejeitada":
            continue

        email_resp = (tarefa.get("email_responsavel") or "").strip().lower()
        nome_resp_orig = (tarefa.get("responsavel") or "").strip()
        nome_resp = nome_resp_orig.lower()

        if not email_resp and nome_resp in MARCADORES_SEM_RESPONSAVEL:
            tarefas_sem_responsavel.append(tarefa)
            continue

        chave_destino: Optional[str] = None
        if email_resp and email_resp in mapa_por_email:
            chave_destino = email_resp
        elif nome_resp and nome_resp in mapa_por_nome:
            chave_destino = mapa_por_nome[nome_resp]
        elif email_resp or nome_resp_orig:
            chave_destino = email_resp or nome_resp
            mapa_por_email[chave_destino] = {
                "nome": nome_resp_orig or email_resp,
                "email": (tarefa.get("email_responsavel") or "").strip(),
                "funcao": tarefa.get("funcao_responsavel", "Membro da Equipa"),
                "tarefas": [],
            }
            if nome_resp:
                mapa_por_nome[nome_resp] = chave_destino

        if chave_destino:
            mapa_por_email[chave_destino]["tarefas"].append(tarefa)

    agrupamento = {
        chave: info
        for chave, info in mapa_por_email.items()
        if len(info["tarefas"]) > 0
    }
    return agrupamento, tarefas_sem_responsavel


def _enviar_email_smtp(
    mensagem: EmailMessage,
    smtp_server: str,
    smtp_port: int,
    email_remetente: str,
    email_password: str,
) -> None:
    """Efetua a ligação segura ao servidor SMTP e envia a mensagem."""
    contexto_ssl = ssl.create_default_context()

    if smtp_port == 465:
        with smtplib.SMTP_SSL(smtp_server, smtp_port, context=contexto_ssl) as servidor:
            servidor.login(email_remetente, email_password)
            servidor.send_message(mensagem)
    else:
        with smtplib.SMTP(smtp_server, smtp_port) as servidor:
            servidor.ehlo()
            servidor.starttls(context=contexto_ssl)
            servidor.ehlo()
            servidor.login(email_remetente, email_password)
            servidor.send_message(mensagem)


def enviar_notificacoes_aprovadas(
    dados_reuniao: Dict[str, Any],
    modo_teste: bool = False,
    lancar_erro_se_nao_aprovado: bool = False,
) -> Dict[str, Any]:
    """
    Função principal do módulo notificador:
    1. Valida obrigatoriamente se `aprovado_gerente` é True.
    2. Agrupa tarefas atribuídas por funcionário (1 e-mail por pessoa), isolando tarefas sem responsável.
    3. Envia via SMTP ou imprime a simulação no terminal se `modo_teste=True`.
    """
    aprovado = dados_reuniao.get("aprovado_gerente")
    if aprovado is not True:
        aviso = (
            "[BLOQUEADO] Envio de notificações cancelado: "
            "o mapa de tarefas ainda aguarda validação do gerente (aprovado_gerente=False)."
        )
        print(aviso)
        if lancar_erro_se_nao_aprovado:
            raise ErroValidacaoGerente(aviso)
        return {
            "enviado": False,
            "motivo": "Aguarda validação do gerente.",
            "total_notificados": 0,
            "tarefas_sem_responsavel": [],
            "detalhes": [],
        }

    titulo_reuniao = dados_reuniao.get("titulo_reuniao", "Reunião de Equipa")
    data_reuniao = dados_reuniao.get("data", "Data não especificada")

    agrupamento, tarefas_sem_responsavel = _agrupar_tarefas_por_funcionario(dados_reuniao)

    if tarefas_sem_responsavel:
        print(
            f"[AVISO] {len(tarefas_sem_responsavel)} tarefa(s) marcada(s) como 'A definir' "
            "não geraram e-mail por falta de responsável."
        )

    if not agrupamento:
        print("[INFO] Reunião aprovada, mas não existem tarefas atribuídas a responsáveis para notificar.")
        return {
            "enviado": True,
            "motivo": "Sem tarefas atribuídas para envio.",
            "total_notificados": 0,
            "tarefas_sem_responsavel": tarefas_sem_responsavel,
            "detalhes": [],
        }

    email_remetente = os.getenv("EMAIL_REMETENTE", "noreply@smartmeeting.ai")
    email_password = os.getenv("EMAIL_PASSWORD", "")
    smtp_server = os.getenv("SMTP_SERVER", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))

    if not modo_teste and (not email_remetente or not email_password or not smtp_server):
        raise ValueError(
            "Credenciais SMTP incompletas no ficheiro .env. "
            "Verifique EMAIL_REMETENTE, EMAIL_PASSWORD, SMTP_SERVER e SMTP_PORT."
        )

    resultados: List[Dict[str, Any]] = []

    for info in agrupamento.values():
        nome = info["nome"]
        email_destino = info["email"]
        funcao = info["funcao"]
        tarefas_funcionario = info["tarefas"]

        if not email_destino and not modo_teste:
            print(f"[AVISO] Funcionário '{nome}' não possui e-mail configurado. Ignorado.")
            resultados.append({"nome": nome, "status": "ignorado_sem_email"})
            continue

        assunto = f"[SmartMeeting] As tuas tarefas aprovadas — {titulo_reuniao}"
        corpo_texto = _construir_corpo_texto(
            nome=nome,
            funcao=funcao,
            titulo_reuniao=titulo_reuniao,
            data_reuniao=data_reuniao,
            tarefas=tarefas_funcionario,
        )
        corpo_html = _construir_corpo_html(
            nome=nome,
            funcao=funcao,
            titulo_reuniao=titulo_reuniao,
            data_reuniao=data_reuniao,
            tarefas=tarefas_funcionario,
        )

        msg = EmailMessage()
        msg["Subject"] = assunto
        msg["From"] = f"SmartMeeting <{email_remetente}>"
        msg["To"] = email_destino or gerar_email_corporativo_provisorio(nome) or "equipa@empresa.pt"
        msg.set_content(corpo_texto)
        msg.add_alternative(corpo_html, subtype="html")

        if modo_teste:
            print("\n" + "=" * 70)
            print(" [MODO SIMULAÇÃO] PRÉ-VISUALIZAÇÃO DO E-MAIL A ENVIAR")
            print("=" * 70)
            print(f"De:       {msg['From']}")
            print(f"Para:     {msg['To']}")
            print(f"Assunto:  {msg['Subject']}")
            print("-" * 70)
            print(corpo_texto)
            print("=" * 70)
            resultados.append({
                "nome": nome,
                "email": msg["To"],
                "funcao": funcao,
                "qtd_tarefas": len(tarefas_funcionario),
                "status": "simulado_com_sucesso",
            })
        else:
            try:
                _enviar_email_smtp(
                    mensagem=msg,
                    smtp_server=smtp_server,
                    smtp_port=smtp_port,
                    email_remetente=email_remetente,
                    email_password=email_password,
                )
                print(f"[SUCESSO] E-mail enviado para {nome} ({email_destino}) com {len(tarefas_funcionario)} tarefa(s).")
                resultados.append({
                    "nome": nome,
                    "email": email_destino,
                    "funcao": funcao,
                    "qtd_tarefas": len(tarefas_funcionario),
                    "status": "enviado",
                })
            except smtplib.SMTPException as erro:
                print(f"[ERRO SMTP] Falha ao enviar para {nome} ({email_destino}): {erro}")
                resultados.append({
                    "nome": nome,
                    "email": email_destino,
                    "status": "erro_envio",
                    "erro": str(erro),
                })

    return {
        "enviado": True,
        "modo_teste": modo_teste,
        "total_notificados": sum(1 for r in resultados if r["status"] in ("enviado", "simulado_com_sucesso")),
        "tarefas_sem_responsavel": tarefas_sem_responsavel,
        "detalhes": resultados,
    }


if __name__ == "__main__":
    reuniao_pendente = {
        "titulo_reuniao": "Sprint 45 - Planeamento Inicial",
        "data": "2026-11-17",
        "aprovado_gerente": False,
        "participantes": [
            {"nome": "Carlos Mendes", "email": "carlos.mendes@empresa.pt", "funcao": "Backend Lead"}
        ],
        "tarefas": [
            {
                "descricao": "Configurar pipeline de CI/CD",
                "responsavel": "Carlos Mendes",
                "prazo": "2026-11-20",
                "prioridade": "Alta",
            }
        ],
    }

    print("\n>>> TESTE 1: Tentativa de envio com aprovado_gerente=False")
    enviar_notificacoes_aprovadas(reuniao_pendente, modo_teste=True)

    reuniao_aprovada = {
        "titulo_reuniao": "Alinhamento de Release & Gateway de Pagamentos",
        "data": "2026-11-17",
        "aprovado_gerente": True,
        "participantes": [
            {"nome": "Carlos Mendes", "email": "carlos.mendes@empresa.pt", "funcao": "Backend Lead"},
            {"nome": "Mariana Silva", "email": "mariana.silva@empresa.pt", "funcao": "Frontend Developer"},
            {"nome": "Pedro Santos", "email": "pedro.santos@empresa.pt", "funcao": "QA Automation Lead"},
        ],
        "tarefas": [
            {
                "descricao": "Otimizar fila de processamento e timeouts do webhook Stripe",
                "responsavel": "Carlos Mendes",
                "email_responsavel": "carlos.mendes@empresa.pt",
                "prazo": "2026-11-19",
                "prioridade": "Urgente",
                "notas": "Coordenar apoio com o Diogo durante a tarde.",
            },
            {
                "descricao": "Publicar contratos definitivos da API de checkout em Staging",
                "responsavel": "Carlos Mendes",
                "email_responsavel": "carlos.mendes@empresa.pt",
                "prazo": "2026-11-20",
                "prioridade": "Alta",
            },
            {
                "descricao": "Ligar fluxos finais de pagamento no frontend e atualizar Swagger",
                "responsavel": "Mariana Silva",
                "email_responsavel": "mariana.silva@empresa.pt",
                "prazo": "2026-11-21",
                "prioridade": "Média",
            },
            {
                "descricao": "Executar bateria completa de testes E2E e regressão",
                "responsavel": "Pedro Santos",
                "email_responsavel": "pedro.santos@empresa.pt",
                "prazo": "2026-11-23",
                "prioridade": "Alta",
            },
            {
                "descricao": "Definir estratégia de rollback pós-lançamento",
                "responsavel": "A definir",
                "email_responsavel": "",
                "prazo": "A definir",
                "prioridade": "Média",
            },
        ],
    }

    print("\n>>> TESTE 2: Envio com aprovado_gerente=True em modo_teste=True")
    resumo = enviar_notificacoes_aprovadas(reuniao_aprovada, modo_teste=True)
    print(f"\nResumo final da execução: {resumo['total_notificados']} funcionário(s) notificado(s).")