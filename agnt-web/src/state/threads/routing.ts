import { flashTitle } from "../../lib/document-title";
import { showNotification, shouldNotify } from "../../lib/notifications";
import { playTurnCue } from "../../lib/sound-cue";
import { fireTurnWebhook } from "../../lib/turn-webhook";
import { createMessage, decodePlanSteps, extractContextWindowUsage } from "../../models";
import type { Connection } from "../../protocol";
import { messagesStore } from "../../storage/messages-store";
import { buildApprovalServerRequestHandler } from "../approvals-store";
import { useNoticesStore } from "../notices-store";
import { armSlowResponseWatch, cancelSlowResponseWatch } from "../slow-response-watcher";
import { buildStructuredInputServerRequestHandler } from "../structured-input-store";
import { extractTurnTokenUsage } from "../../lib/token-usage";
import { applyAgentDelta, applyItemCompleted, applyItemOutputDelta, applyItemStarted, applyPlanDelta, applyPlanUpdated, applyReasoningDelta, applyTurnCompleted, applyTurnFailed, applyTurnStarted, emptyThreadState, type ThreadReducerState } from "../turn-reducer";
import { useStreamingStatsStore } from "../streaming-stats-store";
import { useTurnTimingStore } from "../turn-timing-store";
import { useTurnTokenUsageStore } from "../turn-token-usage-store";
import { bumpVisitIfActive } from "../thread-visits";
import type { ThreadsState } from "../threads-store";
import { useThreadsStore } from "../threads-store";


