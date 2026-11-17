import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Request, Response } from 'express';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  buildMeetingChatSystemInstruction,
  validateChatPayload,
} from './src/lib/meetingChatContext.ts';
import {
  buildMeetingExtractionSystemInstruction,
  normalizeExtractedMeeting,
  validateProcessMeetingPayload,
  type ExtractedMeetingData,
} from './src/lib/meetingAnalysis.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MODEL_NAME = 'gemini-4-hydrogen';
const TRANSCRIBE_MODEL_NAME = 'gemini-3.5-transcribe';

function normalizeMediaMimeType(rawMimeType: string): string {
  const base = rawMimeType.split(';')[0].trim().toLowerCase();
  if (base === 'audio/mpeg' || base === 'audio/x-mpeg') return 'audio/mp3';
  if (base === 'audio/x-wav' || base === 'audio/wave') return 'audio/wav';
  if (base === 'audio/x-m4a' || base === 'audio/m4a') return 'audio/mp4';
  return base || 'audio/webm';
}

function isTransientApiError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  return (
    status === 503 ||
    status === 429 ||
    message.includes('"code":503') ||
    message.includes('"code":429') ||
    message.includes('UNAVAILABLE') ||
    message.toLowerCase().includes('high demand') ||
    message.toLowerCase().includes('temporarily')
  );
}

