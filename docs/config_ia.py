#!/usr/bin/env python3
"""
SmartMeeting - Configuração Partilhada de IA e Normalização (config_ia.py)

Centraliza:
- Carregamento de variáveis de ambiente (.env local ou na raiz do projeto)
- Inicialização do cliente oficial google-genai
- Modelos válidos para transcrição de áudio e análise/extração de tarefas
- Regras de governança (sem tarefas fictícias, colunas Markdown exatas, fallback "A definir")
"""

from __future__ import annotations

import json
import os
import re
import time
import unicodedata
from datetime import date
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, TypeVar

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - fallback caso python-dotenv não esteja instalado
    def load_dotenv(*_args: Any, **_kwargs: Any) -> bool:
        return False


MODELO_TRANSCRICAO = "gemini-3.5-transcribe"
MODELO_ANALISE = "gemini-4-hydrogen"

PRIORIDADES_VALIDAS = {
    "baixa": "Baixa",
    "low": "Baixa",
    "media": "Média",
    "média": "Média",
    "medium": "Média",
    "alta": "Alta",
    "high": "Alta",
    "urgente": "Urgente",
    "urgent": "Urgente",
    "critica": "Urgente",
    "crítica": "Urgente",
}

T = TypeVar("T")


def carregar_variaveis_ambiente() -> None:
    """Carrega .env da pasta docs/ e da raiz do repositório, se existirem."""
    pasta_atual = Path(__file__).resolve().parent
    raiz_projeto = pasta_atual.parent
    load_dotenv(pasta_atual / ".env")
    load_dotenv(raiz_projeto / ".env")
    load_dotenv()


def obter_api_key() -> str:
    """Obtém a GEMINI_API_KEY após carregar os ficheiros .env."""
    carregar_variaveis_ambiente()
    api_key = (os.getenv("GEMINI_API_KEY") or "").strip()
    if not api_key:
        raise ValueError(
            "A variável GEMINI_API_KEY não foi encontrada. "
            "Configure GEMINI_API_KEY='a_sua_chave' no ficheiro .env ou nas variáveis de ambiente."
        )
    return api_key


def obter_cliente_gemini() -> Any:
    """Inicializa e devolve o cliente oficial google.genai.Client."""
    api_key = obter_api_key()
    try:
        from google import genai
    except ImportError as exc:
        raise ImportError(
            "O pacote 'google-genai' não está instalado. Execute: pip install google-genai python-dotenv"
        ) from exc

    return genai.Client(api_key=api_key)


def _erro_transitorio(erro: Exception) -> bool:
    msg = str(erro).lower()
    return (
        "503" in msg
        or "429" in msg
        or "unavailable" in msg
        or "resource_exhausted" in msg
        or "high demand" in msg
        or "temporarily" in msg
    )


def erro_autenticacao_ou_quota(erro: Exception) -> bool:
    msg = str(erro).lower()
    return (
        "401" in msg
        or "403" in msg
        or "api_key_invalid" in msg
        or "permission_denied" in msg
        or "429" in msg
        or "resource_exhausted" in msg
    )


def executar_com_retry(funcao: Callable[[], T], max_tentativas: int = 3, espera_base_s: float = 2.0) -> T:
    """Executa uma chamada à API com backoff exponencial em erros transitórios."""
    ultimo_erro: Optional[Exception] = None
    for tentativa in range(1, max_tentativas + 1):
        try:
            return funcao()
        except Exception as exc:
            ultimo_erro = exc
            if tentativa < max_tentativas and _erro_transitorio(exc):
                atraso = espera_base_s * tentativa
                print(f"[AVISO] Serviço ocupado. Nova tentativa em {atraso:.0f}s ({tentativa}/{max_tentativas})...")
                time.sleep(atraso)
                continue
            raise
    assert ultimo_erro is not None
    raise ultimo_erro


