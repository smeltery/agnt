// Thread + chat coordinator. Owns one ThreadReducerState per thread and routes
// inbound JSON-RPC notifications into the pure reducer. Persistence to IndexedDB
// is debounced per thread so high-frequency streaming deltas don't thrash disk.
//
// This file is the only consumer of the protocol layer — UI components subscribe
// to slices via zustand selectors and never see Connection/JsonRpcClient.

import { create } from "zustand";
import { makeLogger } from "../lib/log";
import {
  type CodexMessage,
  type CodexThread,
  type ContextWindowUsage,
  extractContextWindowUsage,
  orderCounter,
} from "../models";
import type { Connection } from "../protocol";
import { fetchThreadTurnsPage } from "./pagination";
import { runPostHandshakeBootstrap, type ModelOption } from "./sync";
import {
  applyAgentDelta,
  applyItemCompleted,
  applyItemOutputDelta,
  applyItemStarted,
  applyLocalUserMessage,
  applyReasoningDelta,
  applyTurnCompleted,
  applyTurnFailed,
  applyTurnStarted,
  emptyThreadState,
  type ThreadReducerState,
} from "./turn-reducer";
import { messagesStore } from "../storage/messages-store";

const log = makeLogger("threads");
const PERSIST_DEBOUNCE_MS = 250;

export interface ThreadsState {
  threads: CodexThread[];
  archivedThreads: CodexThread[];
  models: ModelOption[];
  selectedThreadId: string | null;
  reducerStates: Record<string, ThreadReducerState>;
  contextUsageByThread: Record<string, ContextWindowUsage>;
  loading: boolean;
  error: string | null;
  hydrated: boolean;

  bindToConnection(connection: Connection): Promise<void>;
  hydrateFromDisk(): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  loadOlderTurns(threadId: string): Promise<void>;
  sendTurn(threadId: string, content: string): Promise<void>;
  stopTurn(): Promise<void>;
  reset(): void;
}

