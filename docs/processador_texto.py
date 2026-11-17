#!/usr/bin/env python3
"""
SmartMeeting - Processador de Transcrições em Texto (processador_texto.py)

Analisa transcrições de reuniões em texto (.txt, .md ou string direta) utilizando
o cliente oficial google-genai com o modelo gemini-4-hydrogen e devolve
uma estrutura normalizada pronta para revisão do gerente e envio de notificações.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, Optional

_PASTA_ATUAL = Path(__file__).resolve().parent
if str(_PASTA_ATUAL) not in sys.path:
    sys.path.insert(0, str(_PASTA_ATUAL))

from config_ia import (
    MODELO_ANALISE,
    construir_instrucao_extracao,
    executar_com_retry,
    extrair_json_seguro,
    gerar_tabela_markdown_tarefas,
    normalizar_dados_reuniao,
    obter_cliente_gemini,
)

# Transcrição de exemplo para testes locais em linha de comandos
TRANSCRICAO_EXEMPLO = """
[00:02] Ana (Tech Lead): Bom dia a todos. O objetivo da reunião de hoje é fechar os bloqueios para o lançamento da nova funcionalidade de pagamentos e rever prazos.
[00:18] Carlos (Backend): Pelo lado do backend, a integração com o Stripe está a 85%. No entanto, estamos a ter timeouts nas chamadas ao webhook quando o volume de transações sobe. O prazo inicial de entrega era esta sexta-feira, mas sem resolver isto corremos risco de falhas em produção.
[00:45] Mariana (Frontend): No frontend, as telas do checkout e tratamento de erros estão concluídas. Só precisamos que o Carlos estabilize os contratos da API até quinta ao final do dia para podermos ligar os fluxos finais e testar.
[01:10] Pedro (QA): Se recebermos o ambiente pronto até sexta-feira de manhã, conseguimos executar os testes de regressão durante o fim de semana e segunda-feira. Se atrasar além disso, o release terá de ser adiado para o sprint seguinte.
[01:30] Ana (Tech Lead): Entendido. Carlos, podes colocar o Diogo a ajudar-te a otimizar as queries da base de dados e a fila de processamento do webhook hoje à tarde. A prioridade máxima passa a ser este bloqueio.
[01:48] Carlos (Backend): Perfeito, alinho com o Diogo logo a seguir ao almoço. Garanto os endpoints corrigidos até quinta-feira às 18h.
[02:05] Mariana (Frontend): Combinado. Assim que o Carlos subir para o ambiente de staging, eu e o Pedro fazemos um sanity check juntos.
[02:18] Ana (Tech Lead): Excelente. Ficou também pendente a questão da documentação da API para o cliente corporativo. Mariana, podes assumir a atualização do Swagger?
[02:30] Mariana (Frontend): Sim, trato disso na sexta-feira de manhã enquanto o QA inicia os testes.
[02:40] Ana (Tech Lead): Ótimo. Ficamos então assim alinhados. Obrigado a todos.
""".strip()


def process_meeting_text(
    transcricao: str,
    titulo_reuniao: Optional[str] = None,
    nome_ficheiro: str = "transcricao.txt",
) -> Dict[str, Any]:
    """
    Processa uma transcrição textual e devolve o dicionário normalizado da reunião,
    incluindo resumo executivo, decisões, tarefas reais e tabela Markdown padronizada.
    """
    texto_limpo = (transcricao or "").strip()
    if not texto_limpo:
        raise ValueError("A transcrição fornecida está vazia. Insira texto válido para análise.")

    from google.genai import types

    client = obter_cliente_gemini()
    instrucao = construir_instrucao_extracao()
    prompt = (
        f"{instrucao}\n\n"
        f"--- INÍCIO DA TRANSCRIÇÃO ---\n{texto_limpo}\n--- FIM DA TRANSCRIÇÃO ---"
    )

    print(f"-> A analisar transcrição com {MODELO_ANALISE}...")
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

    texto_resposta = getattr(resposta, "text", None) or ""
    dados_brutos = extrair_json_seguro(texto_resposta)
    if titulo_reuniao and not dados_brutos.get("titulo_reuniao"):
        dados_brutos["titulo_reuniao"] = titulo_reuniao

    dados = normalizar_dados_reuniao(
        dados_brutos,
        nome_ficheiro=nome_ficheiro,
        transcricao_literal=texto_limpo,
    )
    if titulo_reuniao:
        dados["titulo_reuniao"] = titulo_reuniao
    return dados


def formatar_relatorio_texto(dados: Dict[str, Any]) -> str:
    """Formata o resultado estruturado num relatório legível com a tabela Markdown oficial."""
    linhas = [
        f"# {dados.get('titulo_reuniao', 'Reunião SmartMeeting')} ({dados.get('data', '')})",
        "",
        "## 1. VISÃO GERAL",
        dados.get("resumo_executivo") or "Sem resumo executivo disponível.",
        "",
        "## 2. DECISÕES-CHAVE",
    ]
    decisoes = dados.get("decisoes_chave") or []
    linhas.extend([f"- {d}" for d in decisoes] if decisoes else ["- Nenhuma decisão registada."])

    bloqueios = dados.get("bloqueios_e_riscos") or []
    if bloqueios:
        linhas.extend(["", "## 3. BLOQUEIOS E RISCOS"])
        linhas.extend([f"- {b}" for b in bloqueios])

    linhas.extend([
        "",
        "## 4. MAPA DE AÇÕES E ENTREGÁVEIS (DISTRIBUIÇÃO DE TAREFAS)",
        dados.get("tabela_markdown") or gerar_tabela_markdown_tarefas(dados.get("tarefas", [])),
    ])
    return "\n".join(linhas)


# Alias de compatibilidade com chamadas anteriores
extrair_topicos_e_resumo = process_meeting_text


if __name__ == "__main__":
    if len(sys.argv) > 1:
        caminho = Path(sys.argv[1])
        if not caminho.is_file():
            raise FileNotFoundError(f"Ficheiro de texto não encontrado: {caminho}")
        conteudo = caminho.read_text(encoding="utf-8")
        nome = caminho.name
    else:
        conteudo = TRANSCRICAO_EXEMPLO
        nome = "transcricao_exemplo.txt"

    print(f"A processar a transcrição ({nome})...\n")
    resultado = process_meeting_text(conteudo, nome_ficheiro=nome)

    print("=" * 72)
    print("        SMARTMEETING · RELATÓRIO EXECUTIVO DA REUNIÃO")
    print("=" * 72)
    print(formatar_relatorio_texto(resultado))
    print("=" * 72)