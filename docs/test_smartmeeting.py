#!/usr/bin/env python3
"""
SmartMeeting - Suite de Testes Unitários (test_smartmeeting.py)

Valida config_ia.py, processador_texto.py, processador_media.py,
notificador.py e backend.py sem depender de chamadas externas à rede.
"""

from __future__ import annotations

import json
import sys
import tempfile
import types as py_types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

_PASTA_ATUAL = Path(__file__).resolve().parent
if str(_PASTA_ATUAL) not in sys.path:
    sys.path.insert(0, str(_PASTA_ATUAL))

import backend
import config_ia
import notificador
import processador_media
import processador_texto


def _instalar_stub_google_genai():
    """Garante um stub mínimo de google.genai.types caso o SDK não esteja instalado no ambiente de teste."""
    google_mod = py_types.ModuleType("google")
    genai_mod = py_types.ModuleType("google.genai")
    types_mod = py_types.ModuleType("google.genai.types")

    class FakeGenerateContentConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class FakePart:
        @staticmethod
        def from_bytes(data: bytes, mime_type: str):
            return SimpleNamespace(data=data, mime_type=mime_type)

    types_mod.GenerateContentConfig = FakeGenerateContentConfig
    types_mod.Part = FakePart
    genai_mod.types = types_mod
    genai_mod.Client = MagicMock()
    google_mod.genai = genai_mod

    return patch.dict(
        sys.modules,
        {
            "google": google_mod,
            "google.genai": genai_mod,
            "google.genai.types": types_mod,
        },
    )


class TestConfigIA(unittest.TestCase):
    def test_modelos_oficiais(self):
        self.assertEqual(config_ia.MODELO_TRANSCRICAO, "gemini-3.5-transcribe")
        self.assertEqual(config_ia.MODELO_ANALISE, "gemini-4-hydrogen")

    def test_extrair_json_seguro_com_markdown(self):
        bruto = "Aqui está:\n```json\n{\"titulo_reuniao\": \"Daily\", \"tarefas\": []}\n```"
        resultado = config_ia.extrair_json_seguro(bruto)
        self.assertEqual(resultado["titulo_reuniao"], "Daily")
        self.assertEqual(resultado["tarefas"], [])

    def test_tabela_markdown_colunas_exatas(self):
        tabela = config_ia.gerar_tabela_markdown_tarefas([
            {
                "descricao": "Corrigir timeout | webhook",
                "responsavel": "Carlos",
                "prazo": "2026-11-20",
                "prioridade": "urgent",
            }
        ])
        linhas = tabela.splitlines()
        self.assertEqual(
            linhas[0],
            "| Tarefa / Entregável | Responsável | Prazo / Data Limite | Prioridade |",
        )
        self.assertIn("Corrigir timeout \\| webhook", linhas[2])
        self.assertIn("| Carlos | 2026-11-20 | Urgente |", linhas[2])

    def test_normalizar_dados_reuniao_a_definir_e_aprovacao_false(self):
        dados = config_ia.normalizar_dados_reuniao(
            {
                "titulo_reuniao": "Planeamento",
                "aprovado_gerente": True,
                "tarefas": [
                    {
                        "descricao": "Rever contrato da API",
                        "responsavel": "Por atribuir",
                        "prazo": "",
                        "prioridade": "high",
                    },
                    {
                        "descricao": "Criar testes E2E",
                        "responsavel": "João Silva",
                        "prazo": "Sexta-feira",
                        "prioridade": "Média",
                    },
                ],
            }
        )
        self.assertFalse(dados["aprovado_gerente"])
        self.assertEqual(dados["tarefas"][0]["responsavel"], "A definir")
        self.assertEqual(dados["tarefas"][0]["email_responsavel"], "")
        self.assertEqual(dados["tarefas"][0]["prazo"], "A definir")
        self.assertEqual(dados["tarefas"][0]["prioridade"], "Alta")
        self.assertEqual(dados["tarefas"][1]["email_responsavel"], "joao.silva@empresa.pt")


