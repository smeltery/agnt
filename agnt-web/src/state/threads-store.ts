// Thread + chat coordinator. Owns one ThreadReducerState per thread and routes
// inbound JSON-RPC notifications into the pure reducer. Persistence to IndexedDB
// is debounced per thread so high-frequency streaming deltas don't thrash disk.
//
// This file is the only consumer of the protocol layer — UI components subscribe
// to slices via zustand selectors and never see Connection/JsonRpcClient.

import { create } from "zustand";
import { makeLogger } from "../lib/log";
import {
  type CodexThread,
  type ContextWindowUsage,
  orderCounter,
} from "../models";
import type { Connection } from "../protocol";
import { useAccountStore } from "./account-store";
import { useApprovalsStore } from "./approvals-store";
import { useGitStore } from "./git-store";
import { useStreamingStatsStore } from "./streaming-stats-store";
import { useStructuredInputStore } from "./structured-input-store";
import { runPostHandshakeBootstrap, type ModelOption } from "./sync";
import { useVoiceStore } from "./voice-store";
import type { ThreadReducerState } from "./turn-reducer";
import { messagesStore } from "../storage/messages-store";
import { prefsStore, type ThreadColor, type ThreadOverride } from "../storage/prefs-store";
import { registerNotificationHandlers, registerServerRequestHandlers } from "./threads/routing";
import { createThreadActions } from "./threads/actions";
import type { ImageAttachment } from "../models";
import { useThreadGoalsStore } from "./thread-goals";

export {
  buildReviewStartParams,
  effectiveServiceTier,
  isThreadUnread,
  prependSystemPrompt,
  selectActiveMessages,
  selectActiveTurnRunning,
} from "./thread-selectors";

const log = makeLogger("threads");

export type ReasoningEffort = "low" | "medium" | "high";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type ServiceTier = "fast";
export type ReviewTarget = "uncommittedChanges" | "baseBranch";

export interface TurnFlags {
  /** Selected provider model id (subset of state.models). Undefined = bridge default. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Claude-only: passes through as `params.permissionMode`. */
  permissionMode?: PermissionMode;
  /** Codex-only: requests plan-mode for this turn. */
  planMode?: boolean;
  /** Codex-only: low-latency turn variant for models that advertise support. */
  serviceTier?: ServiceTier;
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
  /** Snapshot of the prior `lastVisitedByThread[threadId]` taken at the
   *  moment `selectThread` was called — i.e. when did the user PREVIOUSLY
   *  view this thread? Used by ChatView to draw a "new since you were
   *  here" divider that stays stable while the user is reading. Stays
   *  put until the next selectThread for the same id. */
  arrivalVisitedByThread: Record<string, number>;
  /** Per-thread color tag (one of `THREAD_COLOR_VALUES`). Persisted. */
  colorByThread: Record<string, ThreadColor>;
  /** Per-thread override of the global turn flags + an optional system
   *  prompt prepended to every turn. Persisted via `prefs.threadOverrides`. */
  overridesByThread: Record<string, ThreadOverride>;
  /** Thread ids the user has explicitly silenced. Layered ON TOP of the
   *  global notifications pref — a muted thread skips desktop alerts even
   *  when notifications are otherwise enabled. Persisted. */
  mutedThreadIds: Set<string>;
  loading: boolean;
  error: string | null;
  hydrated: boolean;

