// Threads + active turn state. Faithful port of the slice of CodexService that the
// minimum viable web client needs: list threads, open a thread, send a turn, stream
// assistant deltas, stop a turn. Not a full port — see PARITY.md for what's missing.

import { create } from "zustand";
import type { Connection } from "../protocol";
import { makeLogger } from "../lib/log";

const log = makeLogger("threads");

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt?: number;
}

export type AssistantStreamRow =
  | { kind: "user"; itemId: string; text: string }
  | { kind: "assistant"; itemId: string; text: string }
  | { kind: "reasoning"; itemId: string; text: string }
  | { kind: "tool"; itemId: string; name: string; status: "started" | "completed" | "failed"; details?: string };

export interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  rows: AssistantStreamRow[];
  status: "running" | "completed" | "failed";
}

interface ThreadsState {
  threads: ThreadSummary[];
  selectedThreadId: string | null;
  activeTurn: ActiveTurn | null;
  loading: boolean;
  error: string | null;
  bindToConnection(connection: Connection): void;
  refreshThreads(): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  sendTurn(threadId: string, content: string): Promise<void>;
  stopTurn(): Promise<void>;
}

let activeConnection: Connection | null = null;
const teardownHandlers: Array<() => void> = [];

export const useThreadsStore = create<ThreadsState>((set, get) => ({
  threads: [],
  selectedThreadId: null,
  activeTurn: null,
  loading: false,
  error: null,

  bindToConnection(connection) {
    while (teardownHandlers.length) teardownHandlers.pop()?.();
    activeConnection = connection;
    teardownHandlers.push(
      connection.rpc.onNotification("turn/started", (params) => {
        const p = params as { threadId?: string; turnId?: string };
        if (!p?.threadId) return;
        set({
          activeTurn: {
            threadId: p.threadId,
            turnId: p.turnId ?? null,
            rows: get().activeTurn?.threadId === p.threadId ? get().activeTurn?.rows ?? [] : [],
            status: "running",
          },
        });
      })
    );
    teardownHandlers.push(
      connection.rpc.onNotification("turn/completed", () => {
        const turn = get().activeTurn;
        if (!turn) return;
        set({ activeTurn: { ...turn, status: "completed" } });
      })
    );
    teardownHandlers.push(
      connection.rpc.onNotification("turn/failed", (params) => {
        const turn = get().activeTurn;
        const message = (params as { error?: string })?.error ?? "Turn failed";
        if (turn) set({ activeTurn: { ...turn, status: "failed" } });
        set({ error: message });
      })
    );
    teardownHandlers.push(connection.rpc.onNotification("item/started", (params) => mergeItem(params, "started", set, get)));
    teardownHandlers.push(connection.rpc.onNotification("item/updated", (params) => mergeItem(params, "updated", set, get)));
    teardownHandlers.push(connection.rpc.onNotification("item/completed", (params) => mergeItem(params, "completed", set, get)));

    void get().refreshThreads();
  },

  async refreshThreads() {
    if (!activeConnection?.rpc) return;
    set({ loading: true, error: null });
    try {
      const result = await activeConnection.rpc.request<{ data?: ThreadSummary[]; threads?: ThreadSummary[] }>("thread/list", {
        limit: 100,
      });
      const list = result.data ?? result.threads ?? [];
      set({ threads: list, loading: false });
    } catch (error) {
      log.warn("thread/list failed", error);
      set({ error: (error as Error).message, loading: false });
    }
  },

  async selectThread(threadId) {
    if (!activeConnection?.rpc) return;
    set({ selectedThreadId: threadId, activeTurn: { threadId, turnId: null, rows: [], status: "completed" } });
    try {
      const result = await activeConnection.rpc.request<{ turns?: Array<{ id: string; rows?: AssistantStreamRow[] }> }>(
        "thread/read",
        { threadId, includeTurns: true }
      );
      const rows = (result.turns ?? []).flatMap((turn) => turn.rows ?? []);
      set({ activeTurn: { threadId, turnId: null, rows, status: "completed" } });
    } catch (error) {
      log.warn("thread/read failed", error);
      set({ error: (error as Error).message });
    }
  },

  async sendTurn(threadId, content) {
    if (!activeConnection?.rpc) return;
    const turn = get().activeTurn ?? { threadId, turnId: null, rows: [], status: "running" as const };
    set({
      activeTurn: {
        ...turn,
        threadId,
        rows: [...turn.rows, { kind: "user", itemId: `local-${Date.now()}`, text: content }],
        status: "running",
      },
    });
    try {
      await activeConnection.rpc.request("turn/start", { threadId, content });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  async stopTurn() {
    const turn = get().activeTurn;
    if (!turn?.turnId || !activeConnection?.rpc) return;
    try {
      await activeConnection.rpc.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId });
    } catch (error) {
      log.warn("turn/interrupt failed", error);
    }
  },
}));

function mergeItem(
  params: unknown,
  phase: "started" | "updated" | "completed",
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState
): void {
  const turn = get().activeTurn;
  if (!turn) return;
  const p = params as { itemId?: string; type?: string; text?: string; reasoning?: string; toolName?: string; status?: string };
  if (!p?.itemId) return;

  const existing = turn.rows.findIndex((row) => row.itemId === p.itemId);
  let next = [...turn.rows];

  const row = buildRow(p, phase);
  if (!row) return;

  if (existing >= 0) next[existing] = mergeRows(next[existing], row);
  else next = [...next, row];

  set({ activeTurn: { ...turn, rows: next } });
}

function buildRow(
  p: { itemId?: string; type?: string; text?: string; reasoning?: string; toolName?: string; status?: string },
  phase: "started" | "updated" | "completed"
): AssistantStreamRow | null {
  if (!p.itemId) return null;
  if (typeof p.text === "string" && p.text.length > 0) return { kind: "assistant", itemId: p.itemId, text: p.text };
  if (typeof p.reasoning === "string" && p.reasoning.length > 0) return { kind: "reasoning", itemId: p.itemId, text: p.reasoning };
  if (p.toolName) {
    return {
      kind: "tool",
      itemId: p.itemId,
      name: p.toolName,
      status: phase === "completed" ? "completed" : "started",
      details: typeof p.status === "string" ? p.status : undefined,
    };
  }
  return null;
}

function mergeRows(existing: AssistantStreamRow, incoming: AssistantStreamRow): AssistantStreamRow {
  if (existing.kind !== incoming.kind) return incoming;
  if (existing.kind === "assistant" && incoming.kind === "assistant") {
    return { ...existing, text: incoming.text };
  }
  if (existing.kind === "reasoning" && incoming.kind === "reasoning") {
    return { ...existing, text: incoming.text };
  }
  if (existing.kind === "tool" && incoming.kind === "tool") {
    return { ...existing, ...incoming };
  }
  return incoming;
}