class TestProcessadorTexto(unittest.TestCase):
    def test_rejeita_transcricao_vazia(self):
        with self.assertRaises(ValueError):
            processador_texto.process_meeting_text("   ")

    def test_extrai_tarefas_com_gemini_4_hydrogen(self):
        resposta_json = json.dumps({
            "titulo_reuniao": "Alinhamento Backend",
            "resumo_executivo": "Definida correção do webhook Stripe.",
            "decisoes_chave": ["Priorizar estabilidade antes do release"],
            "participantes": [{"nome": "Carlos", "funcao": "Backend"}],
            "tarefas": [
                {
                    "descricao": "Otimizar fila do webhook",
                    "responsavel": "Carlos",
                    "prazo": "Quinta-feira 18h",
                    "prioridade": "Urgente",
                }
            ],
        })
        fake_client = MagicMock()
        fake_client.models.generate_content.return_value = SimpleNamespace(text=resposta_json)

        with _instalar_stub_google_genai(), patch.object(
            processador_texto, "obter_cliente_gemini", return_value=fake_client
        ):
            resultado = processador_texto.process_meeting_text(
                "Carlos vai otimizar a fila do webhook até quinta-feira às 18h."
            )

        chamada = fake_client.models.generate_content.call_args
        self.assertEqual(chamada.kwargs["model"], "gemini-4-hydrogen")
        self.assertFalse(resultado["aprovado_gerente"])
        self.assertEqual(len(resultado["tarefas"]), 1)
        self.assertEqual(resultado["tarefas"][0]["responsavel"], "Carlos")
        self.assertIn("| Tarefa / Entregável | Responsável | Prazo / Data Limite | Prioridade |", resultado["tabela_markdown"])


