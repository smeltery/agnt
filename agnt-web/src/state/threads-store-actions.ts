import { extractContextWindowUsage, normalizeThread, type CodexThread } from "../models";
import type { Connection } from "../protocol";
import { messagesStore } from "../storage/messages-store";
import { prefsStore } from "../storage/prefs-store";
import { fetchThreadTurnsPage } from "./pagination";
import { useNoticesStore } from "./notices-store";
import { useThreadGoalsStore } from "./thread-goals";
import { applyHistoryEvent, flattenTurnsToEvents } from "./thread-history-events";
import { buildReviewStartParams, effectiveServiceTier, prependSystemPrompt, reviewPromptText } from "./thread-selectors";
import { buildTurnInput } from "./turn-input";
import { applyLocalUserMessage, emptyThreadState, type ThreadReducerState } from "./turn-reducer";
import { useUndoStore } from "./undo-store";
import type { ThreadsState } from "./threads-store";

interface ThreadActionsDeps {
  set: (partial: Partial<ThreadsState>) => void;
  get: () => ThreadsState;
  getConnection: () => Connection | null;
  logger: { warn: (...args: unknown[]) => void };
}

const PERSIST_DEBOUNCE_MS = 250;
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function createThreadActions({ set, get, getConnection, logger: log }: ThreadActionsDeps): Pick<ThreadsState,
  | "selectThread"
  | "loadOlderTurns"
  | "sendTurn"
  | "startReview"
  | "retryFailedTurn"
  | "patchTurnFlags"
  | "startNewThread"
  | "forkThread"
  | "renameThread"
  | "archiveThread"
  | "unarchiveThread"
  | "compactThread"
  | "stopTurn"
