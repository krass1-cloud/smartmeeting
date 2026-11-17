#!/usr/bin/env python3
"""
SmartMeeting - Processador Multimédia (processador_media.py)

Transcreve ficheiros de áudio e vídeo (.mp3, .wav, .m4a, .ogg, .webm, .flac, .aac, .mp4, .mov, .mpeg)
e extrai tarefas reais, responsáveis, prazos e prioridades em estrutura normalizada.

Fluxo em duas etapas para áudio:
1. Transcrição dedicada com `gemini-3.5-transcribe` (com fallback multimodal automático para
   `gemini-4-hydrogen` se a transcrição vier vazia ou ocorrer erro transitório não relacionado
   a autenticação/quota).
2. Extração estruturada JSON e geração da tabela Markdown padronizada com `gemini-4-hydrogen`.
"""

from __future__ import annotations

import mimetypes
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

_PASTA_ATUAL = Path(__file__).resolve().parent
if str(_PASTA_ATUAL) not in sys.path:
    sys.path.insert(0, str(_PASTA_ATUAL))

from config_ia import (
    MODELO_ANALISE,
    MODELO_TRANSCRICAO,
    construir_instrucao_extracao,
    erro_autenticacao_ou_quota,
    executar_com_retry,
    extrair_json_seguro,
    gerar_tabela_markdown_tarefas,
    normalizar_dados_reuniao,
    obter_cliente_gemini,
)

MAX_INLINE_BYTES = 18 * 1024 * 1024  # 18 MB

MIME_POR_EXTENSAO: Dict[str, str] = {
    ".mp3": "audio/mp3",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".webm": "audio/webm",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
}

PROMPT_TRANSCRICAO_AUDIO = (
    "Transcreve integralmente em Português (ou no idioma originalmente falado) todo o conteúdo "
    "deste áudio de reunião. Identifica os intervenientes (ex: [00:12] Ana: ... ou [00:12] Orador 1: ...), "
    "mantém marcas temporais aproximadas [MM:SS] e preserva todos os nomes, prazos, decisões e tarefas "
    "mencionados sem resumir nem inventar texto."
)


def detectar_mime_type(caminho: Path) -> str:
    """Determina o MIME type oficial para ficheiros de áudio e vídeo suportados."""
    ext = caminho.suffix.lower()
    if ext in MIME_POR_EXTENSAO:
        return MIME_POR_EXTENSAO[ext]

    mime_adivinhado, _ = mimetypes.guess_type(str(caminho))
    if mime_adivinhado and (mime_adivinhado.startswith("audio/") or mime_adivinhado.startswith("video/")):
        return mime_adivinhado

    suportadas = ", ".join(sorted(MIME_POR_EXTENSAO.keys()))
    raise ValueError(
        f"Extensão multimédia não suportada: '{ext or '(sem extensão)'}'. "
        f"Formatos suportados: {suportadas}"
    )


def _obter_nome_estado(file_ref: Any) -> str:
    estado = getattr(file_ref, "state", None)
    if hasattr(estado, "name"):
        return str(estado.name).upper()
    return str(estado or "").upper()


def wait_for_file_processing(client: Any, file_ref: Any, timeout_s: int = 300) -> Any:
    """
    Aguarda o processamento do ficheiro pela Gemini Files API até atingir o estado ACTIVE.
    """
    nome_exibicao = getattr(file_ref, "display_name", None) or getattr(file_ref, "name", "ficheiro")
    print(f"-> A aguardar processamento do ficheiro '{nome_exibicao}'...")
    inicio = time.monotonic()

    while _obter_nome_estado(file_ref) == "PROCESSING":
        if time.monotonic() - inicio > timeout_s:
            raise TimeoutError(f"Tempo limite excedido ao processar '{nome_exibicao}' na Files API.")
        time.sleep(3)
        file_ref = client.files.get(name=file_ref.name)

    estado_final = _obter_nome_estado(file_ref)
    if estado_final and estado_final != "ACTIVE":
        raise RuntimeError(
            f"Falha no processamento do ficheiro: {estado_final} - "
            f"{getattr(file_ref, 'error', 'Erro desconhecido')}"
        )

    print("-> Ficheiro pronto e ativo para análise.")
    return file_ref


