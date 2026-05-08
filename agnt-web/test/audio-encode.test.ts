import { describe, expect, it } from "vitest";
import { bytesToBase64, packPcmAsWav, TARGET_SAMPLE_RATE } from "../src/lib/audio-encode";

describe("packPcmAsWav", () => {
  it("emits a valid 16-bit PCM mono WAV header for a small buffer", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const wav = packPcmAsWav({ samples, sampleRate: TARGET_SAMPLE_RATE, durationMs: 1 });

    // RIFF header
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(String.fromCharCode(...wav.subarray(12, 16))).toBe("fmt ");
    expect(String.fromCharCode(...wav.subarray(36, 40))).toBe("data");

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    // PCM format = 1
    expect(view.getUint16(20, true)).toBe(1);
    // Channels = 1
    expect(view.getUint16(22, true)).toBe(1);
    // Sample rate
    expect(view.getUint32(24, true)).toBe(TARGET_SAMPLE_RATE);
    // Bits per sample
    expect(view.getUint16(34, true)).toBe(16);
    // data chunk size = sampleCount * 2
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it("clamps and converts Float32 → Int16 PCM losslessly at the bounds", () => {
    const samples = new Float32Array([-1, 1, 0, 1.5, -1.5]);
    const wav = packPcmAsWav({ samples, sampleRate: 24_000, durationMs: 1 });
    const view = new DataView(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44);
    expect(view.getInt16(0, true)).toBe(-32768);
    expect(view.getInt16(2, true)).toBe(32767);
    expect(view.getInt16(4, true)).toBe(0);
    // Out-of-range positive should saturate at +32767, negative at -32768.
    expect(view.getInt16(6, true)).toBe(32767);
    expect(view.getInt16(8, true)).toBe(-32768);
  });

  it("produces the right byte length (44-byte header + 2 bytes/sample)", () => {
    const samples = new Float32Array(100);
    expect(packPcmAsWav({ samples, sampleRate: 24_000, durationMs: 4 }).byteLength).toBe(44 + 200);
  });
});

describe("bytesToBase64", () => {
  it("encodes ASCII bytes the same as btoa()", () => {
    const text = "Hello, agnt";
    const bytes = new TextEncoder().encode(text);
    expect(bytesToBase64(bytes)).toBe(btoa(text));
  });

  it("handles binary bytes with high values", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(bytesToBase64(bytes)).toBe(btoa("\x00\x01\x7f\x80\xff"));
  });

  it("doesn't blow the call stack on a long buffer (chunked encoding path)", () => {
    const long = new Uint8Array(0x12000);
    for (let i = 0; i < long.length; i += 1) long[i] = i & 0xff;
    expect(bytesToBase64(long).length).toBeGreaterThan(0);
  });
});