function formatFriendlyGeminiError(err: unknown): { statusCode: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;

  if (
    status === 503 ||
    raw.includes('"code":503') ||
    raw.includes('UNAVAILABLE') ||
    raw.toLowerCase().includes('high demand')
  ) {
    return {
      statusCode: 503,
      message:
        'O serviço de IA está temporariamente com elevada procura. Por favor, aguarde alguns segundos e tente novamente.',
    };
  }

  if (status === 429 || raw.includes('"code":429') || raw.includes('RESOURCE_EXHAUSTED')) {
    return {
      statusCode: 429,
      message:
        'Foi atingido o limite temporário de pedidos ao assistente. Aguarde um momento antes de enviar nova pergunta.',
    };
  }

  if (status === 401 || status === 403 || raw.includes('API_KEY_INVALID')) {
    return {
      statusCode: 502,
      message:
        'A chave de API do Gemini configurada no servidor é inválida ou não tem permissões para este modelo.',
    };
  }

  return {
    statusCode: 502,
    message: 'Não foi possível processar o pedido com o motor de IA neste momento. Tente novamente.',
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithTransientRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (attempt < maxAttempts && isTransientApiError(err)) {
        await wait(800 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

const MEETING_EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      description: 'Concise agile meeting title derived strictly from the discussion.',
    },
    executiveSummary: {
      type: Type.STRING,
      description: 'Objective executive summary of what was discussed and agreed.',
    },
    keyDecisions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Key decisions made during the meeting.',
    },
    blockersAndRisks: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Blockers, dependencies, or technical risks mentioned.',
    },
    nextSteps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Agreed next steps for the team.',
    },
    tasks: {
      type: Type.ARRAY,
      description: 'Action items strictly extracted from the meeting transcript/audio.',
      items: {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description: 'Clear, actionable task or deliverable name.',
          },
          description: {
            type: Type.STRING,
            description: 'Brief technical/agile scope of the task.',
          },
          assigneeName: {
            type: Type.STRING,
            description: 'Responsible team member name, or "A definir" if missing.',
          },
          assigneeRole: {
            type: Type.STRING,
            description: 'Role inferred from context (e.g. Backend, QA, Frontend), or "Equipa".',
          },
          dueDate: {
            type: Type.STRING,
            description: 'Deadline (YYYY-MM-DD or clear timeframe), or "A definir" if not mentioned.',
          },
          priority: {
            type: Type.STRING,
            description: 'One of: low, medium, high, urgent.',
          },
          estimatedHours: {
            type: Type.NUMBER,
            description: 'Estimated effort in hours if explicitly mentioned.',
          },
          contextSnippet: {
            type: Type.STRING,
            description: 'Short quote or reference from the transcript justifying this task.',
          },
        },
        required: ['title', 'assigneeName', 'dueDate', 'priority'],
      },
    },
    transcript: {
      type: Type.ARRAY,
      description: 'Diarized transcript entries ordered chronologically.',
      items: {
        type: Type.OBJECT,
        properties: {
          speaker: { type: Type.STRING },
          time: { type: Type.STRING },
          text: { type: Type.STRING },
        },
        required: ['speaker', 'time', 'text'],
      },
    },
  },
  required: ['title', 'executiveSummary', 'keyDecisions', 'blockersAndRisks', 'nextSteps', 'tasks', 'transcript'],
};

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '35mb' }));

  app.post('/api/process-meeting', async (req: Request, res: Response) => {
    const validation = validateProcessMeetingPayload(req.body);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error:
          'A chave GEMINI_API_KEY não está configurada no servidor. Configure a variável de ambiente para processar transcrições e áudio com IA.',
      });
      return;
    }

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const referenceDate = new Date().toISOString().split('T')[0];
      const payload = validation.payload;
      let rawTranscriptText = '';
      let mediaPartForMultimodal: { inlineData: { mimeType: string; data: string } } | null = null;

      if (payload.mode === 'transcript') {
        rawTranscriptText = payload.rawTranscript;
      } else {
        const cleanMime = normalizeMediaMimeType(payload.mimeType);
        if (cleanMime.startsWith('video/')) {
          mediaPartForMultimodal = {
            inlineData: {
              mimeType: cleanMime,
              data: payload.audioBase64,
            },
          };
        } else {
          try {
            const transcribeResponse = await runWithTransientRetry(() =>
              ai.models.generateContent({
                model: TRANSCRIBE_MODEL_NAME,
                contents: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: cleanMime,
                        data: payload.audioBase64,
                      },
                    },
                    {
                      text: 'Transcreve integralmente este áudio da reunião em Português (mantendo os termos técnicos originais). Se houver múltiplos oradores audíveis, separa as falas com identificação e marcação temporal aproximada [MM:SS]. Não inventes conteúdo que não esteja no áudio.',
                    },
                  ],
                },
              })
            );

            rawTranscriptText = transcribeResponse.text?.trim() ?? '';
          } catch (transcribeErr: unknown) {
            const msg = transcribeErr instanceof Error ? transcribeErr.message : String(transcribeErr);
            const status = (transcribeErr as { status?: number })?.status;
            // Re-throw authentication/quota/service errors immediately
            if (
              status === 401 ||
              status === 403 ||
              status === 429 ||
              status === 503 ||
              msg.includes('API_KEY_INVALID') ||
              msg.includes('RESOURCE_EXHAUSTED')
            ) {
              throw transcribeErr;
            }
            console.warn('gemini-3.5-transcribe fallback to multimodal gemini-4-hydrogen:', msg);
          }

          // If transcription returned empty (common on short/quiet WebM recordings), pass audio directly to gemini-4-hydrogen multimodal
          if (!rawTranscriptText) {
            mediaPartForMultimodal = {
              inlineData: {
                mimeType: cleanMime,
                data: payload.audioBase64,
              },
            };
          }
        }
      }

      const systemInstruction = buildMeetingExtractionSystemInstruction(referenceDate);

      const extractionResponse = await runWithTransientRetry(() =>
        ai.models.generateContent({
          model: MODEL_NAME,
          contents: mediaPartForMultimodal
            ? {
                parts: [
                  mediaPartForMultimodal,
                  {
                    text: 'Ouve e transcreve este áudio/vídeo de reunião de engenharia ágil. Extrai a transcrição literal diarizada e, estritamente com base no que foi falado, o resumo executivo, decisões, bloqueios e tarefas reais discutidas (sem inventar tarefas genéricas). Se não houver fala audível clara, devolve transcript vazio e tasks vazio.',
                  },
                ],
              }
            : `Analisa a seguinte transcrição de reunião e extrai estritamente as tarefas, responsáveis, prazos e prioridades reais discutidos:\n\n${rawTranscriptText}`,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: MEETING_EXTRACTION_SCHEMA,
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.LOW,
            },
          },
        })
      );

      const jsonText = extractionResponse.text?.trim();
      if (!jsonText) {
        res.status(502).json({
          error: 'O motor de IA não devolveu dados estruturados para esta reunião.',
        });
        return;
      }

      let parsedData: ExtractedMeetingData;
      try {
        parsedData = JSON.parse(jsonText) as ExtractedMeetingData;
      } catch {
        res.status(502).json({
          error: 'A resposta estruturada do motor de IA não pôde ser interpretada.',
        });
        return;
      }

      const meeting = normalizeExtractedMeeting(parsedData, {
        mode: payload.mode,
        fileName: payload.fileName || 'transcricao.txt',
        fileSizeBytes:
          payload.mode === 'audio'
            ? payload.fileSizeBytes
            : Buffer.byteLength(payload.rawTranscript, 'utf8'),
        durationSeconds:
          payload.mode === 'audio'
            ? payload.durationSeconds ?? 180
            : Math.max(60, Math.round(payload.rawTranscript.split(/\s+/).length / 2.2)),
        mimeType: payload.mode === 'audio' ? payload.mimeType : 'text/plain',
        isDirectRecording: payload.mode === 'audio' ? payload.isDirectRecording : false,
        titleOverride: payload.title,
        referenceDate,
      });

      res.json({
        meeting,
        rawTranscriptText:
          rawTranscriptText ||
          (meeting.transcript ?? []).map((t) => `[${t.time}] ${t.speaker}: ${t.text}`).join('\n'),
        markdownTable: meeting.taskMarkdownTable,
      });
    } catch (err: unknown) {
      console.error('Erro em POST /api/process-meeting:', err);
      const friendly = formatFriendlyGeminiError(err);
      res.status(friendly.statusCode).json({ error: friendly.message });
    }
  });

  app.post('/api/meeting-chat', async (req: Request, res: Response) => {
    const validation = validateChatPayload(req.body);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error:
          'A chave GEMINI_API_KEY não está configurada no servidor. Configure a variável de ambiente para ativar o Assistente da Reunião.',
      });
      return;
    }

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const systemInstruction = buildMeetingChatSystemInstruction(validation.meeting);
      const formattedHistory = validation.history.map((entry) => ({
        role: entry.role,
        parts: [{ text: entry.text }],
      }));

      const response = await runWithTransientRetry(async () => {
        const chat = ai.chats.create({
          model: MODEL_NAME,
          history: formattedHistory,
          config: {
            systemInstruction,
          },
        });

        return chat.sendMessage({
          message: validation.message,
        });
      });

      const replyText = response.text?.trim() ?? '';

      if (!replyText) {
        res.status(502).json({
          error: 'O assistente não devolveu uma resposta válida para esta pergunta.',
        });
        return;
      }

      res.json({ reply: replyText });
    } catch (err: unknown) {
      console.error('Erro em POST /api/meeting-chat:', err);
      const friendly = formatFriendlyGeminiError(err);
      res.status(friendly.statusCode).json({ error: friendly.message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SmartMeeting server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