def _transcrever_audio_dedicado(client: Any, part_audio: Any) -> str:
    """Etapa 1: Transcrição literal de áudio com o modelo dedicado gemini-3.5-transcribe."""
    from google.genai import types

    resposta = executar_com_retry(
        lambda: client.models.generate_content(
            model=MODELO_TRANSCRICAO,
            contents=[part_audio, PROMPT_TRANSCRICAO_AUDIO],
            config=types.GenerateContentConfig(temperature=0.0),
        )
    )
    return (getattr(resposta, "text", None) or "").strip()


def _extrair_de_transcricao(client: Any, transcricao_literal: str) -> Dict[str, Any]:
    """Etapa 2: Extrai JSON estruturado da transcrição usando gemini-4-hydrogen."""
    from google.genai import types

    instrucao = construir_instrucao_extracao()
    prompt = (
        f"{instrucao}\n\n"
        f"--- TRANSCRIÇÃO LITERAL DO ÁUDIO ---\n{transcricao_literal}\n--- FIM DA TRANSCRIÇÃO ---"
    )
    resposta = executar_com_retry(
        lambda: client.models.generate_content(
            model=MODELO_ANALISE,
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.1,
                response_mime_type="application/json",
            ),
        )
    )
    return extrair_json_seguro(getattr(resposta, "text", None) or "")


def _extrair_multimodal_direto(client: Any, media_ref: Any) -> Dict[str, Any]:
    """Fallback ou fluxo de vídeo/ficheiros grandes: extração multimodal direta com gemini-4-hydrogen."""
    from google.genai import types

    instrucao = construir_instrucao_extracao()
    prompt = (
        f"{instrucao}\n\n"
        "O áudio/vídeo desta reunião segue em anexo. Transcreve o conteúdo falado na secção 'transcricao' "
        "e extrai apenas as tarefas, responsáveis, prazos e decisões realmente mencionados."
    )
    resposta = executar_com_retry(
        lambda: client.models.generate_content(
            model=MODELO_ANALISE,
            contents=[media_ref, prompt],
            config=types.GenerateContentConfig(
                temperature=0.1,
                response_mime_type="application/json",
            ),
        )
    )
    return extrair_json_seguro(getattr(resposta, "text", None) or "")


