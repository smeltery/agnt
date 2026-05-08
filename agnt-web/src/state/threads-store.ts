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
  decodePlanSteps,
  extractContextWindowUsage,
  normalizeThread,
  orderCounter,
} from "../models";
import type { Connection } from "../protocol";
import { useAccountStore } from "./account-store";
import { buildApprovalServerRequestHandler, useApprovalsStore } from "./approvals-store";
import { useGitStore } from "./git-store";
import { useNoticesStore } from "./notices-store";
import { fetchThreadTurnsPage } from "./pagination";
import { buildStructuredInputServerRequestHandler, useStructuredInputStore } from "./structured-input-store";
import { runPostHandshakeBootstrap, type ModelOption } from "./sync";
import { useVoiceStore } from "./voice-store";
import {
  applyAgentDelta,
  applyItemCompleted,
  applyItemOutputDelta,
  applyItemStarted,
  applyLocalUserMessage,
  applyPlanDelta,
  applyPlanUpdated,
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

export type ReasoningEffort = "low" | "medium" | "high";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface TurnFlags {
  /** Selected provider model id (subset of state.models). Undefined = bridge default. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Claude-only: passes through as `params.permissionMode`. */
  permissionMode?: PermissionMode;
  /** Codex-only: requests plan-mode for this turn. */
  planMode?: boolean;
}

export interface ThreadsState {
  threads: CodexThread[];
  archivedThreads: CodexThread[];
  models: ModelOption[];
  selectedThreadId: string | null;
  reducerStates: Record<string, ThreadReducerState>;
  contextUsageByThread: Record<string, ContextWindowUsage>;
  turnFlags: TurnFlags;
  loading: boolean;
  error: string | null;
  hydrated: boolean;

  bindToConnection(connection: Connection): Promise<void>;
  hydrateFromDisk(): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  loadOlderTurns(threadId: string): Promise<void>;
  sendTurn(threadId: string, content: string): Promise<void>;
  stopTurn(): Promise<void>;
  patchTurnFlags(patch: Partial<TurnFlags>): void;
  forkThread(sourceThreadId: string): Promise<string | null>;
  renameThread(threadId: string, name: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<void>;
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
  turnFlags: {},
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
    useApprovalsStore.getState().clearAll();
    useStructuredInputStore.getState().clearAll();
    useGitStore.getState().reset();
    useAccountStore.getState().bind(connection);
    useVoiceStore.getState().bind(connection);
    activeConnection = connection;
    registerNotificationHandlers(connection, set, get);
    registerServerRequestHandlers(connection);
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
    const flags = get().turnFlags;
    const params: Record<string, unknown> = { threadId, content };
    if (flags.model) params.model = flags.model;
    if (flags.reasoningEffort) params.reasoningEffort = flags.reasoningEffort;
    if (flags.permissionMode) params.permissionMode = flags.permissionMode;
    if (flags.planMode) params.planMode = true;
    try {
      await activeConnection.rpc.request("turn/start", params);
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  patchTurnFlags(patch) {
    set({ turnFlags: { ...get().turnFlags, ...patch } });
  },

  async forkThread(sourceThreadId) {
    if (!activeConnection?.rpc) return null;
    try {
      const response = await activeConnection.rpc.request<{ threadId?: string; thread?: { id?: string } }>(
        "thread/fork",
        { threadId: sourceThreadId }
      );
      const newThreadId = response.threadId ?? response.thread?.id;
      if (!newThreadId) return null;
      // Refresh the live thread list so the new thread appears in the sidebar.
      void refreshLiveThreads(set, get);
      await get().selectThread(newThreadId);
      return newThreadId;
    } catch (error) {
      set({ error: (error as Error).message });
      return null;
    }
  },

  async renameThread(threadId, name) {
    if (!activeConnection?.rpc) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await activeConnection.rpc.request("thread/name/set", { threadId, name: trimmed });
      patchThreadName(set, get, threadId, trimmed);
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  async archiveThread(threadId) {
    if (!activeConnection?.rpc) return;
    try {
      await activeConnection.rpc.request("thread/archive", { threadId });
      moveThreadBetweenLists(set, get, threadId, "archive");
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  async unarchiveThread(threadId) {
    if (!activeConnection?.rpc) return;
    try {
      await activeConnection.rpc.request("thread/unarchive", { threadId });
      moveThreadBetweenLists(set, get, threadId, "unarchive");
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
  on(connection, "thread/name/updated", (params) => {
    const threadId = readString(params, "threadId");
    const name = readString(params, "name");
    if (!threadId || !name) return;
    patchThreadName(set, get, threadId, name);
  });
  on(connection, "thread/tokenUsage/updated", (params) => {
    const threadId = readString(params, "threadId");
    if (!threadId) return;
    const usage = extractContextWindowUsage(params);
    if (!usage) return;
    set({ contextUsageByThread: { ...get().contextUsageByThread, [threadId]: usage } });
  });

  // Plan mode.
  on(connection, "turn/plan/updated", (params) =>
    withTurnEvent(params, (event) => {
      const explanation = readString(params, "explanation");
      const steps = decodePlanSteps((params as Record<string, unknown> | undefined)?.plan);
      mutateReducer(event.threadId, set, get, (s) => applyPlanUpdated(s, { ...event, explanation, steps }));
    })
  );
  on(connection, "item/plan/delta", (params) =>
    withTurnEvent(params, (event) => {
      const delta = readString(params, "delta") ?? "";
      mutateReducer(event.threadId, set, get, (s) => applyPlanDelta(s, { ...event, delta }));
      schedulePersist(event.threadId, get);
    })
  );

  // System notices (e.g. opencode tui.toast.show).
  on(connection, "system/notice", (params) => {
    if (!params || typeof params !== "object") return;
    const obj = params as Record<string, unknown>;
    useNoticesStore.getState().enqueue({
      severity: typeof obj.severity === "string" ? obj.severity : undefined,
      title: typeof obj.title === "string" ? obj.title : undefined,
      message: typeof obj.message === "string" ? obj.message : undefined,
      provider: typeof obj.provider === "string" ? obj.provider : undefined,
      threadId: typeof obj.threadId === "string" ? obj.threadId : undefined,
      durationMs: typeof obj.durationMs === "number" ? obj.durationMs : undefined,
    });
  });
}

function registerServerRequestHandlers(connection: Connection): void {
  // Server-initiated approval flows. The bridge can send any of:
  //   item/commandExecution/requestApproval, item/fileChange/requestApproval,
  //   item/...requestApproval. We register the handler under each name we know
  //   the providers emit; unknown shapes get a "decline" reply.
  const approvalHandler = buildApprovalServerRequestHandler();
  for (const name of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
    teardownHandlers.push(connection.rpc.onServerRequest(name, (params) => approvalHandler(params, name)));
  }

  // Structured user-input prompts. Provider can emit either short or namespaced form.
  const inputHandler = buildStructuredInputServerRequestHandler();
  for (const name of ["tool/requestUserInput", "item/tool/requestUserInput"]) {
    teardownHandlers.push(connection.rpc.onServerRequest(name, inputHandler));
  }
}

// Surgical patch of the locally-cached thread name so the sidebar updates
// without a full thread/list round-trip; the bridge will broadcast
// thread/name/updated which will reconcile if the optimistic edit drifted.
function patchThreadName(
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState,
  threadId: string,
  name: string
): void {
  set({
    threads: get().threads.map((thread) => (thread.id === threadId ? { ...thread, name } : thread)),
    archivedThreads: get().archivedThreads.map((thread) =>
      thread.id === threadId ? { ...thread, name } : thread
    ),
  });
}

function moveThreadBetweenLists(
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState,
  threadId: string,
  direction: "archive" | "unarchive"
): void {
  if (direction === "archive") {
    const target = get().threads.find((t) => t.id === threadId);
    if (!target) return;
    set({
      threads: get().threads.filter((t) => t.id !== threadId),
      archivedThreads: [{ ...target, syncState: "archivedLocal" }, ...get().archivedThreads],
      selectedThreadId: get().selectedThreadId === threadId ? null : get().selectedThreadId,
    });
    return;
  }
  const target = get().archivedThreads.find((t) => t.id === threadId);
  if (!target) return;
  set({
    archivedThreads: get().archivedThreads.filter((t) => t.id !== threadId),
    threads: [{ ...target, syncState: "live" }, ...get().threads],
  });
}

async function refreshLiveThreads(
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState
): Promise<void> {
  if (!activeConnection?.rpc) return;
  try {
    const result = await activeConnection.rpc.request<{ data?: unknown[]; items?: unknown[]; threads?: unknown[] }>(
      "thread/list",
      { limit: 50, archived: false }
    );
    const raw = result.data ?? result.items ?? result.threads ?? [];
    const threads = raw
      .map((t) => normalizeThread(t as Record<string, unknown>, { syncState: "live" }))
      .filter((t): t is CodexThread => t !== null);
    set({ threads });
  } catch (error) {
    log.warn("refreshLiveThreads failed", error);
    void get; // silence unused
  }
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
