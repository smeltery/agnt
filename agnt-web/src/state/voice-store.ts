// Voice transcription state machine. The MediaRecorder + Web Audio + RPC
// pipeline lives here so the UI just renders states and dispatches actions:
//
//   idle ──start()──► recording ──stop()──► transcribing ─► transcribed
//                                                         └► error
//
// Bridge contract: voice/transcribe is single request/response (no streaming
// partials). The UI shows a recording timer and a "transcribing…" badge, then
// drops the final text into the composer via `pendingTranscript`.

import { create } from "zustand";
import { bytesToBase64, encodeBlobToWav } from "../lib/audio-encode";
import { makeLogger } from "../lib/log";
import type { Connection } from "../protocol";

const log = makeLogger("voice");

export type VoiceState =
  | { kind: "idle" }
  | { kind: "recording"; startedAt: number }
  | { kind: "transcribing" }
  | { kind: "error"; message: string };

interface State {
  state: VoiceState;
  /** Newest transcript. Composer reads-and-clears via `consumeTranscript`. */
  pendingTranscript: string | null;
  bind(connection: Connection): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): void;
  consumeTranscript(): string | null;
  reset(): void;
}

let activeConnection: Connection | null = null;
let activeRecorder: MediaRecorder | null = null;
let activeStream: MediaStream | null = null;
let recordedChunks: Blob[] = [];
let recordingMimeType = "";

export const useVoiceStore = create<State>((set, get) => ({
  state: { kind: "idle" },
  pendingTranscript: null,

  bind(connection) {
    activeConnection = connection;
    set({ state: { kind: "idle" }, pendingTranscript: null });
  },

  async start() {
    if (get().state.kind !== "idle") return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      set({ state: { kind: "error", message: "This browser doesn't support microphone capture." } });
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      set({ state: { kind: "error", message: "Microphone permission denied." } });
      return;
    }

    const mimeType = pickRecorderMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      set({ state: { kind: "error", message: (error as Error).message } });
      return;
    }

    recordedChunks = [];
    recordingMimeType = recorder.mimeType || mimeType;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) recordedChunks.push(event.data);
    });
    recorder.addEventListener("error", (event) => {
      log.warn("recorder error", event);
    });
    activeRecorder = recorder;
    activeStream = stream;
    recorder.start(250); // emit chunks every 250 ms so we have data even if stop() races
    set({ state: { kind: "recording", startedAt: Date.now() } });
  },

  async stop() {
    if (get().state.kind !== "recording" || !activeRecorder) return;
    set({ state: { kind: "transcribing" } });

    const recorder = activeRecorder;
    const stream = activeStream;
    activeRecorder = null;
    activeStream = null;

    try {
      const stopped = new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
      });
      recorder.stop();
      await stopped;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      set({ state: { kind: "error", message: (error as Error).message } });
      return;
    }
    stream?.getTracks().forEach((track) => track.stop());

    if (recordedChunks.length === 0) {
      set({ state: { kind: "error", message: "No audio was captured." } });
      return;
    }

    const blob = new Blob(recordedChunks, { type: recordingMimeType });
    recordedChunks = [];
    try {
      const transcript = await transcribe(blob);
      if (transcript.trim()) {
        set({ state: { kind: "idle" }, pendingTranscript: transcript.trim() });
      } else {
        set({ state: { kind: "error", message: "Transcription returned no text." } });
      }
    } catch (error) {
      const message = (error as { userMessage?: string; message?: string })?.userMessage
        ?? (error as Error).message
        ?? "Voice transcription failed.";
      log.warn("transcription failed", error);
      set({ state: { kind: "error", message } });
    }
  },

  cancel() {
    if (activeRecorder) {
      try {
        activeRecorder.stop();
      } catch {
        // already inactive
      }
    }
    activeStream?.getTracks().forEach((track) => track.stop());
    activeRecorder = null;
    activeStream = null;
    recordedChunks = [];
    set({ state: { kind: "idle" } });
  },

  consumeTranscript() {
    const value = get().pendingTranscript;
    if (value !== null) set({ pendingTranscript: null });
    return value;
  },

  reset() {
    activeConnection = null;
    if (activeRecorder) try { activeRecorder.stop(); } catch { /* ignore */ }
    activeStream?.getTracks().forEach((track) => track.stop());
    activeRecorder = null;
    activeStream = null;
    recordedChunks = [];
    set({ state: { kind: "idle" }, pendingTranscript: null });
  },
}));

async function transcribe(blob: Blob): Promise<string> {
  if (!activeConnection?.rpc) throw new Error("Voice transcription needs an active connection.");
  const { wavBytes, durationMs } = await encodeBlobToWav(blob);
  const audioBase64 = bytesToBase64(wavBytes);
  const result = await activeConnection.rpc.request<{ text?: string }>("voice/transcribe", {
    audioBase64,
    mimeType: "audio/wav",
    sampleRateHz: 24_000,
    durationMs,
  });
  return result.text ?? "";
}

/** Pick a recorder MIME type the current browser supports. Default empty string. */
function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const mime of candidates) if (MediaRecorder.isTypeSupported?.(mime)) return mime;
  return "";
}
