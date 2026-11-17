import React, { useState, useRef, useEffect } from 'react';
import { 
  Upload, 
  Mic, 
  Square, 
  Pause, 
  Play, 
  FileAudio, 
  FileVideo, 
  FileText,
  Sparkles, 
  CheckCircle2, 
  AlertCircle, 
  Radio, 
  Monitor, 
  RotateCcw
} from 'lucide-react';
import { validateMediaFile, formatDuration, formatFileSize } from '../../lib/meetingUtils.ts';
import { convertRecordedBlobToWav, selectSupportedRecorderMimeType } from '../../lib/audioEncoder.ts';
import { buildTaskMarkdownTable } from '../../lib/meetingAnalysis.ts';
import { MeetingRecording, ProcessingStep } from '../../types/index.ts';

interface MediaRecorderDropzoneProps {
  onMeetingProcessed: (newMeeting: MeetingRecording) => void;
  onClose?: () => void;
}

const MAX_INLINE_API_BYTES = 20 * 1024 * 1024; // 20 MB binary limit for inline Gemini upload

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      if (!base64) {
        reject(new Error('Não foi possível ler os dados do ficheiro de áudio.'));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Falha ao ler o ficheiro multimédia selecionado.'));
    reader.readAsDataURL(blob);
  });
}

export const MediaRecorderDropzone: React.FC<MediaRecorderDropzoneProps> = ({
  onMeetingProcessed,
}) => {
  // Input mode: 'upload', 'record', or 'transcript'
  const [activeTab, setActiveTab] = useState<'upload' | 'record' | 'transcript'>('upload');
  
  // Drag & drop state
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // Raw transcript state
  const [rawTranscript, setRawTranscript] = useState('');
  const [meetingTitleInput, setMeetingTitleInput] = useState('');

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isEncodingAudio, setIsEncodingAudio] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingSource, setRecordingSource] = useState<'mic' | 'system'>('mic');
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedFileExt, setRecordedFileExt] = useState<'wav' | 'webm'>('wav');
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);

  // Graceful transcription preview / fallback state
  const [transcriptionNotice, setTranscriptionNotice] = useState<string | null>(null);

  // Processing state
  const [step, setStep] = useState<ProcessingStep>('idle');
  const [progressPercent, setProgressPercent] = useState(0);
  const [currentStepText, setCurrentStepText] = useState('');

  // Audio Context & MediaRecorder Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const recordingSecondsRef = useRef<number>(0);

  // Clean up media streams and object URLs on unmount
  useEffect(() => {
    return () => {
      stopStreamsAndCleanUp(true);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (recordedAudioUrl) {
        URL.revokeObjectURL(recordedAudioUrl);
      }
    };
  }, [recordedAudioUrl]);

  const stopTracksAndAudioContext = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  };

  const stopStreamsAndCleanUp = (forceImmediateStop = false) => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        if (mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.requestData();
        }
        mediaRecorderRef.current.stop();
      } catch {
        stopTracksAndAudioContext();
      }
      if (forceImmediateStop) {
        stopTracksAndAudioContext();
      }
    } else {
      stopTracksAndAudioContext();
    }
  };

  // Drag & drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelected(e.target.files[0]);
    }
  };

  const handleFileSelected = (file: File) => {
    setFileError(null);
    const validation = validateMediaFile({
      name: file.name,
      size: file.size,
      type: file.type
    });

    if (!validation.valid) {
      setFileError(validation.error || 'Ficheiro inválido.');
      setSelectedFile(null);
      return;
    }

    setSelectedFile(file);
  };

  // Canvas visualizer draw loop
  const drawWaveform = () => {
    if (!analyserRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const analyser = analyserRef.current;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const render = () => {
      animationFrameRef.current = requestAnimationFrame(render);
      analyser.getByteTimeDomainData(dataArray);

      ctx.fillStyle = '#020617'; // slate-950
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.lineWidth = 2;
      ctx.strokeStyle = '#22d3ee'; // cyan-400
      ctx.beginPath();

      const sliceWidth = (canvas.width * 1.0) / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
    };

    render();
  };

  // Start direct recording
  const startRecording = async () => {
    setMicPermissionDenied(false);
    setFileError(null);
    setTranscriptionNotice(null);
    audioChunksRef.current = [];
    setRecordedBlob(null);
    if (recordedAudioUrl) {
      URL.revokeObjectURL(recordedAudioUrl);
      setRecordedAudioUrl(null);
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      setFileError('O seu navegador não suporta captura direta de áudio (MediaDevices). Utilize o separador "Transcrição / Texto" ou carregue um ficheiro.');
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      setFileError('A API HTML5 MediaRecorder não está disponível neste navegador. Utilize o separador "Transcrição / Texto" ou carregue um ficheiro.');
      return;
    }

    try {
      let stream: MediaStream;

      if (recordingSource === 'system') {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          }
        });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        });
      }

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach(t => t.stop());
        setFileError(
          recordingSource === 'system'
            ? 'Nenhuma faixa de áudio foi partilhada. Ao selecionar o separador, ative a opção "Partilhar áudio do separador".'
            : 'Nenhum microfone ativo foi detetado.'
        );
        return;
      }

      streamRef.current = stream;

      // Setup Web Audio Analyser for live waveform visualization
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const audioContext = new AudioCtx();
        if (audioContext.state === 'suspended') {
          await audioContext.resume().catch(() => {});
        }
        audioContextRef.current = audioContext;

        const source = audioContext.createMediaStreamSource(new MediaStream([audioTracks[0]]));
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyserRef.current = analyser;
        drawWaveform();
      }

      // Record solely the audio stream when capturing system audio so container stays pure audio
      const recordingStream = new MediaStream(audioTracks);
      const selectedMimeType = selectSupportedRecorderMimeType();
      const mediaRecorder = selectedMimeType
        ? new MediaRecorder(recordingStream, { mimeType: selectedMimeType })
        : new MediaRecorder(recordingStream);

      const resolvedMime = mediaRecorder.mimeType || selectedMimeType || 'audio/webm';
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onerror = () => {
        stopTracksAndAudioContext();
        setIsRecording(false);
        setIsPaused(false);
        setIsEncodingAudio(false);
        setFileError('Ocorreu um erro durante a gravação. Pode tentar novamente ou introduzir a transcrição manualmente.');
      };

      mediaRecorder.onstop = async () => {
        stopTracksAndAudioContext();
        setIsEncodingAudio(true);

        try {
          const rawBlob = new Blob(audioChunksRef.current, { type: resolvedMime });
          if (rawBlob.size === 0) {
            setFileError('A gravação não captou dados de áudio. Verifique o microfone ou escreva a transcrição manualmente.');
            return;
          }

          // Encode into standard 16kHz PCM .wav for universal playback & transcription (falls back safely to .webm)
          const converted = await convertRecordedBlobToWav(rawBlob);
          setRecordedBlob(converted.blob);
          setRecordedFileExt(converted.fileExtension);
          setRecordedAudioUrl(URL.createObjectURL(converted.blob));
        } finally {
          setIsEncodingAudio(false);
        }
      };

      // Handle user stopping screen share via browser banner
      audioTracks[0].onended = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          stopRecording();
        }
      };

      mediaRecorder.start(250); // 250ms chunks for reliable capture even on short recordings
      setIsRecording(true);
      setIsPaused(false);
      setRecordingSeconds(0);
      recordingSecondsRef.current = 0;

      timerIntervalRef.current = window.setInterval(() => {
        recordingSecondsRef.current += 1;
        setRecordingSeconds(recordingSecondsRef.current);
      }, 1000);

    } catch (err: unknown) {
      console.error('Error accessing audio source:', err);
      stopTracksAndAudioContext();
      setMicPermissionDenied(true);
      setFileError('Permissão para gravação de áudio negada ou indisponível. Verifique as definições do browser ou utilize a aba "Transcrição / Texto".');
    }
  };

  const pauseRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.pause();
      setIsPaused(true);
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    }
  };

  const resumeRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
      mediaRecorderRef.current.resume();
      setIsPaused(false);
      timerIntervalRef.current = window.setInterval(() => {
        recordingSecondsRef.current += 1;
        setRecordingSeconds(recordingSecondsRef.current);
      }, 1000);
    }
  };

  const stopRecording = () => {
    setIsRecording(false);
    setIsPaused(false);
    setIsEncodingAudio(true);
    stopStreamsAndCleanUp(false);
  };

  // Open Manager Review Table directly even if audio transcription had no detected speech/tasks
  const handleProceedToReviewWithManualEntry = () => {
    const nowId = Date.now();
    const today = new Date().toISOString().split('T')[0];
    const trimmedNotes = rawTranscript.trim();

    const fallbackMeeting: MeetingRecording = {
      id: `rec_${nowId}`,
      title:
        meetingTitleInput.trim() ||
        (selectedFile
          ? selectedFile.name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ')
          : `Reunião Gravada (${today})`),
      date: today,
      durationSeconds: Math.max(recordingSeconds, 10),
      fileType: activeTab === 'record' ? 'direct_recording' : 'text/transcript',
      fileName: selectedFile
        ? selectedFile.name
        : recordedBlob
        ? `gravacao_direta_${nowId}.${recordedFileExt}`
        : 'transcricao_manual.txt',
      fileSizeBytes: selectedFile?.size ?? recordedBlob?.size ?? Math.max(trimmedNotes.length, 64),
      managerApprovalStatus: 'fully_approved',
      summary: {
        executiveSummary: trimmedNotes
          ? `Registo preparado com pré-visualização manual da reunião: "${trimmedNotes.slice(0, 220)}${trimmedNotes.length > 220 ? '...' : ''}"`
          : 'Gravação recebida. Adicione ou edite tarefas diretamente no Mapa de Distribuição para revisão do gestor.',
        keyDecisions: [],
        blockersAndRisks: [],
        nextSteps: ['Adicionar ou validar tarefas no Mapa de Distribuição de Tarefas.'],
      },
      tasks: [],
      taskMarkdownTable: buildTaskMarkdownTable([]),
      transcript: trimmedNotes
        ? [{ speaker: 'Nota da Reunião', time: '00:00', text: trimmedNotes }]
        : [],
    };

    onMeetingProcessed(fallbackMeeting);
  };

  // Submit file, recording, or raw transcript for real Gemini AI processing
  const handleProcessMedia = async () => {
    setFileError(null);
    setTranscriptionNotice(null);

    if (activeTab === 'transcript') {
      const trimmed = rawTranscript.trim();
      if (trimmed.length < 15) {
        setFileError('Cole ou escreva uma transcrição de voz com pelo menos 15 caracteres.');
        return;
      }

      setStep('transcribing');
      setProgressPercent(35);
      setCurrentStepText('A analisar a transcrição de voz com o motor SmartMeeting...');

      try {
        setStep('extracting_tasks');
        setProgressPercent(70);
        setCurrentStepText('IA a identificar tarefas, responsáveis, prazos e prioridades reais...');

        const response = await fetch('/api/process-meeting', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'transcript',
            rawTranscript: trimmed,
            title: meetingTitleInput.trim() || undefined,
            fileName: 'transcricao_reuniao.txt',
          }),
        });

        const data = (await response.json().catch(() => ({}))) as {
          meeting?: MeetingRecording;
          error?: string;
        };

        if (!response.ok || !data.meeting) {
          throw new Error(
            data.error || 'Não foi possível processar a transcrição com o motor de IA.'
          );
        }

        setStep('ready_for_review');
        setProgressPercent(100);
        setCurrentStepText('Mapa de tarefas extraído! A abrir revisão do Gestor...');
        onMeetingProcessed(data.meeting);
      } catch (err: unknown) {
        setStep('idle');
        setProgressPercent(0);
        setFileError(
          err instanceof Error
            ? err.message
            : 'Erro ao processar a transcrição da reunião.'
        );
      }
      return;
    }

    const mediaSource: Blob | File | null =
      activeTab === 'record' ? recordedBlob : selectedFile;
    if (!mediaSource) return;

    if (mediaSource.size > MAX_INLINE_API_BYTES) {
      setFileError(
        `O ficheiro tem ${formatFileSize(mediaSource.size)} e excede o limite de envio direto de 20 MB. Utilize um áudio mais curto ou cole a transcrição na aba "Transcrição / Texto".`
      );
      return;
    }

    const isFromRecord = activeTab === 'record';
    const fileName = selectedFile
      ? selectedFile.name
      : `gravacao_direta_${Date.now()}.${recordedFileExt}`;
    const mimeType =
      mediaSource.type ||
      (fileName.toLowerCase().endsWith('.wav')
        ? 'audio/wav'
        : fileName.toLowerCase().endsWith('.mp4')
        ? 'video/mp4'
        : fileName.toLowerCase().endsWith('.webm')
        ? 'audio/webm'
        : 'audio/mp3');

    try {
      setStep('uploading');
      setProgressPercent(20);
      setCurrentStepText('A preparar pacote multimédia para transcrição neural...');

      const audioBase64 = await blobToBase64(mediaSource);

      setStep('transcribing');
      setProgressPercent(55);
      setCurrentStepText('Transcrição neural Gemini & identificação de interlocutores...');

      const response = await fetch('/api/process-meeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'audio',
          audioBase64,
          mimeType,
          fileName,
          fileSizeBytes: mediaSource.size,
          durationSeconds: isFromRecord ? Math.max(recordingSeconds, 10) : undefined,
          isDirectRecording: isFromRecord,
        }),
      });

      setStep('extracting_tasks');
      setProgressPercent(85);
      setCurrentStepText('A estruturar tarefas, prazos e prioridades reais...');

      const data = (await response.json().catch(() => ({}))) as {
        meeting?: MeetingRecording;
        rawTranscriptText?: string;
        error?: string;
      };

      if (!response.ok || !data.meeting) {
        throw new Error(
          data.error || 'Não foi possível concluir a transcrição automática deste áudio.'
        );
      }

      // Edge-case protection: if audio returned empty transcript and 0 tasks, surface transcription preview & manual fallback seamlessly
      const hasTranscript = Boolean(data.rawTranscriptText?.trim()) || (data.meeting.transcript?.length ?? 0) > 0;
      if (!hasTranscript && data.meeting.tasks.length === 0) {
        setStep('idle');
        setProgressPercent(0);
        setTranscriptionNotice(
          'O áudio foi gravado, mas não foi possível distinguir fala suficiente para extrair tarefas automaticamente. Pode ouvir a gravação, escrever ou colar a transcrição abaixo, ou avançar diretamente para a tabela de revisão.'
        );
        setActiveTab('transcript');
        return;
      }

      setStep('ready_for_review');
      setProgressPercent(100);
      setCurrentStepText('Reunião processada! A abrir Mapa de Tarefas para aprovação...');
      onMeetingProcessed(data.meeting);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Erro ao processar áudio com o motor de IA.';
      setStep('idle');
      setProgressPercent(0);
      // Gracefully offer manual transcription preview fallback while showing the real error
      setFileError(msg);
      setTranscriptionNotice(
        'Pode rever a gravação captada e colar ou escrever a transcrição manualmente para popular a tabela de revisão do gestor.'
      );
    }
  };

  const handleTranscriptFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setRawTranscript(text);
      if (!meetingTitleInput.trim()) {
        setMeetingTitleInput(file.name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' '));
      }
      setFileError(null);
    } catch {
      setFileError('Não foi possível ler o ficheiro de texto selecionado.');
    }
  };

  const handleReset = () => {
    stopStreamsAndCleanUp(true);
    if (recordedAudioUrl) {
      URL.revokeObjectURL(recordedAudioUrl);
      setRecordedAudioUrl(null);
    }
    setSelectedFile(null);
    setRecordedBlob(null);
    setIsEncodingAudio(false);
    setRawTranscript('');
    setMeetingTitleInput('');
    setRecordingSeconds(0);
    setIsRecording(false);
    setIsPaused(false);
    setStep('idle');
    setProgressPercent(0);
    setFileError(null);
    setTranscriptionNotice(null);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xl max-w-4xl mx-auto">
      {/* Module Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-cyan-400 mb-1">
            <Radio className="w-3.5 h-3.5" />
            <span>Módulo de Ingestão Multimédia & Transcrição</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
            Gravar, Carregar Áudio ou Transcrição
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Extração dinâmica de tarefas reais com IA a partir de áudio (.mp3, .wav, .mp4, .webm), gravação direta ou transcrição em texto.
          </p>
        </div>

        {/* Tab Switcher */}
        {step === 'idle' && (
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg shrink-0">
            <button
              type="button"
              onClick={() => { setActiveTab('upload'); setFileError(null); }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                activeTab === 'upload'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Upload Ficheiro</span>
            </button>
            <button
              type="button"
              onClick={() => { setActiveTab('record'); setFileError(null); }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                activeTab === 'record'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Mic className="w-3.5 h-3.5" />
              <span>Gravação Direta</span>
            </button>
            <button
              type="button"
              onClick={() => { setActiveTab('transcript'); setFileError(null); }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                activeTab === 'transcript'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Transcrição / Texto</span>
            </button>
          </div>
        )}
      </div>

      {/* ERROR BANNER */}
      {fileError && (
        <div className="mt-4 p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-rose-300">
          <div className="flex items-start gap-3 flex-1">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium">{fileError}</p>
              {micPermissionDenied && (
                <p className="text-slate-400 text-[11px] mt-1">
                  Dica: Verifique as permissões de microfone nas definições do seu browser ou utilize a aba Transcrição / Texto.
                </p>
              )}
            </div>
          </div>
          {activeTab !== 'transcript' && (
            <button
              type="button"
              onClick={() => setActiveTab('transcript')}
              className="px-3 py-1.5 text-[11px] font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors shrink-0"
            >
              Usar Transcrição Manual
            </button>
          )}
        </div>
      )}

      {/* TRANSCRIPTION FALLBACK NOTICE */}
      {transcriptionNotice && (
        <div className="mt-4 p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-amber-200">
          <div className="flex items-start gap-2.5 flex-1">
            <FileText className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
            <p className="leading-relaxed">{transcriptionNotice}</p>
          </div>
          <button
            type="button"
            onClick={handleProceedToReviewWithManualEntry}
            className="px-3 py-1.5 text-[11px] font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors shrink-0"
          >
            Abrir Tabela de Revisão
          </button>
        </div>
      )}

      {/* STATE 1: ASYNC AI PROCESSING PROGRESS */}
      {step !== 'idle' ? (
        <div className="py-12 px-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center mx-auto mb-6 text-cyan-400 relative">
            <Sparkles className="w-8 h-8 animate-pulse" />
            <span className="absolute -top-1 -right-1 flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500"></span>
            </span>
          </div>

          <h3 className="text-lg font-bold text-white mb-2">
            A Processar Inteligência da Reunião
          </h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto mb-8">
            {currentStepText}
          </p>

          {/* Progress Bar */}
          <div className="max-w-md mx-auto mb-8">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-2 font-mono">
              <span>Etapa do Pipeline</span>
              <span className="text-cyan-400 font-semibold">{progressPercent}%</span>
            </div>
            <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
              <div 
                className="h-full bg-gradient-to-r from-cyan-500 to-indigo-500 transition-all duration-500 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          {/* Step indicators */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-xl mx-auto text-left">
            <div className={`p-3 rounded-lg border text-xs transition-colors ${
              progressPercent >= 40 
                ? 'bg-slate-950/80 border-cyan-500/40 text-cyan-300' 
                : 'bg-slate-950/30 border-slate-800 text-slate-500'
            }`}>
              <div className="font-semibold mb-1 flex items-center gap-1.5">
                {progressPercent >= 40 && <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" />}
                1. Extração de Áudio
              </div>
              <p className="text-[11px] text-slate-400">Separação de canais e redução de ruído.</p>
            </div>

            <div className={`p-3 rounded-lg border text-xs transition-colors ${
              progressPercent >= 70 
                ? 'bg-slate-950/80 border-cyan-500/40 text-cyan-300' 
                : 'bg-slate-950/30 border-slate-800 text-slate-500'
            }`}>
              <div className="font-semibold mb-1 flex items-center gap-1.5">
                {progressPercent >= 70 && <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" />}
                2. Transcrição & Vozes
              </div>
              <p className="text-[11px] text-slate-400">Diarização e reconhecimento dos oradores.</p>
            </div>

            <div className={`p-3 rounded-lg border text-xs transition-colors ${
              progressPercent >= 95 
                ? 'bg-slate-950/80 border-cyan-500/40 text-cyan-300' 
                : 'bg-slate-950/30 border-slate-800 text-slate-500'
            }`}>
              <div className="font-semibold mb-1 flex items-center gap-1.5">
                {progressPercent >= 95 && <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" />}
                3. Mapa de Tarefas
              </div>
              <p className="text-[11px] text-slate-400">Preparação para governança do Gestor.</p>
            </div>
          </div>
        </div>
      ) : activeTab === 'upload' ? (
        /* STATE 2: DRAG AND DROP UPLOAD ZONE */
        <div className="mt-6 space-y-6">
          {!selectedFile ? (
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-2xl p-8 sm:p-12 text-center transition-all cursor-pointer ${
                isDragging
                  ? 'border-cyan-400 bg-cyan-950/20 scale-[1.01]'
                  : 'border-slate-800 hover:border-slate-700 bg-slate-950/40'
              }`}
              onClick={() => document.getElementById('meeting-file-input')?.click()}
            >
              <input
                type="file"
                id="meeting-file-input"
                className="hidden"
                accept=".mp3,.wav,.mp4,.m4a,.webm,audio/*,video/mp4"
                onChange={handleFileInputChange}
              />
              <div className="w-14 h-14 rounded-2xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-center mx-auto mb-4 text-cyan-400 shadow-inner">
                <Upload className="w-6 h-6" />
              </div>
              <h3 className="text-base font-semibold text-white mb-1">
                Arraste o ficheiro de áudio ou vídeo para aqui
              </h3>
              <p className="text-xs text-slate-400 mb-4 max-w-sm mx-auto">
                Suporte nativo para gravações nos formatos <span className="text-slate-300 font-semibold">.mp3</span>, <span className="text-slate-300 font-semibold">.wav</span> e <span className="text-slate-300 font-semibold">.mp4</span> até 500 MB.
              </p>
              <div className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-slate-200 hover:bg-white rounded-lg transition-colors">
                <span>Procurar no Computador</span>
              </div>
            </div>
          ) : (
            /* Selected File Preview Box */
            <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 shrink-0">
                    {selectedFile.type.includes('video') || selectedFile.name.endsWith('.mp4') ? (
                      <FileVideo className="w-5 h-5" />
                    ) : (
                      <FileAudio className="w-5 h-5" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">
                      {selectedFile.name}
                    </p>
                    <p className="text-xs text-slate-400 font-mono">
                      {formatFileSize(selectedFile.size)} · Ficheiro pronto para análise
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSelectedFile(null)}
                    className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
                  >
                    Trocar Ficheiro
                  </button>
                  <button
                    onClick={handleProcessMedia}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors shadow-sm shadow-cyan-500/20"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Processar com IA</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : activeTab === 'record' ? (
        /* STATE 3: DIRECT BROWSER RECORDING */
        <div className="mt-6 space-y-6">
          {/* Source Selector (Microphone vs System Audio / Meet Tab) */}
          {!isRecording && !recordedBlob && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => setRecordingSource('mic')}
                className={`p-4 rounded-xl border text-left transition-all ${
                  recordingSource === 'mic'
                    ? 'border-cyan-500 bg-cyan-950/20 ring-1 ring-cyan-500/50'
                    : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="p-2 rounded-lg bg-slate-800 text-cyan-400">
                    <Mic className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-semibold text-white">Microfone Local</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  Ideal para reuniões presenciais, notas de voz individuais ou gravação através dos auscultadores.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setRecordingSource('system')}
                className={`p-4 rounded-xl border text-left transition-all ${
                  recordingSource === 'system'
                    ? 'border-cyan-500 bg-cyan-950/20 ring-1 ring-cyan-500/50'
                    : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="p-2 rounded-lg bg-slate-800 text-indigo-400">
                    <Monitor className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-semibold text-white">Áudio do Separador / Reunião</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  Grave o Google Meet ou Zoom diretamente pelo separador do navegador, sem convidar nenhum bot.
                </p>
              </button>
            </div>
          )}

          {/* Live Waveform Canvas */}
          <div className="bg-slate-950 rounded-xl p-4 border border-slate-800 relative overflow-hidden">
            <div className="flex items-center justify-between mb-3 text-xs">
              <div className="flex items-center gap-2">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${
                  isRecording 
                    ? isPaused ? 'bg-amber-400' : 'bg-rose-500 animate-pulse' 
                    : 'bg-slate-600'
                }`} />
                <span className="font-semibold text-white">
                  {isRecording 
                    ? isPaused ? 'Gravação Pausada' : 'A Gravar Áudio em Direto...' 
                    : recordedBlob ? 'Gravação Concluída' : 'Pronto para Gravar'}
                </span>
              </div>
              <div className="font-mono text-cyan-400 font-semibold tracking-wider">
                {formatDuration(recordingSeconds)}
              </div>
            </div>

            <canvas
              ref={canvasRef}
              width={600}
              height={90}
              className="w-full h-24 rounded bg-slate-950 border border-slate-900"
            />
          </div>

          {/* Recorder Controls */}
          <div className="space-y-4 pt-2">
            {!isRecording && !recordedBlob && !isEncodingAudio ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={startRecording}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-slate-950 bg-gradient-to-r from-cyan-400 to-indigo-400 hover:from-cyan-300 hover:to-indigo-300 rounded-lg transition-all shadow-md shadow-cyan-500/10 focus:outline-none"
                >
                  <Mic className="w-4 h-4" />
                  <span>Iniciar Gravação Direta</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('transcript')}
                  className="text-xs text-slate-400 hover:text-cyan-300 transition-colors"
                >
                  Prefere colar ou escrever a transcrição?
                </button>
              </div>
            ) : isRecording ? (
              <div className="flex items-center gap-3">
                {isPaused ? (
                  <button
                    type="button"
                    onClick={resumeRecording}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>Retomar</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={pauseRecording}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
                  >
                    <Pause className="w-3.5 h-3.5" />
                    <span>Pausar</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={stopRecording}
                  className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors shadow-sm"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>Concluir Gravação</span>
                </button>
              </div>
            ) : isEncodingAudio ? (
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-xs text-cyan-300 flex items-center gap-2.5">
                <Sparkles className="w-4 h-4 animate-spin" />
                <span>A finalizar e codificar áudio (.wav)...</span>
              </div>
            ) : (
              /* Recorded Blob Ready with Inline Audio Player Preview */
              <div className="space-y-4">
                {recordedAudioUrl && (
                  <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-[11px] font-medium text-slate-400 mb-2">
                      Pré-visualização do Áudio Gravado ({recordedFileExt.toUpperCase()})
                    </div>
                    <audio
                      controls
                      src={recordedAudioUrl}
                      className="w-full h-9"
                    />
                  </div>
                )}

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 w-full">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
                      <CheckCircle2 className="w-5 h-5" />
                    </div>
                    <div className="text-left">
                      <div className="text-xs font-semibold text-white">
                        Áudio captado com sucesso ({formatDuration(recordingSeconds)})
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono">
                        {recordedBlob ? formatFileSize(recordedBlob.size) : '0 B'} · Formato .{recordedFileExt} pronto para transcrição
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleReset}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Gravar Novamente</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('transcript')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      <span>Escrever Transcrição</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleProcessMedia}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors shadow-sm shadow-cyan-500/20"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Transcrever & Gerar Mapa</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* STATE 4: RAW VOICE TRANSCRIPT INPUT & FALLBACK PREVIEW */
        <div className="mt-6 space-y-4">
          {recordedAudioUrl && (
            <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Áudio gravado disponível para consulta ({formatDuration(recordingSeconds)})</span>
                <span className="font-mono text-cyan-400">.{recordedFileExt}</span>
              </div>
              <audio controls src={recordedAudioUrl} className="w-full h-9" />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label htmlFor="transcript-meeting-title" className="block text-[11px] font-medium text-slate-400 mb-1">
                Título da Reunião (opcional)
              </label>
              <input
                id="transcript-meeting-title"
                type="text"
                value={meetingTitleInput}
                onChange={(e) => setMeetingTitleInput(e.target.value)}
                placeholder="Ex: Daily Engineering Sync · Sprint 45"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div className="flex items-end">
              <label className="w-full cursor-pointer inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-200 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors">
                <Upload className="w-3.5 h-3.5 text-cyan-400" />
                <span>Carregar .txt / .md</span>
                <input
                  type="file"
                  accept=".txt,.md,.vtt,.srt,text/plain"
                  onChange={handleTranscriptFileInput}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          <div>
            <label htmlFor="raw-transcript-textarea" className="block text-[11px] font-medium text-slate-400 mb-1">
              Transcrição Bruta de Voz (cole ou escreva o diálogo real da reunião)
            </label>
            <textarea
              id="raw-transcript-textarea"
              rows={7}
              value={rawTranscript}
              onChange={(e) => setRawTranscript(e.target.value)}
              placeholder="Exemplo:
Ana: Precisamos finalizar a migração da API de faturação até sexta-feira, prioridade alta.
Pedro: Eu fico responsável pelos testes de integração do checkout.
Ana: Perfeito, e falta definir quem vai rever a documentação do Swagger."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 leading-relaxed"
            />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
            <span className="text-[11px] text-slate-400">
              Todas as tarefas serão extraídas estritamente desta transcrição (campos ausentes marcados como &quot;A definir&quot;).
            </span>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleProceedToReviewWithManualEntry}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors"
              >
                <span>Abrir Tabela Manual</span>
              </button>
              <button
                type="button"
                onClick={handleProcessMedia}
                disabled={rawTranscript.trim().length < 15}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors shadow-sm shadow-cyan-500/20"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Extrair Tarefas com IA</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer Note */}
      <div className="mt-8 pt-4 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between text-[11px] text-slate-500 gap-2">
        <div>
          <span>Extração dinâmica com Gemini · Sem tarefas fictícias ou pré-definidas</span>
        </div>
        <div>
          <span>Formatos: .mp3, .wav, .mp4, .webm ou Transcrição</span>
        </div>
      </div>
    </div>
  );
};