export function registerNotificationHandlers(
  connection: Connection,
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState,
  teardownHandlers: Array<() => void>
): void {
  // Lifecycle.
  on(connection, teardownHandlers, "turn/started", (params) => withTurnEvent(params, (event) => {
    mutateReducer(event.threadId, set, get, (s) => applyTurnStarted(s, event));
    useStreamingStatsStore.getState().noteTurnStarted(event.threadId);
    if (event.turnId) {
      useTurnTimingStore.getState().noteTurnStarted(event.threadId, event.turnId);
      armSlowResponseWatch(event.turnId);
    }
  }));
  on(connection, teardownHandlers, "turn/completed", (params) =>
    withTurnEvent(params, (event) => {
      mutateReducer(event.threadId, set, get, (s) => applyTurnCompleted(s, event));
      useStreamingStatsStore.getState().noteTurnFinished(event.threadId);
      if (event.turnId) {
        useTurnTimingStore.getState().noteTurnEnded(event.turnId);
        cancelSlowResponseWatch(event.turnId);
      }
      bumpVisitIfActive(event.threadId, set, get);
      // Two layered "tab is hidden" signals: a desktop notification when the
      // user has granted permission and opted in, plus the title flash as a
      // permission-free fallback. Both no-op when the tab is focused.
      void notifyTurnFinished(event.threadId, get, "completed");
      flashTitle("Turn done");
      void fireTurnWebhook({
        schemaVersion: 1,
        outcome: "completed",
        threadId: event.threadId,
        turnId: event.turnId,
        timestamp: new Date().toISOString(),
      });
    })
  );
  on(connection, teardownHandlers, "turn/failed", (params) =>
    withTurnEvent(params, (event) => {
      const errorText = readString(params, "error", "message");
      mutateReducer(event.threadId, set, get, (s) => applyTurnFailed(s, event, errorText));
      useStreamingStatsStore.getState().noteTurnFinished(event.threadId);
      if (event.turnId) {
        useTurnTimingStore.getState().noteTurnEnded(event.turnId);
        cancelSlowResponseWatch(event.turnId);
      }
      bumpVisitIfActive(event.threadId, set, get);
      void notifyTurnFinished(event.threadId, get, "failed", errorText);
      flashTitle("Turn failed");
      void fireTurnWebhook({
        schemaVersion: 1,
        outcome: "failed",
        threadId: event.threadId,
        turnId: event.turnId,
        timestamp: new Date().toISOString(),
        errorText,
      });
    })
  );

  // Streaming deltas.
  on(connection, teardownHandlers, "item/agentMessage/delta", (params) =>
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
  on(connection, teardownHandlers, "codex/event/agent_message_delta", (params) =>
    withTurnEvent(params, (event) => {
      const delta = readString(params, "delta", "text") ?? "";
      mutateReducer(event.threadId, set, get, (s) => applyAgentDelta(s, { ...event, delta }));
      useStreamingStatsStore.getState().noteDelta(event.threadId, delta.length);
      schedulePersist(event.threadId, get);
    })
  );
  on(connection, teardownHandlers, "codex/event/agent_message", (params) => withTurnEvent(params, (event) => {
    const text = readString(params, "message", "text") ?? "";
    if (text) mutateReducer(event.threadId, set, get, (s) => applyItemCompleted(s, { ...event, type: "agentmessage", text, assistantPhase: readString(params, "phase") }));
    if (text) schedulePersist(event.threadId, get);
  }));
  on(connection, teardownHandlers, "item/reasoning/textDelta", (params) =>
    withTurnEvent(params, (event) => {
      const delta = readString(params, "delta", "textDelta") ?? "";
      mutateReducer(event.threadId, set, get, (s) => applyReasoningDelta(s, { ...event, delta }));
      useStreamingStatsStore.getState().noteDelta(event.threadId, delta.length);
      schedulePersist(event.threadId, get);
    })
  );
  on(connection, teardownHandlers, "item/toolCall/outputDelta", (params) => routeOutputDelta(params, set, get));
  on(connection, teardownHandlers, "item/commandExecution/outputDelta", (params) => routeOutputDelta(params, set, get));
  on(connection, teardownHandlers, "item/fileChange/outputDelta", (params) => routeOutputDelta(params, set, get));

  // Item lifecycle.
  on(connection, teardownHandlers, "item/started", (params) => {
    withTurnEvent(params, (event) => {
      const type = readString(params, "type");
      const role = readString(params, "role");
      const phase = readString(params, "phase");
      mutateReducer(event.threadId, set, get, (s) => applyItemStarted(s, { ...event, type, role, assistantPhase: phase }));
    });
  });
  on(connection, teardownHandlers, "item/completed", (params) => {
    withTurnEvent(params, (event) => {
      const type = readString(params, "type");
      const text = readString(params, "text", "message");
      mutateReducer(event.threadId, set, get, (s) => applyItemCompleted(s, { ...event, type, text }));
      schedulePersist(event.threadId, get);
    });
  });

  // Threads metadata.
  on(connection, teardownHandlers, "thread/started", (params) => {
    const threadId = readString(params, "threadId");
    if (!threadId) return;
    set({});  // touch for selector recomputation; refreshThreads pulls full data on next sync tick
  });
  on(connection, teardownHandlers, "thread/name/updated", (params) => {
    const threadId = readString(params, "threadId");
    const name = readString(params, "name");
    if (!threadId || !name) return;
    patchThreadName(set, get, threadId, name);
  });
  // thread/status/changed lets the sidebar show a running indicator on
  // non-active threads. Bridge emits "running" / "idle" / terminal labels —
  // we treat anything that isn't terminal as running.
  on(connection, teardownHandlers, "thread/status/changed", (params) => {
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
  on(connection, teardownHandlers, "turn/diff/updated", (params) => {
    withTurnEvent(params, (event) => {
      const diff = readString(params, "diff") ?? readString(params, "patch");
      if (!event.turnId || !diff) return;
      mutateReducer(event.threadId, set, get, (state) => upsertTurnDiff(state, event, diff));
      schedulePersist(event.threadId, get);
    });
  });
  on(connection, teardownHandlers, "thread/tokenUsage/updated", (params) => {
    const threadId = readString(params, "threadId");
    if (!threadId) return;
    const usage = extractContextWindowUsage(params);
    if (usage) set({ contextUsageByThread: { ...get().contextUsageByThread, [threadId]: usage } });
    // Per-turn token usage / cost: the bridge fires this notification right
    // before `turn/completed` while the reducer's activeTurnId is still set,
    // so we resolve the current turn here instead of stashing a side state.
    // If no turn is active (history-load case) the most-recent assistant
    // message's turnId is the right anchor.
    const turnUsage = extractTurnTokenUsage(params);
    if (turnUsage) {
      const reducer = get().reducerStates[threadId];
      const activeTurnId = reducer?.activeTurnId;
      const fallbackTurnId = activeTurnId
        ? null
        : [...(reducer?.messages ?? [])].reverse().find((m) => m.role === "assistant" && m.turnId)?.turnId ?? null;
      const turnId = activeTurnId ?? fallbackTurnId;
      if (turnId) useTurnTokenUsageStore.getState().noteTurnUsage(threadId, turnId, turnUsage);
    }
  });

  // Plan mode.
  on(connection, teardownHandlers, "turn/plan/updated", (params) =>
    withTurnEvent(params, (event) => {
      const explanation = readString(params, "explanation");
      const steps = decodePlanSteps((params as Record<string, unknown> | undefined)?.plan);
      mutateReducer(event.threadId, set, get, (s) => applyPlanUpdated(s, { ...event, explanation, steps }));
    })
  );
  on(connection, teardownHandlers, "item/plan/delta", (params) =>
    withTurnEvent(params, (event) => {
      const delta = readString(params, "delta") ?? "";
      mutateReducer(event.threadId, set, get, (s) => applyPlanDelta(s, { ...event, delta }));
      schedulePersist(event.threadId, get);
    })
  );

  // System notices (e.g. opencode tui.toast.show).
  on(connection, teardownHandlers, "system/notice", (params) => {
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

export function registerServerRequestHandlers(
  connection: Connection,
  teardownHandlers: Array<() => void>
): void {
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

async function notifyTurnFinished(
  threadId: string,
  get: () => ThreadsState,
  outcome: "completed" | "failed",
  errorText?: string
): Promise<void> {
  const state = get();
  // Per-thread mute is checked first so a muted thread skips both the
  // sound cue AND the notification — same gate, two effects.
  if (state.mutedThreadIds.has(threadId)) return;
  // Sound cue runs independently of the desktop notification permission:
  // a user in an unmuted tab who never granted notification access still
  // gets the audible signal. The cue itself respects the volume pref
  // (default 0 = silent) so this is opt-in either way.
  void playTurnCue(outcome);
  if (!(await shouldNotify())) return;
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

function on(
  connection: Connection,
  teardownHandlers: Array<() => void>,
  method: string,
  handler: (params: unknown) => void
): void {
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

const PERSIST_DEBOUNCE_MS = 250;
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