> {
  return {
    async selectThread(threadId) {
      // Stamp the visit so the unread dot disappears. We bump the timestamp to
      // *now* rather than thread.updatedAt — a turn that completes while we're
      // already viewing the thread shouldn't immediately re-mark it unread.
      const priorVisited = get().lastVisitedByThread[threadId];
      const nextVisited = { ...get().lastVisitedByThread, [threadId]: Date.now() };
      // Capture the prior visit ts BEFORE overwriting it so ChatView can
      // anchor a "new since you were last here" divider that doesn't move
      // as the user reads. `undefined` (first-ever visit) becomes 0 so the
      // divider naturally suppresses (no messages older than 0).
      const nextArrival = {
        ...get().arrivalVisitedByThread,
        [threadId]: priorVisited ?? 0,
      };
      set({
        selectedThreadId: threadId,
        lastVisitedByThread: nextVisited,
        arrivalVisitedByThread: nextArrival,
      });
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
      void fetchContextWindowSnapshot(threadId, set, get, getConnection, log);
      void useThreadGoalsStore.getState().refresh(threadId);
      await get().loadOlderTurns(threadId);
    },

    async loadOlderTurns(threadId) {
      const connection = getConnection();
      if (!connection?.rpc) return;
      try {
        const page = await fetchThreadTurnsPage({ rpc: connection.rpc, threadId, limit: 20 });
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
      const connection = getConnection();
      if (!connection?.rpc) return;
      mutateReducer(threadId, set, get, (state) =>
        applyLocalUserMessage(state, threadId, content, { attachments })
      );
      schedulePersist(threadId, get);
      // Per-thread overrides win over the global flags, and (when present)
      // prepend a system prompt to the turn so long-running threads can pin
      // a behavior without re-typing it every turn.
      const override = get().overridesByThread[threadId] ?? {};
      const composed = override.systemPrompt
        ? prependSystemPrompt(content, override.systemPrompt)
        : content;
      const input = buildTurnInput(composed, attachments);
      if (input.length === 0) return;
      const flags = get().turnFlags;
      const params: Record<string, unknown> = { threadId, input, content: composed };
      const model = override.model ?? flags.model;
      const reasoningEffort = override.reasoningEffort ?? flags.reasoningEffort;
      if (model) params.model = model;
      if (reasoningEffort) params.reasoningEffort = reasoningEffort;
      const serviceTier = effectiveServiceTier(flags, get().models);
      if (serviceTier) params.serviceTier = serviceTier;
      if (flags.permissionMode) params.permissionMode = flags.permissionMode;
      if (flags.planMode) params.planMode = true;
      try {
        await connection.rpc.request("turn/start", params);
      } catch (error) {
        set({ error: (error as Error).message });
      }
    },

    async startReview(threadId, options) {
      const connection = getConnection();
      if (!connection?.rpc || !threadId) return false;
      const params = buildReviewStartParams(threadId, options);
      if (!params) {
        set({ error: "Choose a base branch before starting this review." });
        return false;
      }
      mutateReducer(threadId, set, get, (state) =>
        applyLocalUserMessage(state, threadId, reviewPromptText(options))
      );
      schedulePersist(threadId, get);
      try {
        await connection.rpc.request("review/start", params);
        return true;
      } catch (error) {
        const message = (error as { code?: number; message?: string }).code === -32601
          ? "This provider doesn't support inline code review."
          : (error as Error).message;
        set({ error: message });
        return false;
      }
    },

    async retryFailedTurn(threadId, failedTurnId, options) {
      const connection = getConnection();
      if (!connection?.rpc) return false;
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
      const override = get().overridesByThread[threadId] ?? {};
      const composed = override.systemPrompt
        ? prependSystemPrompt(content, override.systemPrompt)
        : content;
      const input = buildTurnInput(composed, attachments);
      if (input.length === 0) return false;
      const flags = get().turnFlags;
      const params: Record<string, unknown> = { threadId, input, content: composed };
      const model = options?.modelOverride ?? override.model ?? flags.model;
      const reasoningEffort = override.reasoningEffort ?? flags.reasoningEffort;
      if (model) params.model = model;
      if (reasoningEffort) params.reasoningEffort = reasoningEffort;
      const serviceTier = effectiveServiceTier(flags, get().models);
      if (serviceTier) params.serviceTier = serviceTier;
      if (flags.permissionMode) params.permissionMode = flags.permissionMode;
      if (flags.planMode) params.planMode = true;
      try {
        await connection.rpc.request("turn/start", params);
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
        serviceTier: next.serviceTier,
      });
    },

    async startNewThread(input) {
      const connection = getConnection();
      if (!connection?.rpc) return null;
      const { content, cwd, attachments } = input;
      const turnInput = buildTurnInput(content, attachments);
      if (turnInput.length === 0) return null;
      const flags = get().turnFlags;
      const params: Record<string, unknown> = { content, input: turnInput };
      if (cwd) params.cwd = cwd;
      if (flags.model) params.model = flags.model;
      if (flags.reasoningEffort) params.reasoningEffort = flags.reasoningEffort;
      const serviceTier = effectiveServiceTier(flags, get().models);
      if (serviceTier) params.serviceTier = serviceTier;
      if (flags.permissionMode) params.permissionMode = flags.permissionMode;
      if (flags.planMode) params.planMode = true;
      try {
        const response = await connection.rpc.request<{ threadId?: string; thread?: { id?: string } }>(
          "thread/start",
          params
        );
        const threadId = response.threadId ?? response.thread?.id;
        if (!threadId) return null;
      await refreshLiveThreads(set, getConnection, log);
        await get().selectThread(threadId);
        // Auto-title after a short delay so the bridge has the first turn's
        // content to summarize. Best-effort: failures are logged and ignored.
        scheduleAutoTitle(threadId, set, get, getConnection, log);
        return threadId;
      } catch (error) {
        set({ error: (error as Error).message });
        return null;
      }
    },

    async forkThread(sourceThreadId) {
      const connection = getConnection();
      if (!connection?.rpc) return null;
      try {
        const response = await connection.rpc.request<{ threadId?: string; thread?: { id?: string } }>(
          "thread/fork",
          { threadId: sourceThreadId }
        );
        const newThreadId = response.threadId ?? response.thread?.id;
        if (!newThreadId) return null;
        // Refresh the live thread list so the new thread appears in the sidebar.
        void refreshLiveThreads(set, getConnection, log);
        await get().selectThread(newThreadId);
        return newThreadId;
      } catch (error) {
        set({ error: (error as Error).message });
        return null;
      }
    },

    async renameThread(threadId, name) {
      const connection = getConnection();
      if (!connection?.rpc) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      // Capture the prior label so the undo toast can restore it. Read from
      // both lists since rename works on archived threads too.
      const state = get();
      const prior =
        state.threads.find((t) => t.id === threadId)
        ?? state.archivedThreads.find((t) => t.id === threadId);
      const previousName = prior?.name ?? prior?.title;
      if (previousName === trimmed) return;
      try {
        await connection.rpc.request("thread/name/set", { threadId, name: trimmed });
        patchThreadName(set, get, threadId, trimmed);
        if (previousName) {
          useUndoStore.getState().publish({
            label: `Renamed to "${trimmed}"`,
            reverse: () => get().renameThread(threadId, previousName),
          });
        }
      } catch (error) {
        set({ error: (error as Error).message });
      }
    },

    async archiveThread(threadId) {
      const connection = getConnection();
      if (!connection?.rpc) return;
      const state = get();
      const target = state.threads.find((t) => t.id === threadId);
      const label = target?.name ?? target?.title ?? "thread";
      try {
        await connection.rpc.request("thread/archive", { threadId });
        moveThreadBetweenLists(set, get, threadId, "archive");
        useUndoStore.getState().publish({
          label: `Archived "${label}"`,
          reverse: () => get().unarchiveThread(threadId),
        });
      } catch (error) {
        set({ error: (error as Error).message });
      }
    },

    async unarchiveThread(threadId) {
      const connection = getConnection();
      if (!connection?.rpc) return;
      const state = get();
      const target = state.archivedThreads.find((t) => t.id === threadId);
      const label = target?.name ?? target?.title ?? "thread";
      try {
        await connection.rpc.request("thread/unarchive", { threadId });
        moveThreadBetweenLists(set, get, threadId, "unarchive");
        useUndoStore.getState().publish({
          label: `Unarchived "${label}"`,
          reverse: () => get().archiveThread(threadId),
        });
      } catch (error) {
        set({ error: (error as Error).message });
      }
    },

    async compactThread(threadId) {
      const connection = getConnection();
      if (!connection?.rpc) return false;
      try {
        // Bridge handles the actual summarization + thread/turns/list
        // re-emission. Once it returns, refresh the local turn cache so the
        // compacted view is live without a thread switch.
        await connection.rpc.request("thread/compact/start", { threadId });
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
      const connection = getConnection();
      if (!threadId || !connection?.rpc) return;
      const reducerState = get().reducerStates[threadId];
      const turnId = reducerState?.activeTurnId;
      if (!turnId) return;
      try {
        await connection.rpc.request("turn/interrupt", { threadId, turnId });
      } catch (error) {
        log.warn("turn/interrupt failed", error);
      }
    },

  };
}

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

async function fetchContextWindowSnapshot(
  threadId: string,
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState,
  getConnection: () => Connection | null,
  log: { warn: (...args: unknown[]) => void }
): Promise<void> {
  const connection = getConnection();
  if (!connection?.rpc) return;
  try {
    const result = await connection.rpc.request<Record<string, unknown>>("thread/contextWindow/read", {
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

function scheduleAutoTitle(
  threadId: string,
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState,
  getConnection: () => Connection | null,
  log: { warn: (...args: unknown[]) => void }
): void {
  if (typeof window === "undefined") return;
  setTimeout(async () => {
    const connection = getConnection();
    if (!connection?.rpc) return;
    try {
      const result = await connection.rpc.request<{ title?: string; name?: string }>(
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
  getConnection: () => Connection | null,
  log: { warn: (...args: unknown[]) => void }
): Promise<void> {
  const connection = getConnection();
  if (!connection?.rpc) return;
  try {
    const result = await connection.rpc.request<{ data?: unknown[]; items?: unknown[]; threads?: unknown[] }>(
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
  }
}

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
