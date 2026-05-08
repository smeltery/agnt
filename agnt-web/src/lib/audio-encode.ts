// 24 kHz mono WAV encoder. The bridge's voice/transcribe contract only accepts
// 16-bit PCM mono WAV at exactly 24000 Hz. Browsers record WebM/Opus or
// MP4/AAC by default depending on the platform, so we need to:
//
//   1. Decode the recorded blob with AudioContext.decodeAudioData
//   2. Resample to 24 kHz mono via OfflineAudioContext (native — no JS DSP)
//   3. Pack the resulting Float32 samples into a 16-bit PCM RIFF/WAV container
//
// All three steps live in this file as pure-ish helpers so the voice-store
// can stay UI-agnostic and we can unit-test the WAV packer with a fake
// AudioBuffer.

export const TARGET_SAMPLE_RATE = 24_000;
export const TARGET_CHANNELS = 1;

export interface PcmAudio {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
}

export async function encodeBlobToWav(blob: Blob): Promise<{ wavBytes: Uint8Array; durationMs: number }> {
  const decoded = await decodeBlob(blob);
  const resampled = await resampleTo24kMono(decoded);
  const wavBytes = packPcmAsWav(resampled);
  return { wavBytes, durationMs: resampled.durationMs };
}

async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const ContextCtor = (window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;
  if (!ContextCtor) throw new Error("This browser does not support the Web Audio API.");
  const context = new ContextCtor();
  try {
    return await context.decodeAudioData(arrayBuffer);
  } finally {
    void context.close();
  }
}

async function resampleTo24kMono(buffer: AudioBuffer): Promise<PcmAudio> {
  const targetLength = Math.ceil((buffer.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext({
    numberOfChannels: TARGET_CHANNELS,
    length: targetLength,
    sampleRate: TARGET_SAMPLE_RATE,
  });
  const source = offline.createBufferSource();
  source.buffer = buffer;
  // Mix all input channels onto the single mono output channel by average.
  const merger = offline.createGain();
  merger.gain.value = 1 / Math.max(1, buffer.numberOfChannels);
  source.connect(merger);
  merger.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0).slice();
  return {
    samples,
    sampleRate: TARGET_SAMPLE_RATE,
    durationMs: Math.round((samples.length / TARGET_SAMPLE_RATE) * 1000),
  };
}

/**
 * Pack a Float32 mono PCM buffer into a 16-bit PCM RIFF/WAV container. The
 * resulting bytes are exactly what `voice/transcribe` expects.
 */
export function packPcmAsWav(audio: PcmAudio): Uint8Array {
  const sampleCount = audio.samples.length;
  const dataSizeBytes = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSizeBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSizeBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, TARGET_CHANNELS, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * TARGET_CHANNELS * 2, true); // byte rate
  view.setUint16(32, TARGET_CHANNELS * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSizeBytes, true);

  for (let i = 0; i < sampleCount; i += 1) {
    const clamped = Math.max(-1, Math.min(1, audio.samples[i]));
    const intSample = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(44 + i * 2, intSample, true);
  }

  return new Uint8Array(buffer);
}

export function bytesToBase64(bytes: Uint8Array): string {
  // btoa() takes a binary string. Build it in chunks to avoid stack-overflow
  // on long buffers (apply() has an arg-count limit).
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
