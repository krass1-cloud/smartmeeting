import { test, describe } from 'node:test';
import assert from 'node:assert';
import { encodeMonoPcm16Wav, selectSupportedRecorderMimeType } from './audioEncoder.ts';

describe('audioEncoder pure unit tests', () => {
  test('selectSupportedRecorderMimeType chooses first supported format or undefined', () => {
    const picked = selectSupportedRecorderMimeType((m) => m === 'audio/webm');
    assert.strictEqual(picked, 'audio/webm');

    const opus = selectSupportedRecorderMimeType((m) => m === 'audio/webm;codecs=opus');
    assert.strictEqual(opus, 'audio/webm;codecs=opus');

    const none = selectSupportedRecorderMimeType(() => false);
    assert.strictEqual(none, undefined);
  });

  test('encodeMonoPcm16Wav produces valid RIFF WAVE header and downsamples to 16kHz', () => {
    // 1 second of 48kHz stereo sine-ish audio -> should downsample to 16000 samples (32000 data bytes + 44 header)
    const left = new Float32Array(48000).fill(0.5);
    const right = new Float32Array(48000).fill(-0.5);
    const wav = encodeMonoPcm16Wav([left, right], 48000, 16000);

    assert.strictEqual(String.fromCharCode(wav[0], wav[1], wav[2], wav[3]), 'RIFF');
    assert.strictEqual(String.fromCharCode(wav[8], wav[9], wav[10], wav[11]), 'WAVE');
    assert.strictEqual(String.fromCharCode(wav[12], wav[13], wav[14], wav[15]), 'fmt ');
    assert.strictEqual(String.fromCharCode(wav[36], wav[37], wav[38], wav[39]), 'data');
    assert.strictEqual(wav.length, 44 + 16000 * 2);

    const view = new DataView(wav.buffer);
    assert.strictEqual(view.getUint16(22, true), 1); // mono
    assert.strictEqual(view.getUint32(24, true), 16000); // 16kHz
    assert.strictEqual(view.getUint16(34, true), 16); // 16-bit
  });
});
