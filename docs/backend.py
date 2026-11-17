#!/usr/bin/env python3
"""
SmartMeeting - Orquestrador Principal (backend.py)

Fluxo completo:
1. Deteta o tipo de ficheiro (Texto ou Multimédia)
2. Executa processador_texto.py ou processador_media.py
3. Normaliza o resultado para JSON estruturado (participantes, tarefas e tabela Markdown)
4. Abre a revisão interativa do gerente no terminal (Issue 9) com suporte a APROVAR, ADICIONAR, EDITAR, REMOVER, REJEITAR e CANCELAR
5. Dispara notificações consolidadas via notificador.py após aprovação (Issue 10)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

_PASTA_ATUAL = Path(__file__).resolve().parent
if str(_PASTA_ATUAL) not in sys.path:
    sys.path.insert(0, str(_PASTA_ATUAL))

from config_ia import (
    MODELO_ANALISE,
    construir_instrucao_extracao,
    executar_com_retry,
    extrair_json_seguro,
    gerar_email_corporativo_provisorio,
    gerar_tabela_markdown_tarefas,
    normalizar_dados_reuniao,
    normalizar_prioridade,
    obter_cliente_gemini,
)
from notificador import enviar_notificacoes_aprovadas
from processador_media import process_meeting_media

try:
    from processador_texto import process_meeting_text
except ImportError:
    from processador_texto import extrair_topicos_e_resumo as process_meeting_text

EXTENSOES_TEXTO = {".txt", ".md"}
EXTENSOES_MEDIA = {
    ".mp3",
    ".wav",
    ".m4a",
    ".ogg",
    ".opus",
    ".webm",
    ".flac",
    ".aac",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".mov",
    ".mkv",
}


def estruturar_dados_para_aprovacao(
    resultado_bruto: Any,
    nome_ficheiro: str,
) -> Dict[str, Any]:
    """
    Garante que a saída do processador (dict normalizado, dict parcial ou texto/Markdown)
    fica no formato oficial exigido pelo fluxo de aprovação e pelo notificador.py.
    """
    if isinstance(resultado_bruto, dict) and "tarefas" in resultado_bruto:
        return normalizar_dados_reuniao(
            resultado_bruto,
            nome_ficheiro=nome_ficheiro,
            transcricao_literal=resultado_bruto.get("transcricao_literal"),
        )

    texto_analise = str(resultado_bruto or "").strip()
    if not texto_analise:
        raise ValueError("Não há conteúdo válido para estruturar tarefas da reunião.")

    from google.genai import types

    client = obter_cliente_gemini()
    instrucao = construir_instrucao_extracao()
    prompt_estruturacao = (
        f"{instrucao}\n\n"
        f"Conteúdo da reunião ({nome_ficheiro}):\n---\n{texto_analise}\n---"
    )

    response = executar_com_retry(
        lambda: client.models.generate_content(
            model=MODELO_ANALISE,
            contents=prompt_estruturacao,
            config=types.GenerateContentConfig(
                temperature=0.1,
                response_mime_type="application/json",
            ),
        )
    )

    dados_brutos = extrair_json_seguro(getattr(response, "text", None) or "")
    return normalizar_dados_reuniao(dados_brutos, nome_ficheiro=nome_ficheiro)


def _atualizar_tabela_markdown(dados: Dict[str, Any]) -> None:
    dados["tabela_markdown"] = gerar_tabela_markdown_tarefas(dados.get("tarefas", []))


def _imprimir_mapa_tarefas(dados: Dict[str, Any]) -> None:
    """Mostra o mapa de tarefas no terminal (Issue 9) com as colunas padronizadas."""
    tarefas: List[Dict[str, Any]] = dados.get("tarefas", [])
    print("\n" + "=" * 105)
    print(f" REVISÃO DO GERENTE · {dados.get('titulo_reuniao', 'Reunião')} ({dados.get('data', '')})")
    print("=" * 105)
    print("| ID | Tarefa / Entregável | Responsável | Prazo / Data Limite | Prioridade | Estado |")
    print("| --- | --- | --- | --- | --- | --- |")

    if not tarefas:
        print("| - | Sem tarefas extraídas (use ADICIONAR se desejar criar manualmente) | A definir | A definir | Média | - |")
    else:
        for idx, t in enumerate(tarefas, start=1):
            print(
                f"| {idx} | {t.get('descricao', '')} | "
                f"{t.get('responsavel', 'A definir')} | "
                f"{t.get('prazo', 'A definir')} | "
                f"{t.get('prioridade', 'Média')} | "
                f"{t.get('estado', 'pendente')} |"
            )
    print("=" * 105)


def revisao_interativa_gerente(dados: Dict[str, Any]) -> Dict[str, Any]:
    """
    Painel interativo no terminal (Issue 9):
    Permite ao gerente adicionar, editar, remover ou rejeitar tarefas antes de escrever 'APROVAR'.
    """
    while True:
        _imprimir_mapa_tarefas(dados)
        print("\nOpções do Gerente:")
        print("  • Escreva 'APROVAR' para validar as tarefas ativas e enviar notificações.")
        print("  • Escreva 'ADICIONAR' para inserir manualmente uma nova tarefa.")
        print("  • Escreva 'EDITAR <ID>' (ex: EDITAR 1) para alterar tarefa, responsável ou prazo.")
        print("  • Escreva 'REJEITAR <ID>' (ex: REJEITAR 2) para manter no histórico como rejeitada (não notifica).")
        print("  • Escreva 'REMOVER <ID>' (ex: REMOVER 2) para eliminar uma tarefa da lista.")
        print("  • Escreva 'CANCELAR' para guardar sem aprovar (bloqueia o envio).")

        comando = input("\nAção > ").strip()
        cmd_upper = comando.upper()

        if cmd_upper == "APROVAR":
            for t in dados.get("tarefas", []):
                if str(t.get("estado", "")).lower() != "rejeitada":
                    t["estado"] = "aprovada"
            dados["aprovado_gerente"] = True
            _atualizar_tabela_markdown(dados)
            print("\n[OK] Mapa de tarefas APROVADO pelo gerente.")
            return dados

        if cmd_upper == "CANCELAR":
            dados["aprovado_gerente"] = False
            _atualizar_tabela_markdown(dados)
            print("\n[INFO] Revisão encerrada sem aprovação.")
            return dados

        if cmd_upper == "ADICIONAR":
            print("\nNova Tarefa (prima Enter nos campos opcionais para marcar 'A definir'):")
            desc = input("  Tarefa / Entregável: ").strip()
            if not desc:
                print("[AVISO] A descrição da tarefa é obrigatória.")
                continue
            resp = input("  Responsável [A definir]: ").strip() or "A definir"
            email_padrao = gerar_email_corporativo_provisorio(resp) if resp != "A definir" else ""
            email = input(f"  E-mail [{email_padrao}]: ").strip() or email_padrao
            prazo = input("  Prazo / Data Limite [A definir]: ").strip() or "A definir"
            prio = normalizar_prioridade(input("  Prioridade (Baixa/Média/Alta/Urgente) [Média]: ").strip())

            dados.setdefault("tarefas", []).append({
                "descricao": desc,
                "responsavel": resp,
                "email_responsavel": email,
                "prazo": prazo,
                "prioridade": prio,
                "estado": "editada",
            })
            _atualizar_tabela_markdown(dados)
            print(f"-> Tarefa adicionada: {desc}")
            continue

        if cmd_upper.startswith("REMOVER "):
            try:
                idx = int(comando.split()[1]) - 1
                removida = dados["tarefas"].pop(idx)
                _atualizar_tabela_markdown(dados)
                print(f"-> Tarefa removida: {removida.get('descricao')}")
            except (IndexError, ValueError):
                print("[AVISO] ID inválido. Exemplo: REMOVER 1")
            continue

        if cmd_upper.startswith("REJEITAR "):
            try:
                idx = int(comando.split()[1]) - 1
                tarefa = dados["tarefas"][idx]
                tarefa["estado"] = "rejeitada"
                _atualizar_tabela_markdown(dados)
                print(f"-> Tarefa marcada como rejeitada: {tarefa.get('descricao')}")
            except (IndexError, ValueError):
                print("[AVISO] ID inválido. Exemplo: REJEITAR 1")
            continue

        if cmd_upper.startswith("EDITAR "):
            try:
                idx = int(comando.split()[1]) - 1
                tarefa = dados["tarefas"][idx]
                print(f"\nA editar Tarefa {idx + 1} (prima Enter para manter o valor atual):")

                nova_desc = input(f"  Descrição [{tarefa.get('descricao')}]: ").strip()
                novo_resp = input(f"  Responsável [{tarefa.get('responsavel')}]: ").strip()
                email_sugerido = (
                    gerar_email_corporativo_provisorio(novo_resp)
                    if novo_resp and novo_resp != "A definir"
                    else tarefa.get("email_responsavel", "")
                )
                novo_email = input(f"  E-mail [{email_sugerido}]: ").strip()
                novo_prazo = input(f"  Prazo [{tarefa.get('prazo')}]: ").strip()
                nova_prio = input(f"  Prioridade [{tarefa.get('prioridade')}]: ").strip()

                if nova_desc:
                    tarefa["descricao"] = nova_desc
                if novo_resp:
                    tarefa["responsavel"] = novo_resp
                    if novo_resp != "A definir" and not novo_email and not tarefa.get("email_responsavel"):
                        tarefa["email_responsavel"] = email_sugerido
                if novo_email:
                    tarefa["email_responsavel"] = novo_email
                if novo_prazo:
                    tarefa["prazo"] = novo_prazo
                if nova_prio:
                    tarefa["prioridade"] = normalizar_prioridade(nova_prio)
                tarefa["estado"] = "editada"
                _atualizar_tabela_markdown(dados)
            except (IndexError, ValueError):
                print("[AVISO] ID inválido. Exemplo: EDITAR 1")
            continue

        print("[AVISO] Comando não reconhecido. Use APROVAR, ADICIONAR, EDITAR <ID>, REJEITAR <ID>, REMOVER <ID> ou CANCELAR.")


def exportar_resultados(
    dados_reuniao: Dict[str, Any],
    caminho_md: Optional[str] = None,
    caminho_json: Optional[str] = None,
) -> None:
    """Exporta o relatório Markdown (com a tabela oficial) e/ou o JSON estruturado para disco."""
    if caminho_md:
        tabela = dados_reuniao.get("tabela_markdown") or gerar_tabela_markdown_tarefas(dados_reuniao.get("tarefas", []))
        conteudo_md = "\n".join([
            f"# {dados_reuniao.get('titulo_reuniao', 'Reunião SmartMeeting')} ({dados_reuniao.get('data', '')})",
            "",
            "## Resumo Executivo",
            dados_reuniao.get("resumo_executivo") or "Sem resumo executivo disponível.",
            "",
            "## Mapa de Tarefas",
            tabela,
            "",
        ])
        Path(caminho_md).write_text(conteudo_md, encoding="utf-8")
        print(f"-> Relatório Markdown guardado em: {caminho_md}")

    if caminho_json:
        Path(caminho_json).write_text(
            json.dumps(dados_reuniao, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"-> Estrutura JSON guardada em: {caminho_json}")


def run_smartmeeting(
    file_path: str,
    modo_teste: bool = True,
    titulo_reuniao: Optional[str] = None,
    guardar_md: Optional[str] = None,
    guardar_json: Optional[str] = None,
) -> Dict[str, Any]:
    """Executa todo o pipeline do SmartMeeting para um ficheiro de texto ou multimédia."""
    path = Path(file_path)
    if not path.is_file():
        raise FileNotFoundError(f"Ficheiro não encontrado em: {file_path}")

    extensao = path.suffix.lower()

    if extensao in EXTENSOES_TEXTO:
        print("-> Modo Texto detetado. A encaminhar para processador_texto...")
        conteudo = path.read_text(encoding="utf-8")
        resultado_bruto = process_meeting_text(
            conteudo,
            titulo_reuniao=titulo_reuniao,
            nome_ficheiro=path.name,
        )
    elif extensao in EXTENSOES_MEDIA:
        print("-> Modo Multimédia detetado. A encaminhar para processador_media...")
        resultado_bruto = process_meeting_media(
            str(path),
            titulo_reuniao=titulo_reuniao,
        )
    else:
        raise ValueError(
            f"Formato '{extensao}' não suportado. "
            f"Use texto ({', '.join(sorted(EXTENSOES_TEXTO))}) ou multimédia ({', '.join(sorted(EXTENSOES_MEDIA))})."
        )

    print("\n-> A estruturar participantes e mapa de tarefas para revisão...")
    dados_reuniao = estruturar_dados_para_aprovacao(resultado_bruto, path.name)

    dados_validados = revisao_interativa_gerente(dados_reuniao)
    exportar_resultados(dados_validados, caminho_md=guardar_md, caminho_json=guardar_json)

    print("\n-> A acionar módulo notificador...")
    resultado_envio = enviar_notificacoes_aprovadas(
        dados_reuniao=dados_validados,
        modo_teste=modo_teste,
    )

    return {
        "dados_reuniao": dados_validados,
        "notificacoes": resultado_envio,
    }


def _construir_parser_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="SmartMeeting - Transcrição, extração de tarefas e notificações pós-aprovação."
    )
    parser.add_argument("ficheiro", help="Caminho para o ficheiro de áudio, vídeo ou transcrição (.txt/.md).")
    parser.add_argument("--titulo", help="Título personalizado para a reunião.", default=None)
    parser.add_argument("--enviar-real", action="store_true", help="Envia e-mails reais via SMTP (desativa simulação).")
    parser.add_argument("--guardar-md", help="Caminho opcional para exportar relatório Markdown.", default=None)
    parser.add_argument("--guardar-json", help="Caminho opcional para exportar JSON estruturado.", default=None)
    return parser


if __name__ == "__main__":
    parser = _construir_parser_cli()
    args = parser.parse_args()

    print(f"SmartMeeting AI Engine iniciado. Ficheiro: {args.ficheiro}")
    print(
        "Modo de notificação: "
        f"{'ENVIO REAL SMTP' if args.enviar_real else 'SIMULAÇÃO NO TERMINAL (modo_teste=True)'}"
    )

    run_smartmeeting(
        file_path=args.ficheiro,
        modo_teste=not args.enviar_real,
        titulo_reuniao=args.titulo,
        guardar_md=args.guardar_md,
        guardar_json=args.guardar_json,
    )