let activeConnection: Connection | null = null;
const teardownHandlers: Array<() => void> = [];
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useThreadsStore = create<ThreadsState>((set, get) => ({
  threads: [],
  archivedThreads: [],
  models: [],
  selectedThreadId: null,
  reducerStates: {},
  contextUsageByThread: {},
  loading: false,
  error: null,
  hydrated: false,

  async hydrateFromDisk() {
    if (get().hydrated) return;
    const max = await messagesStore.loadHighestOrderIndex();
    orderCounter.seedFrom(max);
    set({ hydrated: true });
  },

  async bindToConnection(connection) {
    while (teardownHandlers.length) teardownHandlers.pop()?.();
    activeConnection = connection;
    registerNotificationHandlers(connection, set, get);
    set({ loading: true, error: null });
    try {
      const snapshot = await runPostHandshakeBootstrap({
        rpc: connection.rpc,
        clientInfo: { name: "agnt-web", title: "agnt browser client", version: "0.0.1" },
      });
      set({
        threads: snapshot.threads,
        archivedThreads: snapshot.archivedThreads,
        models: snapshot.models,
        loading: false,
      });
    } catch (error) {
      log.warn("bootstrap failed", error);
      set({ loading: false, error: (error as Error).message });
    }
  },

  async selectThread(threadId) {
    set({ selectedThreadId: threadId });
    // Hydrate from disk first so the timeline paints instantly.
    const cached = await messagesStore.load(threadId);
    if (cached.length > 0) {
      mutateReducer(threadId, set, get, (state) => ({ ...state, messages: cached }));
    }
    await messagesStore.registerThread(threadId);
    await get().loadOlderTurns(threadId);
  },

  async loadOlderTurns(threadId) {
    if (!activeConnection?.rpc) return;
    try {
      const page = await fetchThreadTurnsPage({ rpc: activeConnection.rpc, threadId, limit: 20 });
      // The bridge returns turns containing items; we hydrate visible rows by
      // replaying item/started + item/completed events through the reducer so
      // the same state-machine that handles live streaming also handles history.
      const events = flattenTurnsToEvents(page.turns, threadId);
      mutateReducer(threadId, set, get, (state) => events.reduce(applyHistoryEvent, state));
      schedulePersist(threadId, get);
    } catch (error) {
      log.warn("loadOlderTurns failed", error);
      set({ error: (error as Error).message });
    }
  },

  async sendTurn(threadId, content) {
    if (!activeConnection?.rpc) return;
    mutateReducer(threadId, set, get, (state) => applyLocalUserMessage(state, threadId, content));
    schedulePersist(threadId, get);
    try {
      await activeConnection.rpc.request("turn/start", { threadId, content });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  async stopTurn() {
    const threadId = get().selectedThreadId;
    if (!threadId || !activeConnection?.rpc) return;
    const reducerState = get().reducerStates[threadId];
    const turnId = reducerState?.activeTurnId;
    if (!turnId) return;
    try {
      await activeConnection.rpc.request("turn/interrupt", { threadId, turnId });
    } catch (error) {
      log.warn("turn/interrupt failed", error);
    }
  },

  reset() {
    while (teardownHandlers.length) teardownHandlers.pop()?.();
    activeConnection = null;
    set({
      threads: [],
      archivedThreads: [],
      models: [],
      selectedThreadId: null,
      reducerStates: {},
      contextUsageByThread: {},
      loading: false,
      error: null,
    });
  },
}));

// ─── Notification routing ─────────────────────────────────────────────────────

function registerNotificationHandlers(
  connection: Connection,
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState
): void {
  // Lifecycle.
  on(connection, "turn/started", (params) => withTurnEvent(params, (event) => mutateReducer(event.threadId, set, get, (s) => applyTurnStarted(s, event))));
  on(connection, "turn/completed", (params) => withTurnEvent(params, (event) => mutateReducer(event.threadId, set, get, (s) => applyTurnCompleted(s, event))));
  on(connection, "turn/failed", (params) => withTurnEvent(params, (event) => {
    const errorText = readString(params, "error", "message");
    mutateReducer(event.threadId, set, get, (s) => applyTurnFailed(s, event, errorText));
  }));

  // Streaming deltas.
  on(connection, "item/agentMessage/delta", (params) =>
    withTurnEvent(params, (event) => {
      const delta = readString(params, "delta") ?? "";
      const phase = readString(params, "phase");
      mutateReducer(event.threadId, set, get, (s) =>
        applyAgentDelta(s, { ...event, delta, assistantPhase: phase })
      );
      schedulePersist(event.threadId, get);
    })
  );
  // Codex emits the same event under two legacy aliases; route both to the same handler.
  on(connection, "codex/event/agent_message_delta", (params) =>
    withTurnEvent(params, (event) => {
      const delta = readString(params, "delta", "text") ?? "";
      mutateReducer(event.threadId, set, get, (s) => applyAgentDelta(s, { ...event, delta }));
      schedulePersist(event.threadId, get);
    })
  );
  on(connection, "item/reasoning/textDelta", (params) =>
    withTurnEvent(params, (event) => {
      const delta = readString(params, "delta", "textDelta") ?? "";
      mutateReducer(event.threadId, set, get, (s) => applyReasoningDelta(s, { ...event, delta }));
      schedulePersist(event.threadId, get);
    })
  );
  on(connection, "item/toolCall/outputDelta", (params) => routeOutputDelta(params, set, get));
  on(connection, "item/commandExecution/outputDelta", (params) => routeOutputDelta(params, set, get));
  on(connection, "item/fileChange/outputDelta", (params) => routeOutputDelta(params, set, get));

  // Item lifecycle.
  on(connection, "item/started", (params) => {
    withTurnEvent(params, (event) => {
      const type = readString(params, "type");
      const role = readString(params, "role");
      const phase = readString(params, "phase");
      mutateReducer(event.threadId, set, get, (s) => applyItemStarted(s, { ...event, type, role, assistantPhase: phase }));
    });
  });
  on(connection, "item/completed", (params) => {
    withTurnEvent(params, (event) => {
      const type = readString(params, "type");
      const text = readString(params, "text", "message");
      mutateReducer(event.threadId, set, get, (s) => applyItemCompleted(s, { ...event, type, text }));
      schedulePersist(event.threadId, get);
    });
  });

  // Threads metadata.
  on(connection, "thread/started", (params) => {
    const threadId = readString(params, "threadId");
    if (!threadId) return;
    set({});  // touch for selector recomputation; refreshThreads pulls full data on next sync tick
  });
  on(connection, "thread/tokenUsage/updated", (params) => {
    const threadId = readString(params, "threadId");
    if (!threadId) return;
    const usage = extractContextWindowUsage(params);
    if (!usage) return;
    set({ contextUsageByThread: { ...get().contextUsageByThread, [threadId]: usage } });
  });
}

function on(connection: Connection, method: string, handler: (params: unknown) => void): void {
  teardownHandlers.push(connection.rpc.onNotification(method, handler));
}

function routeOutputDelta(
  params: unknown,
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState
): void {
  withTurnEvent(params, (event) => {
    const delta = readString(params, "delta", "textDelta") ?? "";
    if (!delta) return;
    mutateReducer(event.threadId, set, get, (s) => applyItemOutputDelta(s, { ...event, delta }));
    schedulePersist(event.threadId, get);
  });
}

// ─── Reducer plumbing ─────────────────────────────────────────────────────────

function mutateReducer(
  threadId: string,
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState,
  mutator: (state: ThreadReducerState) => ThreadReducerState
): void {
  const existing = get().reducerStates[threadId] ?? emptyThreadState();
  const next = mutator(existing);
  if (next === existing) return;
  set({ reducerStates: { ...get().reducerStates, [threadId]: next } });
}

function schedulePersist(threadId: string, get: () => ThreadsState): void {
  if (typeof window === "undefined") return; // tests run in node
  const existingTimer = persistTimers.get(threadId);
  if (existingTimer) clearTimeout(existingTimer);
  persistTimers.set(
    threadId,
    setTimeout(() => {
      persistTimers.delete(threadId);
      const messages = get().reducerStates[threadId]?.messages ?? [];
      void messagesStore.save(threadId, messages);
      void messagesStore.registerThread(threadId);
    }, PERSIST_DEBOUNCE_MS)
  );
}

// ─── Param decoding helpers ───────────────────────────────────────────────────

interface TurnEventBase {
  threadId: string;
  turnId?: string;
  itemId?: string;
}

function withTurnEvent(params: unknown, run: (event: TurnEventBase) => void): void {
  const threadId = readString(params, "threadId");
  if (!threadId) return;
  const turnId = readString(params, "turnId");
  const itemId = readString(params, "itemId");
  run({ threadId, turnId, itemId });
}

function readString(params: unknown, ...keys: string[]): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  for (const key of keys) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

// ─── History → reducer-event adapter ──────────────────────────────────────────
//
// thread/turns/list returns whole turns. We replay them through the same reducer
// the live-streaming path uses by emitting synthetic item/started + item/completed
// events. This guarantees the on-disk timeline shape is identical to what's
// rendered live — there is no separate "history merge" code path to keep in sync.

interface SyntheticEvent {
  kind: "started" | "completed";
  params: Record<string, unknown>;
}

function flattenTurnsToEvents(turns: unknown[], threadId: string): SyntheticEvent[] {
  const events: SyntheticEvent[] = [];
  // Bridge sends turns newest-first; replay them oldest-first so orderIndex
  // is monotonic. Items inside a turn keep their natural order.
  const ordered = [...turns].reverse();
  for (const turnUnknown of ordered) {
    const turn = turnUnknown as Record<string, unknown>;
    const turnId = (turn.id as string | undefined) ?? (turn.turnId as string | undefined);
    const items = (turn.items as unknown[]) ?? (turn.events as unknown[]) ?? [];
    for (const itemUnknown of items) {
      const item = itemUnknown as Record<string, unknown>;
      const baseParams: Record<string, unknown> = {
        threadId,
        turnId,
        itemId: item.id ?? item.itemId,
        type: item.type,
        role: item.role,
      };
      events.push({ kind: "started", params: baseParams });
      events.push({
        kind: "completed",
        params: { ...baseParams, text: item.text ?? item.message },
      });
    }
  }
  return events;
}

function applyHistoryEvent(state: ThreadReducerState, event: SyntheticEvent): ThreadReducerState {
  const baseEvent = {
    threadId: event.params.threadId as string,
    turnId: event.params.turnId as string | undefined,
    itemId: event.params.itemId as string | undefined,
  };
  if (event.kind === "started") {
    return applyItemStarted(state, {
      ...baseEvent,
      type: event.params.type as string | undefined,
      role: event.params.role as string | undefined,
    });
  }
  return applyItemCompleted(state, {
    ...baseEvent,
    type: event.params.type as string | undefined,
    text: event.params.text as string | undefined,
  });
}

// Public read selector: get the (sorted) message list for the currently-selected thread.
export function selectActiveMessages(state: ThreadsState): CodexMessage[] {
  if (!state.selectedThreadId) return [];
  return state.reducerStates[state.selectedThreadId]?.messages ?? [];
}

export function selectActiveTurnRunning(state: ThreadsState): boolean {
  if (!state.selectedThreadId) return false;
  return Boolean(state.reducerStates[state.selectedThreadId]?.activeTurnId);
}
