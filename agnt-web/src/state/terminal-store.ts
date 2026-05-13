// Web-side state for the bridge-spawned local PTY terminal. Mirrors the
// pattern of `git-store.ts` etc.: a zustand store callers feed `JsonRpcClient`
// into. Unlike iOS/Android (on-device SSH), the browser has no terminal of its
// own — every byte routes through the bridge.

import { create } from "zustand";
import {
  base64Decode,
  clearTerminalBuffer,
  closeTerminal,
  onTerminalExited,
  onTerminalOutput,
  openTerminal,
  readTerminalSnapshot,
  resizeTerminal,
  TerminalSnapshot,
  type TerminalStatus,
  writeTerminal,
} from "../protocol/terminal";
import type { JsonRpcClient } from "../protocol/jsonrpc-client";

export const DEFAULT_TERMINAL_ID = "term-1";

type OutputListener = (terminalId: string, bytes: Uint8Array) => void;

export interface TerminalState {
  /** Per-terminal snapshot keyed by terminalId. */
  snapshots: Record<string, TerminalSnapshot>;
  /** True after we've successfully wired a notification listener for this rpc. */
  subscribed: boolean;

  /** Wire notification listeners. Idempotent. */
  ensureSubscribed(rpc: JsonRpcClient): void;

  open(rpc: JsonRpcClient, params: { terminalId?: string; cols: number; rows: number; cwd?: string; acknowledgeFirstUse?: boolean }): Promise<void>;
  write(rpc: JsonRpcClient, params: { terminalId?: string; bytes: Uint8Array }): Promise<void>;
  resize(rpc: JsonRpcClient, params: { terminalId?: string; cols: number; rows: number }): Promise<void>;
  clear(rpc: JsonRpcClient, params: { terminalId?: string }): Promise<void>;
  close(rpc: JsonRpcClient, params: { terminalId?: string }): Promise<void>;
  refresh(rpc: JsonRpcClient, params: { terminalId?: string }): Promise<void>;

  /**
   * Subscribe a listener to incremental output bytes for a given terminal.
   * The xterm.js surface uses this to write only deltas (the snapshot also
   * includes them in `historyBase64`, but feeding them again would duplicate).
   */
  subscribeOutput(listener: OutputListener): () => void;

  reset(): void;
}

const outputListeners = new Set<OutputListener>();

function emitOutput(terminalId: string, bytes: Uint8Array): void {
  outputListeners.forEach((listener) => {
    try {
      listener(terminalId, bytes);
    } catch (error) {
      // a listener crash must not prevent the others from running
      // eslint-disable-next-line no-console
      console.error("terminal output listener failed", error);
    }
  });
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  snapshots: {},
  subscribed: false,

  ensureSubscribed(rpc) {
    if (get().subscribed) return;
    set({ subscribed: true });

    onTerminalOutput(rpc, (event) => {
      const bytes = base64Decode(event.dataBase64);
      // Append into the buffer so a brand-new TerminalSurface can replay
      // history when it mounts (e.g. user navigates away and back).
      set((state) => {
        const current = state.snapshots[event.terminalId];
        if (!current || current.instanceId !== event.instanceId) return state;
        const merged = appendHistory(current.historyBase64, bytes);
        return {
          snapshots: {
            ...state.snapshots,
            [event.terminalId]: { ...current, historyBase64: merged },
          },
        };
      });
      emitOutput(event.terminalId, bytes);
    });

    onTerminalExited(rpc, (event) => {
      set((state) => {
        const current = state.snapshots[event.terminalId];
        if (!current || current.instanceId !== event.instanceId) return state;
        const status: TerminalStatus = "exited";
        return {
          snapshots: {
            ...state.snapshots,
            [event.terminalId]: { ...current, status },
          },
        };
      });
    });
  },

  async open(rpc, { terminalId = DEFAULT_TERMINAL_ID, cols, rows, cwd, acknowledgeFirstUse }) {
    get().ensureSubscribed(rpc);
    set((state) => ({
      snapshots: {
        ...state.snapshots,
        [terminalId]: {
          ...(state.snapshots[terminalId] ?? idleSnapshot(terminalId)),
          status: "starting",
          errorMessage: null,
        },
      },
    }));
    try {
      const snapshot = await openTerminal(rpc, { terminalId, cols, rows, cwd, acknowledgeFirstUse });
      set((state) => ({
        snapshots: { ...state.snapshots, [terminalId]: snapshot },
      }));
    } catch (error) {
      set((state) => ({
        snapshots: {
          ...state.snapshots,
          [terminalId]: {
            ...(state.snapshots[terminalId] ?? idleSnapshot(terminalId)),
            status: "error",
            errorMessage: humanizeError(error),
          },
        },
      }));
      throw error;
    }
  },

  async write(rpc, { terminalId = DEFAULT_TERMINAL_ID, bytes }) {
    if (bytes.length === 0) return;
    await writeTerminal(rpc, { terminalId, bytes });
  },

  async resize(rpc, { terminalId = DEFAULT_TERMINAL_ID, cols, rows }) {
    set((state) => {
      const current = state.snapshots[terminalId] ?? idleSnapshot(terminalId);
      return {
        snapshots: { ...state.snapshots, [terminalId]: { ...current, cols, rows } },
      };
    });
    await resizeTerminal(rpc, { terminalId, cols, rows });
  },

  async clear(rpc, { terminalId = DEFAULT_TERMINAL_ID }) {
    await clearTerminalBuffer(rpc, { terminalId });
    set((state) => {
      const current = state.snapshots[terminalId];
      if (!current) return state;
      return {
        snapshots: { ...state.snapshots, [terminalId]: { ...current, historyBase64: "" } },
      };
    });
  },

  async close(rpc, { terminalId = DEFAULT_TERMINAL_ID }) {
    await closeTerminal(rpc, { terminalId });
    set((state) => {
      const current = state.snapshots[terminalId];
      if (!current) return state;
      return {
        snapshots: {
          ...state.snapshots,
          [terminalId]: { ...current, status: "closed", errorMessage: null },
        },
      };
    });
  },

  async refresh(rpc, { terminalId = DEFAULT_TERMINAL_ID }) {
    const snapshot = await readTerminalSnapshot(rpc, { terminalId });
    set((state) => ({ snapshots: { ...state.snapshots, [terminalId]: snapshot } }));
  },

  subscribeOutput(listener) {
    outputListeners.add(listener);
    return () => outputListeners.delete(listener);
  },

  reset() {
    set({ snapshots: {}, subscribed: false });
  },
}));

// ─── helpers ──────────────────────────────────────────────────

const MAX_HISTORY_BYTES = 200_000;

function appendHistory(historyBase64: string, additional: Uint8Array): string {
  const previous = historyBase64 ? base64Decode(historyBase64) : new Uint8Array(0);
  const combined = new Uint8Array(previous.length + additional.length);
  combined.set(previous, 0);
  combined.set(additional, previous.length);
  const trimmed =
    combined.length <= MAX_HISTORY_BYTES
      ? combined
      : combined.subarray(combined.length - MAX_HISTORY_BYTES);
  return base64Encode(trimmed);
}

function base64Encode(bytes: Uint8Array): string {
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

function idleSnapshot(terminalId: string): TerminalSnapshot {
  return {
    terminalId,
    instanceId: null,
    status: "idle",
    cols: 80,
    rows: 24,
    cwd: "",
    historyBase64: "",
    errorMessage: null,
    resizeSupported: true,
  };
}

function humanizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