  bindToConnection(connection: Connection): Promise<void>;
  hydrateFromDisk(): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  loadOlderTurns(threadId: string): Promise<void>;
  sendTurn(threadId: string, content: string, attachments?: ImageAttachment[]): Promise<void>;
  startReview(threadId: string, options?: { target?: ReviewTarget; baseBranch?: string }): Promise<boolean>;
  /** Re-issues turn/start with the inputs of a failed turn. Returns whether a retry actually fired. */
  /** Re-issue a failed turn. When `options.modelOverride` is set, that
   *  model wins over both the per-thread override and the global flag —
   *  used by the SystemErrorRow's "Retry with…" picker so a flake on one
   *  model can be retried on a different one without changing global state. */
  retryFailedTurn(
    threadId: string,
    failedTurnId: string,
    options?: { modelOverride?: string }
  ): Promise<boolean>;
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
  /** Set the thread color tag, or pass `null` to clear it. */
  setThreadColor(threadId: string, color: ThreadColor | null): Promise<void>;
  /** Patch the per-thread override (system prompt / model / effort).
   *  Pass `null` for any field to clear it; pass `null` for the whole entry
   *  by patching `{ systemPrompt: undefined, model: undefined, ... }` —
   *  empty entries are pruned on persist. */
  setThreadOverride(threadId: string, patch: Partial<ThreadOverride>): Promise<void>;
  /** Toggle desktop notifications for a single thread. Layered on top of
   *  the global `prefs.notifications` setting — a muted thread skips
   *  alerts even when notifications are globally enabled. */
  setThreadMuted(threadId: string, muted: boolean): Promise<void>;
  reset(): void;
}

let activeConnection: Connection | null = null;
const teardownHandlers: Array<() => void> = [];

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
  arrivalVisitedByThread: {},
  colorByThread: {},
  overridesByThread: {},
  mutedThreadIds: new Set(),
  loading: false,
  error: null,
  hydrated: false,

  async hydrateFromDisk() {
    if (get().hydrated) return;
    const [max, persistedFlags, pinnedIds, lastVisited, threadColors, threadOverrides, mutedIds] = await Promise.all([
      messagesStore.loadHighestOrderIndex(),
      prefsStore.loadTurnFlags(),
      prefsStore.loadPinnedThreadIds(),
      prefsStore.loadLastVisited(),
      prefsStore.loadThreadColors(),
      prefsStore.loadThreadOverrides(),
      prefsStore.loadMutedThreadIds(),
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
        serviceTier: persistedFlags.serviceTier as TurnFlags["serviceTier"],
      },
      pinnedThreadIds: new Set(pinnedIds),
      lastVisitedByThread: lastVisited,
      colorByThread: threadColors,
      overridesByThread: threadOverrides,
      mutedThreadIds: new Set(mutedIds),
    });
  },

  async setThreadOverride(threadId, patch) {
    if (!threadId) return;
    const current = get().overridesByThread[threadId] ?? {};
    const merged: ThreadOverride = { ...current };
    for (const [key, value] of Object.entries(patch) as Array<[keyof ThreadOverride, unknown]>) {
      if (value === undefined || value === null || value === "") delete (merged as Record<string, unknown>)[key];
      else (merged as Record<string, unknown>)[key] = value;
    }
    const next = { ...get().overridesByThread };
    if (Object.keys(merged).length === 0) delete next[threadId];
    else next[threadId] = merged;
    set({ overridesByThread: next });
    void prefsStore.saveThreadOverrides(next);
  },

  async setThreadMuted(threadId, muted) {
    if (!threadId) return;
    const next = new Set(get().mutedThreadIds);
    if (muted) next.add(threadId);
    else next.delete(threadId);
    set({ mutedThreadIds: next });
    void prefsStore.saveMutedThreadIds([...next]);
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

  async setThreadColor(threadId, color) {
    if (!threadId) return;
    const next = { ...get().colorByThread };
    if (color === null) delete next[threadId];
    else next[threadId] = color;
    set({ colorByThread: next });
    void prefsStore.saveThreadColors(next);
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
    useThreadGoalsStore.getState().bind(connection);
    activeConnection = connection;
    registerNotificationHandlers(connection, set, get, teardownHandlers);
    registerServerRequestHandlers(connection, teardownHandlers);
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
      // Pull host capabilities (terminalLocal etc.) once on connect so the
      // workspace header can decide whether to show the Terminal button.
      // SettingsModal also calls this on open, but we don't want to require
      // that detour just to discover the feature.
      void useAccountStore.getState().refresh();
    } catch (error) {
      log.warn("bootstrap failed", error);
      set({ loading: false, error: (error as Error).message });
    }
  },

  ...createThreadActions({ set, get, getConnection: () => activeConnection, logger: log }),
  reset() {
    while (teardownHandlers.length) teardownHandlers.pop()?.();
    activeConnection = null;
    useStreamingStatsStore.setState({ byThread: {} });
    useThreadGoalsStore.getState().reset();
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
