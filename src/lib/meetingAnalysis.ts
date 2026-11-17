import type { MeetingRecording, TaskItem } from '../types/index.ts';
import { computeTaskApprovalStatus } from './meetingUtils.ts';

export interface ProcessMeetingAudioPayload {
  mode: 'audio';
  audioBase64: string;
  mimeType: string;
  fileName: string;
  fileSizeBytes: number;
  durationSeconds?: number;
  title?: string;
  isDirectRecording?: boolean;
}

export interface ProcessMeetingTranscriptPayload {
  mode: 'transcript';
  rawTranscript: string;
  fileName?: string;
  title?: string;
}

export type ProcessMeetingPayload =
  | ProcessMeetingAudioPayload
  | ProcessMeetingTranscriptPayload;

export interface ExtractedTaskInput {
  title?: string;
  description?: string;
  assigneeName?: string;
  assigneeRole?: string;
  assigneeEmail?: string;
  dueDate?: string;
  priority?: string;
  estimatedHours?: number;
  contextSnippet?: string;
}

export interface ExtractedMeetingData {
  title?: string;
  executiveSummary?: string;
  keyDecisions?: string[];
  blockersAndRisks?: string[];
  nextSteps?: string[];
  tasks?: ExtractedTaskInput[];
  transcript?: {
    speaker?: string;
    time?: string;
    text?: string;
  }[];
}

const PRIORITY_LABELS: Record<TaskItem['priority'], string> = {
  low: 'Baixa',
  medium: 'Média',
  high: 'Alta',
  urgent: 'Urgente',
};

function sanitizeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim();
}

export function normalizePriority(raw?: string): TaskItem['priority'] {
  const val = (raw ?? '').trim().toLowerCase();
  if (val === 'urgent' || val === 'urgente' || val === 'crítica' || val === 'critica') {
    return 'urgent';
  }
  if (val === 'high' || val === 'alta' || val === 'alto') {
    return 'high';
  }
  if (val === 'low' || val === 'baixa' || val === 'baixo') {
    return 'low';
  }
  return 'medium';
}

export function formatPriorityLabel(priority: TaskItem['priority']): string {
  return PRIORITY_LABELS[priority] ?? 'Média';
}

export function buildTaskMarkdownTable(tasks: TaskItem[]): string {
  const header = '| Tarefa / Entregável | Responsável | Prazo / Data Limite | Prioridade |';
  const separator = '| --- | --- | --- | --- |';

  if (!tasks || tasks.length === 0) {
    return [
      header,
      separator,
      '| Nenhuma tarefa identificada na transcrição | A definir | A definir | Média |',
    ].join('\n');
  }

  const rows = tasks.map((task) => {
    const deliverable = sanitizeMarkdownCell(task.title || 'A definir');
    const assignee = sanitizeMarkdownCell(task.assignee?.name?.trim() || 'A definir');
    const dueDate = sanitizeMarkdownCell(task.dueDate?.trim() || 'A definir');
    const priority = formatPriorityLabel(task.priority);
    return `| ${deliverable} | ${assignee} | ${dueDate} | ${priority} |`;
  });

  return [header, separator, ...rows].join('\n');
}

export function buildMeetingExtractionSystemInstruction(referenceDate: string): string {
  return [
    'You are the AI transcription and meeting governance engine for "SmartMeeting", an agile software development project.',
    'Your core job is to process raw voice transcriptions and extract accurate, real-world tasks based strictly on what was actually discussed.',
    '',
    'RULES FOR PROCESSING TRANSCRIPTIONS:',
    '1. DO NOT use generic or pre-defined mock tasks. Every output must be dynamically derived exclusively from the provided voice transcript or audio text input.',
    '2. Analyze the spoken text thoroughly to identify concrete action items, responsible team members, deadlines, and priorities.',
    '3. Maintain a professional, objective, and agile-focused tone in Portuguese (PT) suitable for engineering project management.',
    '4. If any information (such as a deadline or assignee) is missing from the spoken audio or transcript, intelligently infer it only if clearly implied by context; otherwise explicitly set it to "A definir".',
    '5. Never invent names, dates, decisions, risks, or tasks that were not discussed. If no tasks were mentioned, return an empty tasks array.',
    `6. Reference date for relative deadlines (e.g., "amanhã", "próxima sexta", "final do sprint"): ${referenceDate}. When an exact date can be resolved from context, format dueDate as YYYY-MM-DD; if it is relative without an exact date, state it clearly (e.g., "Sexta-feira desta semana"); if missing, use "A definir".`,
    '7. For each extracted task, include a short verbatim contextSnippet quoting or referencing the part of the conversation where it was agreed.',
    '8. Also produce a concise executiveSummary, keyDecisions, blockersAndRisks, nextSteps, and a clean diarized transcript list strictly grounded in the provided input.',
  ].join('\n');
}