def process_meeting_media(
    file_path: str,
    titulo_reuniao: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Transcreve o ficheiro de áudio/vídeo e devolve um dicionário normalizado com
    participantes, transcrição, tarefas extraídas e tabela Markdown padronizada.
    """
    path = Path(file_path)
    if not path.is_file():
        raise FileNotFoundError(f"Ficheiro multimédia não encontrado em: {file_path}")

    tamanho = path.stat().st_size
    if tamanho == 0:
        raise ValueError(f"O ficheiro multimédia '{path.name}' está vazio (0 bytes).")

    mime_type = detectar_mime_type(path)
    eh_audio = mime_type.startswith("audio/")
    client = obter_cliente_gemini()

    from google.genai import types

    transcricao_literal: Optional[str] = None
    dados_brutos: Dict[str, Any]

    if eh_audio and tamanho <= MAX_INLINE_BYTES:
        print(f"\n[1/3] A preparar áudio inline ({path.name}, {mime_type}, {tamanho / 1024:.1f} KB)...")
        media_bytes = path.read_bytes()
        part_audio = types.Part.from_bytes(data=media_bytes, mime_type=mime_type)

        print(f"[2/3] A transcrever áudio com {MODELO_TRANSCRICAO}...")
        try:
            transcricao_literal = _transcrever_audio_dedicado(client, part_audio)
        except Exception as exc:
            if erro_autenticacao_ou_quota(exc):
                raise
            print(f"[AVISO] Transcrição dedicada indisponível ({exc}). A usar análise multimodal direta...")
            transcricao_literal = ""

        if transcricao_literal:
            print(f"[3/3] A extrair tarefas e decisões com {MODELO_ANALISE}...")
            dados_brutos = _extrair_de_transcricao(client, transcricao_literal)
        else:
            print(f"[3/3] A executar análise multimodal direta com {MODELO_ANALISE}...")
            dados_brutos = _extrair_multimodal_direto(client, part_audio)
    else:
        print(f"\n[1/3] A carregar ficheiro para a Google Files API: {path.name} ({mime_type})...")
        uploaded_file = client.files.upload(file=str(path), config={"mime_type": mime_type})
        print(f"-> Ficheiro carregado com URI: {getattr(uploaded_file, 'uri', uploaded_file.name)}")
        uploaded_file = wait_for_file_processing(client, uploaded_file)

        try:
            print(f"[2/3] A processar multimédia com {MODELO_ANALISE}...")
            dados_brutos = _extrair_multimodal_direto(client, uploaded_file)
            print("[3/3] Análise multimodal concluída.")
        finally:
            try:
                print("-> A limpar ficheiro temporário dos servidores do Gemini...")
                client.files.delete(name=uploaded_file.name)
                print("-> Limpeza concluída.")
            except Exception as exc:
                print(f"[AVISO] Não foi possível eliminar o ficheiro remoto: {exc}")

    if titulo_reuniao and not dados_brutos.get("titulo_reuniao"):
        dados_brutos["titulo_reuniao"] = titulo_reuniao

    dados = normalizar_dados_reuniao(
        dados_brutos,
        nome_ficheiro=path.name,
        transcricao_literal=transcricao_literal,
    )
    if titulo_reuniao:
        dados["titulo_reuniao"] = titulo_reuniao
    return dados


def formatar_relatorio_media(dados: Dict[str, Any]) -> str:
    """Formata a saída estruturada do áudio/vídeo para exibição no terminal ou exportação Markdown."""
    linhas = [
        f"# {dados.get('titulo_reuniao', 'Reunião SmartMeeting')} ({dados.get('data', '')})",
        "",
        "## 1. PARTICIPANTES IDENTIFICADOS",
    ]
    participantes = dados.get("participantes") or []
    if participantes:
        for p in participantes:
            linhas.append(f"- {p.get('nome')} ({p.get('funcao', 'Membro da Equipa')})")
    else:
        linhas.append("- A definir")

    linhas.extend([
        "",
        "## 2. TÓPICOS PRINCIPAIS & DECISÕES",
        dados.get("resumo_executivo") or "Sem resumo executivo disponível.",
    ])
    for d in dados.get("decisoes_chave") or []:
        linhas.append(f"- {d}")

    linhas.extend([
        "",
        "## 3. MAPA DE DISTRIBUIÇÃO DE TAREFAS (AÇÕES)",
        dados.get("tabela_markdown") or gerar_tabela_markdown_tarefas(dados.get("tarefas", [])),
        "",
        "## 4. TRANSCRIÇÃO DETALHADA",
    ])

    segmentos = dados.get("transcricao") or []
    if segmentos:
        for seg in segmentos:
            linhas.append(f"[{seg.get('tempo', '00:00')}] {seg.get('orador', 'Orador')}: {seg.get('texto', '')}")
    elif dados.get("transcricao_literal"):
        linhas.append(str(dados["transcricao_literal"]))
    else:
        linhas.append("Sem transcrição disponível.")

    return "\n".join(linhas)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        target_file = sys.argv[1]
    else:
        som_padrao = _PASTA_ATUAL / "som.mp3"
        target_file = str(som_padrao) if som_padrao.is_file() else "reuniao_exemplo.mp3"

    print(f"SmartMeeting Media Engine iniciado. Ficheiro: {target_file}")
    resultado = process_meeting_media(target_file)
    print("\n================= RELATÓRIO SMARTMEETING =================")
    print(formatar_relatorio_media(resultado))
    print("==========================================================\n")