class TestProcessadorMedia(unittest.TestCase):
    def test_detectar_mime_types_suportados(self):
        self.assertEqual(processador_media.detectar_mime_type(Path("som.mp3")), "audio/mp3")
        self.assertEqual(processador_media.detectar_mime_type(Path("gravacao.webm")), "audio/webm")
        self.assertEqual(processador_media.detectar_mime_type(Path("reuniao.wav")), "audio/wav")
        self.assertEqual(processador_media.detectar_mime_type(Path("video.mp4")), "video/mp4")
        with self.assertRaises(ValueError):
            processador_media.detectar_mime_type(Path("malware.exe"))

    def test_fluxo_duas_etapas_audio_inline(self):
        som_path = _PASTA_ATUAL / "som.mp3"
        self.assertTrue(som_path.is_file(), "docs/som.mp3 deve existir para o teste")

        fake_client = MagicMock()
        fake_client.models.generate_content.side_effect = [
            SimpleNamespace(text="[00:05] Ana: Mariana, atualiza o Swagger até amanhã."),
            SimpleNamespace(
                text=json.dumps({
                    "titulo_reuniao": "Sync de Produto",
                    "resumo_executivo": "Atualização da documentação.",
                    "tarefas": [
                        {
                            "descricao": "Atualizar o Swagger",
                            "responsavel": "Mariana",
                            "prazo": "Amanhã",
                            "prioridade": "Alta",
                        }
                    ],
                    "transcricao": [{"orador": "Ana", "tempo": "00:05", "texto": "Mariana, atualiza o Swagger até amanhã."}],
                })
            ),
        ]

        with _instalar_stub_google_genai(), patch.object(
            processador_media, "obter_cliente_gemini", return_value=fake_client
        ):
            resultado = processador_media.process_meeting_media(str(som_path))

        self.assertEqual(fake_client.models.generate_content.call_count, 2)
        modelos = [c.kwargs["model"] for c in fake_client.models.generate_content.call_args_list]
        self.assertEqual(modelos, ["gemini-3.5-transcribe", "gemini-4-hydrogen"])
        self.assertEqual(resultado["tarefas"][0]["responsavel"], "Mariana")
        self.assertIn("Mariana, atualiza o Swagger", resultado["transcricao_literal"])

    def test_fallback_multimodal_quando_transcricao_vazia(self):
        with tempfile.NamedTemporaryFile(suffix=".webm") as tmp:
            tmp.write(b"\x1a\x45\xdf\xa3fake-webm-audio")
            tmp.flush()

            fake_client = MagicMock()
            fake_client.models.generate_content.side_effect = [
                SimpleNamespace(text="   "),
                SimpleNamespace(
                    text=json.dumps({
                        "titulo_reuniao": "Gravação Direta",
                        "tarefas": [
                            {"descricao": "Rever logs de produção", "responsavel": "", "prazo": "", "prioridade": "Média"}
                        ],
                    })
                ),
            ]

            with _instalar_stub_google_genai(), patch.object(
                processador_media, "obter_cliente_gemini", return_value=fake_client
            ):
                resultado = processador_media.process_meeting_media(tmp.name)

            self.assertEqual(fake_client.models.generate_content.call_count, 2)
            self.assertEqual(resultado["tarefas"][0]["responsavel"], "A definir")
            self.assertEqual(resultado["tarefas"][0]["prazo"], "A definir")

    def test_propaga_erro_autenticacao(self):
        som_path = _PASTA_ATUAL / "som.mp3"
        fake_client = MagicMock()
        fake_client.models.generate_content.side_effect = RuntimeError("401 API_KEY_INVALID")

        with _instalar_stub_google_genai(), patch.object(
            processador_media, "obter_cliente_gemini", return_value=fake_client
        ):
            with self.assertRaises(RuntimeError):
                processador_media.process_meeting_media(str(som_path))

    def test_video_usa_files_api_e_limpa_em_finally(self):
        with tempfile.NamedTemporaryFile(suffix=".mp4") as tmp:
            tmp.write(b"fake-video-content")
            tmp.flush()

            fake_client = MagicMock()
            fake_client.files.upload.return_value = SimpleNamespace(
                name="files/abc123",
                uri="https://generativelanguage.googleapis.com/files/abc123",
                display_name="video.mp4",
                state=SimpleNamespace(name="ACTIVE"),
            )
            fake_client.models.generate_content.return_value = SimpleNamespace(
                text=json.dumps({"titulo_reuniao": "Demo Vídeo", "tarefas": []})
            )

            with _instalar_stub_google_genai(), patch.object(
                processador_media, "obter_cliente_gemini", return_value=fake_client
            ):
                resultado = processador_media.process_meeting_media(tmp.name)

            fake_client.files.upload.assert_called_once()
            fake_client.files.delete.assert_called_once_with(name="files/abc123")
            self.assertEqual(resultado["titulo_reuniao"], "Demo Vídeo")