def construir_instrucao_extracao(data_referencia: Optional[str] = None) -> str:
    """Prompt de sistema oficial do SmartMeeting para extração dinâmica sem dados fictícios."""
    ref = data_referencia or date.today().isoformat()
    return f"""
És o motor de transcrição e governança de reuniões do "SmartMeeting", uma plataforma de gestão ágil de projetos de software.
A tua função é processar transcrições de voz ou ficheiros multimédia de reuniões e extrair com precisão as tarefas reais discutidas.

REGRAS ESTRITAS DE PROCESSAMENTO:
1. NÃO uses tarefas genéricas, fictícias ou pré-definidas. Toda a saída deve derivar exclusivamente do conteúdo real da transcrição ou do áudio fornecido.
2. Analisa o texto falado para identificar itens de ação, responsáveis, prazos/datas limite e prioridades.
3. Mantém um tom profissional, objetivo e orientado à engenharia ágil em Português.
4. Se alguma informação (como prazo ou responsável) estiver ausente no áudio ou na transcrição, infere apenas se estiver claramente implícita no contexto; caso contrário, marca explicitamente como "A definir".
5. Se não existirem tarefas discutidas na reunião, devolve uma lista de tarefas vazia ([]) em vez de inventar entregáveis.
6. Data de referência para prazos relativos (ex: "amanhã", "sexta-feira"): {ref}.

Responde APENAS com JSON válido seguindo exatamente esta estrutura:
{{
  "titulo_reuniao": "Título conciso baseado no assunto real da reunião",
  "data": "{ref}",
  "resumo_executivo": "Resumo objetivo do que foi discutido e acordado",
  "decisoes_chave": ["Decisão 1", "Decisão 2"],
  "bloqueios_e_riscos": ["Bloqueio ou risco identificado"],
  "proximos_passos": ["Próximo passo acordado"],
  "participantes": [
    {{
      "nome": "Nome do Participante",
      "email": "email@empresa.pt",
      "funcao": "Função identificada na reunião"
    }}
  ],
  "tarefas": [
    {{
      "descricao": "Descrição clara da tarefa ou entregável",
      "responsavel": "Nome do responsável ou A definir",
      "email_responsavel": "email@empresa.pt ou vazio se A definir",
      "prazo": "YYYY-MM-DD, prazo explícito ou A definir",
      "prioridade": "Baixa | Média | Alta | Urgente",
      "trecho_origem": "Citação curta da transcrição que originou a tarefa",
      "estado": "pendente"
    }}
  ],
  "transcricao": [
    {{
      "orador": "Nome ou Orador 1",
      "tempo": "MM:SS",
      "texto": "Fala transcrita"
    }}
  ]
}}
""".strip()


def normalizar_prioridade(valor: Any) -> str:
    chave = str(valor or "").strip().lower()
    return PRIORIDADES_VALIDAS.get(chave, "Média")


def gerar_email_corporativo_provisorio(nome: str, dominio: str = "empresa.pt") -> str:
    """Gera e-mail provisório apenas para participantes identificados pelo nome."""
    nome_limpo = (nome or "").strip()
    if not nome_limpo or nome_limpo.lower() in {"a definir", "por atribuir", "n/a", "-"}:
        return ""
    sem_acentos = "".join(
        ch for ch in unicodedata.normalize("NFD", nome_limpo) if unicodedata.category(ch) != "Mn"
    )
    slug = re.sub(r"[^a-z0-9]+", ".", sem_acentos.lower()).strip(".")
    return f"{slug}@{dominio}" if slug else ""


def extrair_json_seguro(texto: str) -> Dict[str, Any]:
    """Extrai e interpreta JSON mesmo quando envolvido em blocos Markdown ```json ... ```."""
    limpo = (texto or "").strip()
    if not limpo:
        raise ValueError("A resposta da IA veio vazia e não contém JSON.")

    if limpo.startswith("```"):
        limpo = re.sub(r"^```(?:json)?\s*", "", limpo, flags=re.IGNORECASE)
        limpo = re.sub(r"\s*```$", "", limpo)

    try:
        resultado = json.loads(limpo)
    except json.JSONDecodeError:
        inicio = limpo.find("{")
        fim = limpo.rfind("}")
        if inicio == -1 or fim == -1 or fim <= inicio:
            raise
        resultado = json.loads(limpo[inicio : fim + 1])

    if not isinstance(resultado, dict):
        raise ValueError("O JSON extraído não representa um objeto de reunião válido.")
    return resultado


def _sanitizar_celula_markdown(valor: Any) -> str:
    texto = str(valor or "").replace("|", "\\|")
    return re.sub(r"\s+", " ", texto).strip()


def gerar_tabela_markdown_tarefas(tarefas: List[Dict[str, Any]]) -> str:
    """
    Gera a tabela Markdown padronizada do SmartMeeting com as colunas exatas:
    | Tarefa / Entregável | Responsável | Prazo / Data Limite | Prioridade |
    """
    cabecalho = "| Tarefa / Entregável | Responsável | Prazo / Data Limite | Prioridade |"
    separador = "| --- | --- | --- | --- |"

    if not tarefas:
        return "\n".join([
            cabecalho,
            separador,
            "| Nenhuma tarefa identificada na transcrição | A definir | A definir | Média |",
        ])

    linhas = [cabecalho, separador]
    for tarefa in tarefas:
        desc = _sanitizar_celula_markdown(tarefa.get("descricao") or tarefa.get("titulo") or "A definir")
        resp = _sanitizar_celula_markdown(tarefa.get("responsavel") or "A definir")
        prazo = _sanitizar_celula_markdown(tarefa.get("prazo") or "A definir")
        prio = normalizar_prioridade(tarefa.get("prioridade"))
        linhas.append(f"| {desc} | {resp} | {prazo} | {prio} |")

    return "\n".join(linhas)


