export const PREFERRED_RECORDER_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const;

export function selectSupportedRecorderMimeType(
  isTypeSupported?: (mimeType: string) => boolean
): string | undefined {
  const checker =
    isTypeSupported ??
    (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
      ? (m: string) => MediaRecorder.isTypeSupported(m)
      : undefined);

  if (!checker) return undefined;

  for (const mime of PREFERRED_RECORDER_MIME_TYPES) {
    try {
      if (checker(mime)) {
        return mime;
      }
    } catch {
      // Ignore browser-specific errors for unsupported mime checks
    }
  }

  return undefined;
}

/**
 * Downsamples/mixes PCM channels to mono 16kHz and encodes as standard 16-bit RIFF WAV.
 */
export function encodeMonoPcm16Wav(
  channels: Float32Array[],
  inputSampleRate: number,
  targetSampleRate = 16000
): Uint8Array {
  const channelCount = channels.length;
  const inputLength = channelCount > 0 ? channels[0].length : 0;

  // Mix down to mono
  const mono = new Float32Array(inputLength);
  if (channelCount === 1) {
    mono.set(channels[0]);
  } else if (channelCount > 1) {
    for (let i = 0; i < inputLength; i++) {
      let sum = 0;
      for (let c = 0; c < channelCount; c++) {
        sum += channels[c][i] ?? 0;
      }
      mono[i] = sum / channelCount;
    }
  }

  // Linear resample if sample rates differ
  const outRate = inputSampleRate > 0 ? Math.min(inputSampleRate, targetSampleRate) : targetSampleRate;
  let samples: Float32Array;
  if (inputSampleRate > outRate && inputLength > 0) {
    const ratio = inputSampleRate / outRate;
    const newLength = Math.max(1, Math.floor(inputLength / ratio));
    samples = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcPos = i * ratio;
      const idx0 = Math.floor(srcPos);
      const idx1 = Math.min(inputLength - 1, idx0 + 1);
      const frac = srcPos - idx0;
      samples[i] = mono[idx0] * (1 - frac) + mono[idx1] * frac;
    }
  } else {
    samples = mono;
  }

  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF chunk descriptor
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');

  // fmt sub-chunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, 1, true); // NumChannels (1 = mono)
  view.setUint32(24, outRate, true); // SampleRate
  view.setUint32(28, outRate * 2, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  view.setUint16(32, 2, true); // BlockAlign (NumChannels * BitsPerSample/8)
  view.setUint16(34, 16, true); // BitsPerSample (16)

  // data sub-chunk
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

export async function convertRecordedBlobToWav(blob: Blob): Promise<{
  blob: Blob;
  fileExtension: 'wav' | 'webm';
}> {
  if (typeof window === 'undefined' || blob.size === 0) {
    return { blob, fileExtension: 'webm' };
  }

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    return { blob, fileExtension: 'webm' };
  }

  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioCtx();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    const channels: Float32Array[] = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      channels.push(audioBuffer.getChannelData(c));
    }

    const wavBytes = encodeMonoPcm16Wav(channels, audioBuffer.sampleRate, 16000);
    const wavArrayBuffer = wavBytes.buffer.slice(
      wavBytes.byteOffset,
      wavBytes.byteOffset + wavBytes.byteLength
    ) as ArrayBuffer;
    const wavBlob = new Blob([wavArrayBuffer], { type: 'audio/wav' });
    return { blob: wavBlob, fileExtension: 'wav' };
  } catch {
    // Gracefully keep original MediaRecorder blob if browser decodeAudioData fails
    return { blob, fileExtension: 'webm' };
  } finally {
    if (ctx && ctx.state !== 'closed') {
      ctx.close().catch(() => {});
    }
  }
}
