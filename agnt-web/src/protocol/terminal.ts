// Bridge-side local-PTY terminal RPC. The browser cannot open raw SSH from
// JavaScript, so the web client asks the bridge to spawn a shell on its own
// host. The corresponding bridge handler lives in
// `agnt-bridge/src/handlers/terminal-handler.js`.
//
// Surface (mirrors the bridge handler):
//   • terminal/open      → snapshot
//   • terminal/write     → { ok }
//   • terminal/resize    → { ok }
//   • terminal/clear     → { ok }
//   • terminal/close     → { ok }
//   • terminal/snapshot  → snapshot
//   • notification terminal/output  → { terminalId, instanceId, dataBase64 }
//   • notification terminal/exited  → { terminalId, instanceId, exitCode, signal }

import type { JsonRpcClient } from "./jsonrpc-client";

export type TerminalStatus = "idle" | "starting" | "running" | "exited" | "closed" | "error";

export interface TerminalSnapshot {
  terminalId: string;
  instanceId: string | null;
  status: TerminalStatus;
  cols: number;
  rows: number;
  cwd: string;
  historyBase64: string;
  errorMessage: string | null;
  resizeSupported: boolean;
}

export interface TerminalOutputEvent {
  terminalId: string;
  instanceId: string;
  dataBase64: string;
}

export interface TerminalExitEvent {
  terminalId: string;
  instanceId: string;
  exitCode: number | null;
  signal: string | null;
}

export async function openTerminal(
  rpc: JsonRpcClient,
  params: { terminalId?: string; cols: number; rows: number; cwd?: string }
): Promise<TerminalSnapshot> {
  return rpc.request<TerminalSnapshot>("terminal/open", params);
}

export async function writeTerminal(
  rpc: JsonRpcClient,
  params: { terminalId?: string; bytes: Uint8Array }
): Promise<void> {
  await rpc.request<{ ok: true }>("terminal/write", {
    terminalId: params.terminalId,
    dataBase64: base64Encode(params.bytes),
  });
}

export async function resizeTerminal(
  rpc: JsonRpcClient,
  params: { terminalId?: string; cols: number; rows: number }
): Promise<void> {
  await rpc.request<{ ok: true }>("terminal/resize", params);
}

export async function clearTerminalBuffer(
  rpc: JsonRpcClient,
  params: { terminalId?: string }
): Promise<void> {
  await rpc.request<{ ok: true }>("terminal/clear", params);
}

export async function closeTerminal(
  rpc: JsonRpcClient,
  params: { terminalId?: string }
): Promise<void> {
  await rpc.request<{ ok: true }>("terminal/close", params);
}

export async function readTerminalSnapshot(
  rpc: JsonRpcClient,
  params: { terminalId?: string }
): Promise<TerminalSnapshot> {
  return rpc.request<TerminalSnapshot>("terminal/snapshot", params);
}

/** Subscribe to terminal/output notifications. Returns an unsubscribe fn. */
export function onTerminalOutput(
  rpc: JsonRpcClient,
  handler: (event: TerminalOutputEvent) => void
): () => void {
  return rpc.onNotification("terminal/output", (params) => {
    const evt = params as TerminalOutputEvent;
    if (!evt || typeof evt.terminalId !== "string") return;
    handler(evt);
  });
}

export function onTerminalExited(
  rpc: JsonRpcClient,
  handler: (event: TerminalExitEvent) => void
): () => void {
  return rpc.onNotification("terminal/exited", (params) => {
    const evt = params as TerminalExitEvent;
    if (!evt || typeof evt.terminalId !== "string") return;
    handler(evt);
  });
}

// ─── helpers ──────────────────────────────────────────────────

function base64Encode(bytes: Uint8Array): string {
  // btoa needs a binary string; encode chunked to avoid stack issues on
  // very large input (e.g. paste of a large file).
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
    );
  }
  return btoa(binary);
}

export function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
