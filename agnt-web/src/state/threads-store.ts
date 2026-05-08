// Thread + chat coordinator. Owns one ThreadReducerState per thread and routes
// inbound JSON-RPC notifications into the pure reducer. Persistence to IndexedDB
// is debounced per thread so high-frequency streaming deltas don't thrash disk.
//
// This file is the only consumer of the protocol layer — UI components subscribe
// to slices via zustand selectors and never see Connection/JsonRpcClient.

import { create } from "zustand";
import { flashTitle } from "../lib/document-title";
import { makeLogger } from "../lib/log";
import { showNotification, shouldNotify } from "../lib/notifications";
import {
  type CodexMessage,
  type CodexThread,
  type ContextWindowUsage,
  createMessage,
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
import { useStreamingStatsStore } from "./streaming-stats-store";
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
import { prefsStore } from "../storage/prefs-store";
import { buildTurnInput } from "./turn-input";
import type { ImageAttachment } from "../models";

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
  /** Threads with a running turn — derived from `thread/status/changed` notifications. */
  runningThreadIds: Set<string>;
  /** Pinned threads sort to the top of the live tab in the sidebar. Persisted. */
  pinnedThreadIds: Set<string>;
  /** Per-thread last-visit timestamp. A thread shows an unread dot when its
   *  `updatedAt` exceeds this. Persisted via `prefsStore.saveLastVisited`. */
  lastVisitedByThread: Record<string, number>;
  loading: boolean;
  error: string | null;
  hydrated: boolean;

  bindToConnection(connection: Connection): Promise<void>;
  hydrateFromDisk(): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  loadOlderTurns(threadId: string): Promise<void>;
  sendTurn(threadId: string, content: string, attachments?: ImageAttachment[]): Promise<void>;
  /** Re-issues turn/start with the inputs of a failed turn. Returns whether a retry actually fired. */
  retryFailedTurn(threadId: string, failedTurnId: string): Promise<boolean>;
  startNewThread(input: { content: string; cwd?: string; attachments?: ImageAttachment[] }): Promise<string | null>;
  stopTurn(): Promise<void>;
  patchTurnFlags(patch: Partial<TurnFlags>): void;
  forkThread(sourceThreadId: string): Promise<string | null>;
  renameThread(threadId: string, name: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<void>;
  compactThread(threadId: string): Promise<boolean>;
  togglePinThread(threadId: string): Promise<void>;
  /** Replace the pinned-thread ordering with the given list (pin order = list order). */
  reorderPinnedThreads(orderedIds: string[]): Promise<void>;
  /** Force the unread dot back on by clearing the recorded last-visit time. */
  markThreadUnread(threadId: string): Promise<void>;
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
  runningThreadIds: new Set(),
  pinnedThreadIds: new Set(),
  lastVisitedByThread: {},
  loading: false,
  error: null,
  hydrated: false,

  async hydrateFromDisk() {
    if (get().hydrated) return;
    const [max, persistedFlags, pinnedIds, lastVisited] = await Promise.all([
      messagesStore.loadHighestOrderIndex(),
      prefsStore.loadTurnFlags(),
      prefsStore.loadPinnedThreadIds(),
      prefsStore.loadLastVisited(),
    ]);
    orderCounter.seedFrom(max);
    // Cast through the looser persisted shape — anything malformed (an old
    // schema) just falls back to the empty default.
    set({
      hydrated: true,
      turnFlags: {
        model: persistedFlags.model,
        reasoningEffort: persistedFlags.reasoningEffort as TurnFlags["reasoningEffort"],
        permissionMode: persistedFlags.permissionMode as TurnFlags["permissionMode"],
        planMode: persistedFlags.planMode,
      },
      pinnedThreadIds: new Set(pinnedIds),
      lastVisitedByThread: lastVisited,
    });
  },

  async togglePinThread(threadId) {
    if (!threadId) return;
    const next = new Set(get().pinnedThreadIds);
    if (next.has(threadId)) next.delete(threadId);
    else next.add(threadId);
    set({ pinnedThreadIds: next });
    void prefsStore.savePinnedThreadIds([...next]);
  },

  async markThreadUnread(threadId) {
    if (!threadId) return;
    const next = { ...get().lastVisitedByThread };
    // Drop the entry rather than write 0 — the unread predicate already
    // treats "no recorded visit" as unread, and a missing key keeps the
    // persisted blob smaller as users mark/unmark over time.
    delete next[threadId];
    set({ lastVisitedByThread: next });
    void prefsStore.saveLastVisited(next);
  },

  async reorderPinnedThreads(orderedIds) {
    // The Set's iteration order is the pin order — rebuilding it from the
    // caller's array is the whole reorder. We filter against the existing
    // membership so a stale drag-source can't accidentally promote a
    // non-pinned thread, and append any pins missing from the input so a
    // partial reorder doesn't drop pins on the floor.
    const current = get().pinnedThreadIds;
    const filtered = orderedIds.filter((id) => current.has(id));
    for (const id of current) {
      if (!filtered.includes(id)) filtered.push(id);
    }
    const next = new Set(filtered);
    set({ pinnedThreadIds: next });
    void prefsStore.savePinnedThreadIds(filtered);
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
    // Stamp the visit so the unread dot disappears. We bump the timestamp to
    // *now* rather than thread.updatedAt — a turn that completes while we're
    // already viewing the thread shouldn't immediately re-mark it unread.
    const nextVisited = { ...get().lastVisitedByThread, [threadId]: Date.now() };
    set({ selectedThreadId: threadId, lastVisitedByThread: nextVisited });
    void prefsStore.saveLastVisited(nextVisited);
    // Hydrate from disk first so the timeline paints instantly.
    const cached = await messagesStore.load(threadId);
    if (cached.length > 0) {
      mutateReducer(threadId, set, get, (state) => ({ ...state, messages: cached }));
    }
    await messagesStore.registerThread(threadId);
    // Pull a fresh context-window snapshot so the bar renders before the next
    // turn fires the push notification. Best-effort — silently no-ops if the
    // bridge doesn't expose this for the active provider.
    void fetchContextWindowSnapshot(threadId, set, get);
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

  async sendTurn(threadId, content, attachments) {
    if (!activeConnection?.rpc) return;
    mutateReducer(threadId, set, get, (state) =>
      applyLocalUserMessage(state, threadId, content, { attachments })
    );
    schedulePersist(threadId, get);
    const input = buildTurnInput(content, attachments);
    if (input.length === 0) return;
    const flags = get().turnFlags;
    // Bridge translators read `params.input` exclusively. Keeping `content`
    // alongside as a courtesy for any future provider that might want a
    // pre-flattened string (no current provider does).
    const params: Record<string, unknown> = { threadId, input, content };
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

  async retryFailedTurn(threadId, failedTurnId) {
    if (!activeConnection?.rpc) return false;
    // Recover the original user input from the message log. The local-insert
    // path that powers sendTurn already preserved the user row with the same
    // turnId, so we walk backward to find the most recent matching one.
    const reducer = get().reducerStates[threadId];
    if (!reducer) return false;
    const userMessage = [...reducer.messages].reverse().find(
      (message) => message.role === "user" && message.turnId === failedTurnId
    );
    if (!userMessage) return false;
    const content = userMessage.text ?? "";
    const attachments = userMessage.attachments;
    const input = buildTurnInput(content, attachments);
    if (input.length === 0) return false;
    const flags = get().turnFlags;
    const params: Record<string, unknown> = { threadId, input, content };
    if (flags.model) params.model = flags.model;
    if (flags.reasoningEffort) params.reasoningEffort = flags.reasoningEffort;
    if (flags.permissionMode) params.permissionMode = flags.permissionMode;
    if (flags.planMode) params.planMode = true;
    try {
      await activeConnection.rpc.request("turn/start", params);
      return true;
    } catch (error) {
      set({ error: (error as Error).message });
      return false;
    }
  },

  patchTurnFlags(patch) {
    const next = { ...get().turnFlags, ...patch };
    set({ turnFlags: next });
    // Persist async, debounced through the timer pool we already use for
    // messages. This is a tiny write so we don't bother debouncing further.
    void prefsStore.saveTurnFlags({
      model: next.model,
      reasoningEffort: next.reasoningEffort,
      permissionMode: next.permissionMode,
      planMode: next.planMode,
    });
  },

  async startNewThread(input) {
    if (!activeConnection?.rpc) return null;
    const { content, cwd, attachments } = input;
    const turnInput = buildTurnInput(content, attachments);
    if (turnInput.length === 0) return null;
    const flags = get().turnFlags;
    const params: Record<string, unknown> = { content, input: turnInput };
    if (cwd) params.cwd = cwd;
    if (flags.model) params.model = flags.model;
    if (flags.reasoningEffort) params.reasoningEffort = flags.reasoningEffort;
    if (flags.permissionMode) params.permissionMode = flags.permissionMode;
    if (flags.planMode) params.planMode = true;
    try {
      const response = await activeConnection.rpc.request<{ threadId?: string; thread?: { id?: string } }>(
        "thread/start",
        params
      );
      const threadId = response.threadId ?? response.thread?.id;
      if (!threadId) return null;
      // Refresh sidebar + select; the thread/started notification will also
      // fire but the sidebar pulls from thread/list, not from notifications.
      await refreshLiveThreads(set, get);
      await get().selectThread(threadId);
      // Auto-title after a short delay so the bridge has the first turn's
      // content to summarize. Best-effort: failures are logged and ignored.
      scheduleAutoTitle(threadId, set, get);
      return threadId;
    } catch (error) {
      set({ error: (error as Error).message });
      return null;
    }
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

  async compactThread(threadId) {
    if (!activeConnection?.rpc) return false;
    try {
      // Bridge handles the actual summarization + thread/turns/list
      // re-emission. Once it returns, refresh the local turn cache so the
      // compacted view is live without a thread switch.
      await activeConnection.rpc.request("thread/compact/start", { threadId });
      await get().loadOlderTurns(threadId);
      useNoticesStore.getState().enqueue({
        severity: "info",
        title: "Thread compacted",
        message: "Older turns were summarized to save context.",
      });
      return true;
    } catch (error) {
      const message = (error as { code?: number; message?: string }).code === -32601
        ? "This provider doesn't support thread compaction."
        : (error as Error).message;
      set({ error: message });
      return false;
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
    useStreamingStatsStore.setState({ byThread: {} });
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
  on(connection, "turn/started", (params) => withTurnEvent(params, (event) => {
    mutateReducer(event.threadId, set, get, (s) => applyTurnStarted(s, event));
    useStreamingStatsStore.getState().noteTurnStarted(event.threadId);
  }));
  on(connection, "turn/completed", (params) =>
    withTurnEvent(params, (event) => {
      mutateReducer(event.threadId, set, get, (s) => applyTurnCompleted(s, event));
      useStreamingStatsStore.getState().noteTurnFinished(event.threadId);
      bumpVisitIfActive(event.threadId, set, get);
      // Two layered "tab is hidden" signals: a desktop notification when the
      // user has granted permission and opted in, plus the title flash as a
      // permission-free fallback. Both no-op when the tab is focused.
      void notifyTurnFinished(event.threadId, get, "completed");
      flashTitle("Turn done");
    })
  );
  on(connection, "turn/failed", (params) =>
    withTurnEvent(params, (event) => {
      const errorText = readString(params, "error", "message");
      mutateReducer(event.threadId, set, get, (s) => applyTurnFailed(s, event, errorText));
      useStreamingStatsStore.getState().noteTurnFinished(event.threadId);
      bumpVisitIfActive(event.threadId, set, get);
      void notifyTurnFinished(event.threadId, get, "failed", errorText);
      flashTitle("Turn failed");
    })
  );

  // Streaming deltas.
  on(connection, "item/agentMessage/delta", (params) =>
    withTurnEvent(params, (event) => {
      const delta = readString(params, "delta") ?? "";
      const phase = readString(params, "phase");
      mutateReducer(event.threadId, set, get, (s) =>
        applyAgentDelta(s, { ...event, delta, assistantPhase: phase })
      );
      useStreamingStatsStore.getState().noteDelta(event.threadId, delta.length);
      schedulePersist(event.threadId, get);
    })
  );
  // Codex emits the same event under two legacy aliases; route both to the same handler.
  on(connection, "codex/event/agent_message_delta", (params) =>
    withTurnEvent(params, (event) => {
      const delta = readString(params, "delta", "text") ?? "";
      mutateReducer(event.threadId, set, get, (s) => applyAgentDelta(s, { ...event, delta }));
      useStreamingStatsStore.getState().noteDelta(event.threadId, delta.length);
      schedulePersist(event.threadId, get);
    })
  );
  on(connection, "item/reasoning/textDelta", (params) =>
    withTurnEvent(params, (event) => {
      const delta = readString(params, "delta", "textDelta") ?? "";
      mutateReducer(event.threadId, set, get, (s) => applyReasoningDelta(s, { ...event, delta }));
      useStreamingStatsStore.getState().noteDelta(event.threadId, delta.length);
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
  // thread/status/changed lets the sidebar show a running indicator on
  // non-active threads. Bridge emits "running" / "idle" / terminal labels —
  // we treat anything that isn't terminal as running.
  on(connection, "thread/status/changed", (params) => {
    const threadId = readString(params, "threadId");
    const status = readString(params, "status") ?? "";
    if (!threadId) return;
    const terminal = TERMINAL_STATUSES.has(status.toLowerCase());
    const next = new Set(get().runningThreadIds);
    if (terminal) next.delete(threadId);
    else next.add(threadId);
    if (setEqual(next, get().runningThreadIds)) return;
    set({ runningThreadIds: next });
  });
  // turn/diff/updated streams a per-turn diff while the turn is running.
  // We pipe it through the existing reducer as a synthetic file-change item
  // so the existing FileChange row renders it; this avoids a parallel UI.
  on(connection, "turn/diff/updated", (params) => {
    withTurnEvent(params, (event) => {
      const diff = readString(params, "diff") ?? readString(params, "patch");
      if (!event.turnId || !diff) return;
      mutateReducer(event.threadId, set, get, (state) => upsertTurnDiff(state, event, diff));
      schedulePersist(event.threadId, get);
    });
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

const TERMINAL_STATUSES = new Set([
  "idle",
  "stopped",
  "completed",
  "done",
  "finished",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "rejected",
  "compacted",
]);

function setEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

// Stamps a per-turn diff onto a single fileChange row keyed by turnId. We
// upsert in-place so streaming diffs don't spawn one row per delta.
function upsertTurnDiff(state: ThreadReducerState, event: TurnEventBase, diff: string): ThreadReducerState {
  const sentinelItemId = "__turnDiff__";
  const messages = state.messages.slice();
  const existingIndex = messages.findIndex(
    (message) => message.turnId === event.turnId && message.itemId === sentinelItemId
  );
  if (existingIndex >= 0) {
    const previous = messages[existingIndex];
    if (previous.fileChange?.diff === diff) return state;
    messages[existingIndex] = {
      ...previous,
      fileChange: { ...(previous.fileChange ?? {}), diff },
    };
    return { ...state, messages };
  }
  const row = createMessage({
    threadId: event.threadId,
    role: "system",
    kind: "fileChange",
    turnId: event.turnId,
    itemId: sentinelItemId,
    isStreaming: true,
    fileChange: { diff },
  });
  messages.push(row);
  return { ...state, messages };
}

async function fetchContextWindowSnapshot(
  threadId: string,
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState
): Promise<void> {
  if (!activeConnection?.rpc) return;
  try {
    const result = await activeConnection.rpc.request<Record<string, unknown>>("thread/contextWindow/read", {
      threadId,
    });
    const usage = extractContextWindowUsage(result);
    if (!usage) return;
    set({ contextUsageByThread: { ...get().contextUsageByThread, [threadId]: usage } });
  } catch (error) {
    // Method-not-found is the common case for providers that don't support it.
    if ((error as { code?: number })?.code !== -32601) log.warn("contextWindow/read failed", error);
  }
}

const TITLE_GENERATION_DELAY_MS = 4_000;

async function notifyTurnFinished(
  threadId: string,
  get: () => ThreadsState,
  outcome: "completed" | "failed",
  errorText?: string
): Promise<void> {
  if (!(await shouldNotify())) return;
  const state = get();
  const thread = state.threads.find((t) => t.id === threadId)
    ?? state.archivedThreads.find((t) => t.id === threadId);
  const threadName = thread?.name ?? thread?.title ?? "Untitled thread";
  showNotification({
    title: outcome === "completed" ? `Turn done — ${threadName}` : `Turn failed — ${threadName}`,
    body: outcome === "failed" ? (errorText ?? "Open agnt to see the error.") : "Open agnt to read the response.",
    // Tag by thread so back-to-back completions in the same thread coalesce
    // rather than stacking ten dock badges.
    tag: threadId,
    onClick() {
      // Best-effort: bring the user to the thread that fired the
      // notification. window.focus() works on most browsers when the click
      // came from a notification.
      void useThreadsStore.getState().selectThread(threadId);
    },
  });
}

function scheduleAutoTitle(
  threadId: string,
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState
): void {
  if (typeof window === "undefined") return;
  setTimeout(async () => {
    if (!activeConnection?.rpc) return;
    try {
      const result = await activeConnection.rpc.request<{ title?: string; name?: string }>(
        "thread/generateTitle",
        { threadId }
      );
      const title = result.title ?? result.name;
      if (!title) return;
      // Don't fight a manual rename: if the user already named the thread, skip.
      const current = get().threads.find((t) => t.id === threadId) ?? get().archivedThreads.find((t) => t.id === threadId);
      if (current?.name) return;
      patchThreadName(set, get, threadId, title);
    } catch (error) {
      if ((error as { code?: number })?.code !== -32601) log.warn("auto-title failed", error);
    }
  }, TITLE_GENERATION_DELAY_MS);
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

/** Pure: a thread is unread when its server-side updatedAt outpaces the
 *  recorded visit. Returns false if either timestamp is missing. */
export function isThreadUnread(thread: CodexThread, lastVisited: Record<string, number>): boolean {
  const updated = thread.updatedAt;
  if (typeof updated !== "number") return false;
  const visited = lastVisited[thread.id];
  if (typeof visited !== "number") return updated > 0;
  return updated > visited;
}

// When a turn completes (or fails) on the *currently selected* thread, the
// user is already looking at it — re-stamp last-visited so the dot doesn't
// pop on for a moment between updatedAt landing and a future click.
function bumpVisitIfActive(
  threadId: string,
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState
): void {
  if (get().selectedThreadId !== threadId) return;
  const next = { ...get().lastVisitedByThread, [threadId]: Date.now() };
  set({ lastVisitedByThread: next });
  void prefsStore.saveLastVisited(next);
}