class TestNotificador(unittest.TestCase):
    def test_bloqueia_sem_aprovacao(self):
        dados = {"titulo_reuniao": "Teste", "aprovado_gerente": False, "tarefas": []}
        res = notificador.enviar_notificacoes_aprovadas(dados, modo_teste=True)
        self.assertFalse(res["enviado"])
        self.assertEqual(res["total_notificados"], 0)

        with self.assertRaises(notificador.ErroValidacaoGerente):
            notificador.enviar_notificacoes_aprovadas(dados, modo_teste=True, lancar_erro_se_nao_aprovado=True)

    def test_consolida_e_isola_tarefas_sem_responsavel_e_rejeitadas(self):
        dados = {
            "titulo_reuniao": "Sprint Review",
            "data": "2026-11-17",
            "aprovado_gerente": True,
            "participantes": [
                {"nome": "Carlos", "email": "carlos@empresa.pt", "funcao": "Backend"},
            ],
            "tarefas": [
                {"descricao": "Task 1", "responsavel": "Carlos", "prazo": "Amanhã", "prioridade": "Alta", "estado": "aprovada"},
                {"descricao": "Task 2", "responsavel": "Carlos", "prazo": "Sexta", "prioridade": "Média", "estado": "editada"},
                {"descricao": "Task Descartada", "responsavel": "Carlos", "prazo": "Sexta", "prioridade": "Baixa", "estado": "rejeitada"},
                {"descricao": "Task Órfã", "responsavel": "A definir", "prazo": "A definir", "prioridade": "Média", "estado": "aprovada"},
            ],
        }
        res = notificador.enviar_notificacoes_aprovadas(dados, modo_teste=True)
        self.assertTrue(res["enviado"])
        self.assertEqual(res["total_notificados"], 1)
        self.assertEqual(res["detalhes"][0]["qtd_tarefas"], 2)
        self.assertEqual(len(res["tarefas_sem_responsavel"]), 1)
        self.assertEqual(res["tarefas_sem_responsavel"][0]["descricao"], "Task Órfã")

    def test_html_escape_previne_injecao(self):
        corpo = notificador._construir_corpo_html(
            nome="<script>alert(1)</script>",
            funcao="Dev",
            titulo_reuniao="Reunião <b>Teste</b>",
            data_reuniao="2026-11-17",
            tarefas=[{"descricao": "<img onerror=x>", "prazo": "Amanhã", "prioridade": "Alta"}],
        )
        self.assertNotIn("<script>", corpo)
        self.assertNotIn("<img", corpo)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", corpo)


class TestBackend(unittest.TestCase):
    def test_revisao_interativa_adicionar_e_aprovar(self):
        dados = config_ia.normalizar_dados_reuniao({"titulo_reuniao": "Comité", "tarefas": []})
        entradas = iter([
            "ADICIONAR",
            "Configurar alertas SMTP",
            "Pedro Santos",
            "",
            "2026-11-22",
            "alta",
            "APROVAR",
        ])
        with patch("builtins.input", side_effect=lambda _prompt="": next(entradas)):
            validado = backend.revisao_interativa_gerente(dados)

        self.assertTrue(validado["aprovado_gerente"])
        self.assertEqual(len(validado["tarefas"]), 1)
        self.assertEqual(validado["tarefas"][0]["estado"], "aprovada")
        self.assertEqual(validado["tarefas"][0]["email_responsavel"], "pedro.santos@empresa.pt")
        self.assertIn("Configurar alertas SMTP", validado["tabela_markdown"])

    def test_pipeline_completo_com_som_mp3_e_exportacao(self):
        som_path = _PASTA_ATUAL / "som.mp3"
        dados_simulados = config_ia.normalizar_dados_reuniao(
            {
                "titulo_reuniao": "Reunião Áudio Teste",
                "resumo_executivo": "Alinhamento rápido.",
                "tarefas": [
                    {
                        "descricao": "Validar build Python",
                        "responsavel": "Rita",
                        "prazo": "Hoje",
                        "prioridade": "Alta",
                    }
                ],
            },
            nome_ficheiro="som.mp3",
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            md_out = Path(tmpdir) / "relatorio.md"
            json_out = Path(tmpdir) / "relatorio.json"

            with patch.object(backend, "process_meeting_media", return_value=dados_simulados), patch(
                "builtins.input", return_value="APROVAR"
            ):
                resultado = backend.run_smartmeeting(
                    str(som_path),
                    modo_teste=True,
                    guardar_md=str(md_out),
                    guardar_json=str(json_out),
                )

            self.assertTrue(resultado["dados_reuniao"]["aprovado_gerente"])
            self.assertEqual(resultado["notificacoes"]["total_notificados"], 1)
            self.assertTrue(md_out.is_file())
            self.assertTrue(json_out.is_file())
            self.assertIn("| Tarefa / Entregável | Responsável | Prazo / Data Limite | Prioridade |", md_out.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