export function validateProcessMeetingPayload(
  body: unknown
):
  | { valid: true; payload: ProcessMeetingPayload }
  | { valid: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Corpo da requisição inválido.' };
  }

  const data = body as Record<string, unknown>;
  const mode = data.mode;

  if (mode === 'transcript') {
    const rawTranscript = typeof data.rawTranscript === 'string' ? data.rawTranscript.trim() : '';
    if (rawTranscript.length < 15) {
      return {
        valid: false,
        error: 'Introduza uma transcrição de voz mais detalhada (mínimo de 15 caracteres) para extrair tarefas.',
      };
    }

    return {
      valid: true,
      payload: {
        mode: 'transcript',
        rawTranscript,
        fileName: typeof data.fileName === 'string' && data.fileName.trim() ? data.fileName.trim() : 'transcricao_manual.txt',
        title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : undefined,
      },
    };
  }

  if (mode === 'audio') {
    const audioBase64 = typeof data.audioBase64 === 'string' ? data.audioBase64.trim() : '';
    const mimeType = typeof data.mimeType === 'string' ? data.mimeType.trim() : '';
    const fileName = typeof data.fileName === 'string' && data.fileName.trim() ? data.fileName.trim() : 'gravacao_reuniao.webm';
    const fileSizeBytes = typeof data.fileSizeBytes === 'number' && data.fileSizeBytes > 0 ? data.fileSizeBytes : 1024;
    const durationSeconds =
      typeof data.durationSeconds === 'number' && data.durationSeconds > 0
        ? Math.round(data.durationSeconds)
        : undefined;

    if (!audioBase64 || !mimeType) {
      return {
        valid: false,
        error: 'Dados de áudio ou tipo MIME em falta para processar a reunião.',
      };
    }

    return {
      valid: true,
      payload: {
        mode: 'audio',
        audioBase64,
        mimeType,
        fileName,
        fileSizeBytes,
        durationSeconds,
        title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : undefined,
        isDirectRecording: Boolean(data.isDirectRecording),
      },
    };
  }

  return { valid: false, error: 'Modo de processamento inválido. Utilize "audio" ou "transcript".' };
}

function inferEmailFromName(name: string): string {
  if (!name || name.toLowerCase() === 'a definir') {
    return 'a-definir@equipa.local';
  }
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return slug ? `${slug}@equipa.local` : 'a-definir@equipa.local';
}

function resolveFileType(
  mode: ProcessMeetingPayload['mode'],
  mimeType?: string,
  fileName?: string,
  isDirectRecording?: boolean
): MeetingRecording['fileType'] {
  if (mode === 'transcript') return 'text/transcript';
  if (isDirectRecording) return 'direct_recording';
  const lower = `${mimeType ?? ''} ${fileName ?? ''}`.toLowerCase();
  if (lower.includes('mp4') || lower.includes('video')) return 'video/mp4';
  if (lower.includes('wav')) return 'audio/wav';
  return 'audio/mp3';
}

export function normalizeExtractedMeeting(
  extracted: ExtractedMeetingData,
  meta: {
    mode: ProcessMeetingPayload['mode'];
    fileName: string;
    fileSizeBytes: number;
    durationSeconds: number;
    mimeType?: string;
    isDirectRecording?: boolean;
    titleOverride?: string;
    referenceDate: string;
  }
): MeetingRecording {
  const nowId = Date.now();

  const tasks: TaskItem[] = (Array.isArray(extracted.tasks) ? extracted.tasks : [])
    .filter((item) => item && typeof item.title === 'string' && item.title.trim().length > 0)
    .map((item, idx) => {
      const assigneeName = item.assigneeName?.trim() || 'A definir';
      const assigneeRole = item.assigneeRole?.trim() || (assigneeName === 'A definir' ? 'Equipa' : 'Membro da Equipa');
      const assigneeEmail = item.assigneeEmail?.trim() || inferEmailFromName(assigneeName);
      const dueDate = item.dueDate?.trim() || 'A definir';
      const priority = normalizePriority(item.priority);

      return {
        id: `task_${nowId}_${idx + 1}`,
        title: item.title!.trim(),
        description: item.description?.trim() || item.title!.trim(),
        assignee: {
          name: assigneeName,
          email: assigneeEmail,
          role: assigneeRole,
        },
        dueDate,
        priority,
        estimatedHours:
          typeof item.estimatedHours === 'number' && item.estimatedHours > 0
            ? Math.round(item.estimatedHours)
            : undefined,
        status: 'pending_approval',
        contextSnippet: item.contextSnippet?.trim() || undefined,
      };
    });

  const transcript = (Array.isArray(extracted.transcript) ? extracted.transcript : [])
    .filter((entry) => entry && typeof entry.text === 'string' && entry.text.trim().length > 0)
    .map((entry, idx) => ({
      speaker: entry.speaker?.trim() || 'Interlocutor',
      time: entry.time?.trim() || `00:${String(idx * 15).padStart(2, '0')}`,
      text: entry.text!.trim(),
    }));

  const defaultTitle =
    meta.mode === 'transcript'
      ? `Análise de Transcrição (${meta.referenceDate})`
      : meta.isDirectRecording
      ? `Reunião Gravada em Direto (${meta.referenceDate})`
      : meta.fileName.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ');

  const title = meta.titleOverride?.trim() || extracted.title?.trim() || defaultTitle;

  const cleanList = (arr?: string[]) =>
    Array.isArray(arr)
      ? arr.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
      : [];

  return {
    id: `rec_${nowId}`,
    title,
    date: meta.referenceDate,
    durationSeconds: meta.durationSeconds,
    fileType: resolveFileType(meta.mode, meta.mimeType, meta.fileName, meta.isDirectRecording),
    fileName: meta.fileName,
    fileSizeBytes: meta.fileSizeBytes,
    managerApprovalStatus: computeTaskApprovalStatus(tasks),
    summary: {
      executiveSummary:
        extracted.executiveSummary?.trim() ||
        'Resumo gerado dinamicamente a partir do conteúdo da reunião processada.',
      keyDecisions: cleanList(extracted.keyDecisions),
      blockersAndRisks: cleanList(extracted.blockersAndRisks),
      nextSteps: cleanList(extracted.nextSteps),
    },
    tasks,
    taskMarkdownTable: buildTaskMarkdownTable(tasks),
    transcript,
  };
}