def normalizar_dados_reuniao(
    dados_brutos: Dict[str, Any],
    nome_ficheiro: str = "reuniao",
    transcricao_literal: Optional[str] = None,
) -> Dict[str, Any]:
    """Garante estrutura consistente para revisão do gerente e envio pelo notificador."""
    hoje = date.today().isoformat()
    titulo = str(dados_brutos.get("titulo_reuniao") or f"Reunião ({nome_ficheiro})").strip()
    data_reuniao = str(dados_brutos.get("data") or hoje).strip()

    participantes_norm: List[Dict[str, str]] = []
    emails_por_nome: Dict[str, str] = {}

    for p in dados_brutos.get("participantes") or []:
        if not isinstance(p, dict):
            continue
        nome = str(p.get("nome") or "").strip()
        if not nome:
            continue
        email = str(p.get("email") or "").strip() or gerar_email_corporativo_provisorio(nome)
        funcao = str(p.get("funcao") or "Membro da Equipa").strip()
        participantes_norm.append({"nome": nome, "email": email, "funcao": funcao})
        if email:
            emails_por_nome[nome.lower()] = email

    tarefas_norm: List[Dict[str, Any]] = []
    for t in dados_brutos.get("tarefas") or []:
        if not isinstance(t, dict):
            continue
        descricao = str(t.get("descricao") or t.get("titulo") or "").strip()
        if not descricao:
            continue

        responsavel = str(t.get("responsavel") or "").strip() or "A definir"
        if responsavel.lower() in {"por atribuir", "indefinido", "n/a", "none", "null"}:
            responsavel = "A definir"

        email_resp = str(t.get("email_responsavel") or "").strip()
        if not email_resp and responsavel != "A definir":
            email_resp = emails_por_nome.get(responsavel.lower()) or gerar_email_corporativo_provisorio(responsavel)

        prazo = str(t.get("prazo") or "").strip() or "A definir"
        if prazo.lower() in {"indefinido", "n/a", "none", "null", "sem prazo"}:
            prazo = "A definir"

        prioridade = normalizar_prioridade(t.get("prioridade"))
        estado = str(t.get("estado") or "pendente").strip().lower()
        if estado not in {"pendente", "aprovada", "editada", "rejeitada"}:
            estado = "pendente"

        item: Dict[str, Any] = {
            "descricao": descricao,
            "responsavel": responsavel,
            "email_responsavel": email_resp,
            "prazo": prazo,
            "prioridade": prioridade,
            "estado": estado,
        }
        if t.get("trecho_origem"):
            item["trecho_origem"] = str(t["trecho_origem"]).strip()
        if t.get("notas"):
            item["notas"] = str(t["notas"]).strip()

        tarefas_norm.append(item)

        if responsavel != "A definir" and responsavel.lower() not in emails_por_nome:
            emails_por_nome[responsavel.lower()] = email_resp
            participantes_norm.append({
                "nome": responsavel,
                "email": email_resp,
                "funcao": "Membro da Equipa",
            })

    transcricao_norm: List[Dict[str, str]] = []
    for seg in dados_brutos.get("transcricao") or []:
        if not isinstance(seg, dict):
            continue
        texto = str(seg.get("texto") or "").strip()
        if not texto:
            continue
        transcricao_norm.append({
            "orador": str(seg.get("orador") or "Orador").strip(),
            "tempo": str(seg.get("tempo") or "00:00").strip(),
            "texto": texto,
        })

    resultado: Dict[str, Any] = {
        "titulo_reuniao": titulo,
        "data": data_reuniao,
        "aprovado_gerente": False,  # Obriga sempre à aprovação do gerente (Issue 9)
        "resumo_executivo": str(dados_brutos.get("resumo_executivo") or "").strip(),
        "decisoes_chave": [str(x).strip() for x in (dados_brutos.get("decisoes_chave") or []) if str(x).strip()],
        "bloqueios_e_riscos": [str(x).strip() for x in (dados_brutos.get("bloqueios_e_riscos") or []) if str(x).strip()],
        "proximos_passos": [str(x).strip() for x in (dados_brutos.get("proximos_passos") or []) if str(x).strip()],
        "participantes": participantes_norm,
        "tarefas": tarefas_norm,
        "tabela_markdown": gerar_tabela_markdown_tarefas(tarefas_norm),
        "transcricao": transcricao_norm,
    }

    if transcricao_literal:
        resultado["transcricao_literal"] = transcricao_literal.strip()

    return resultado
