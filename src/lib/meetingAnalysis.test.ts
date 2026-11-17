import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  buildTaskMarkdownTable,
  buildMeetingExtractionSystemInstruction,
  normalizeExtractedMeeting,
  validateProcessMeetingPayload,
} from './meetingAnalysis.ts';
import type { TaskItem } from '../types/index.ts';

describe('meetingAnalysis pure unit tests', () => {
  test('buildTaskMarkdownTable formats exact required Markdown columns', () => {
    const tasks: TaskItem[] = [
      {
        id: 't1',
        title: 'Migrar endpoint de autenticação OAuth',
        description: 'Atualizar callback e validar tokens',
        assignee: { name: 'Diogo Martins', email: 'diogo@empresa.com', role: 'Backend' },
        dueDate: '2026-11-24',
        priority: 'high',
        status: 'pending_approval',
      },
      {
        id: 't2',
        title: 'Rever métricas de latência | API v2',
        description: 'Analisar p95',
        assignee: { name: '', email: 'a-definir@equipa.local', role: 'Equipa' },
        dueDate: '',
        priority: 'urgent',
        status: 'pending_approval',
      },
    ];

    const table = buildTaskMarkdownTable(tasks);
    const lines = table.split('\n');

    assert.strictEqual(
      lines[0],
      '| Tarefa / Entregável | Responsável | Prazo / Data Limite | Prioridade |'
    );
    assert.strictEqual(lines[1], '| --- | --- | --- | --- |');
    assert.strictEqual(
      lines[2],
      '| Migrar endpoint de autenticação OAuth | Diogo Martins | 2026-11-24 | Alta |'
    );
    assert.strictEqual(
      lines[3],
      '| Rever métricas de latência \\| API v2 | A definir | A definir | Urgente |'
    );
  });

  test('buildMeetingExtractionSystemInstruction forbids mock tasks and requires exact table rules', () => {
    const prompt = buildMeetingExtractionSystemInstruction('2026-11-17');
    assert.match(prompt, /DO NOT use generic or pre-defined mock tasks/);
    assert.match(prompt, /A definir/);
    assert.match(prompt, /2026-11-17/);
  });

  test('validateProcessMeetingPayload validates transcript and audio modes', () => {
    const shortTranscript = validateProcessMeetingPayload({
      mode: 'transcript',
      rawTranscript: 'ok',
    });
    assert.strictEqual(shortTranscript.valid, false);

    const validTranscript = validateProcessMeetingPayload({
      mode: 'transcript',
      rawTranscript: 'João fica responsável por corrigir o login até sexta-feira com prioridade alta.',
    });
    assert.strictEqual(validTranscript.valid, true);

    const missingAudio = validateProcessMeetingPayload({
      mode: 'audio',
      mimeType: 'audio/mp3',
    });
    assert.strictEqual(missingAudio.valid, false);
  });

  test('normalizeExtractedMeeting preserves missing fields as A definir and computes Markdown table', () => {
    const meeting = normalizeExtractedMeeting(
      {
        title: 'Daily Standup Backend',
        executiveSummary: 'Foco em correções de deploy.',
        keyDecisions: ['Adiar release para quinta.'],
        tasks: [
          {
            title: 'Corrigir pipeline Docker',
            priority: 'Urgente',
          },
        ],
      },
      {
        mode: 'transcript',
        fileName: 'daily.txt',
        fileSizeBytes: 512,
        durationSeconds: 120,
        referenceDate: '2026-11-17',
      }
    );

    assert.strictEqual(meeting.title, 'Daily Standup Backend');
    assert.strictEqual(meeting.tasks.length, 1);
    assert.strictEqual(meeting.tasks[0].assignee.name, 'A definir');
    assert.strictEqual(meeting.tasks[0].dueDate, 'A definir');
    assert.strictEqual(meeting.tasks[0].priority, 'urgent');
    assert.match(
      meeting.taskMarkdownTable || '',
      /\| Corrigir pipeline Docker \| A definir \| A definir \| Urgente \|/
    );
  });
});
