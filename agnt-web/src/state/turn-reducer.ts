// Pure reducer that turns inbound JSON-RPC notifications into chat-row mutations.
// Faithful port of the iOS reconciliation logic in:
//   - CodexService+Messages.swift  (beginAssistantMessage, appendAssistantDelta,
//                                   applyLateTerminalAssistantDelta,
//                                   completeAssistantMessage)
//   - CodexService+IncomingAssistant.swift  (entry points)
//   - CodexService+Incoming.swift          (handleStructuredItemLifecycle)
//
// Why pure-function? It's the only way to test the tie-breaks against real
// recorded event traces. The threads-store wires this into zustand; this file
// has no zustand or React imports.

import {
  appendCommandOutput,
  type CodexMessage,
  createMessage,
} from "../models";
import { replayDeduper } from "./replay-deduper";
import {
  appendOrUpdate,
  compositeKey,
  filterByValueNotIn,
  idsForTurn,
  inferKindFromType,
  mutateMessage,
  removeKey,
} from "./turn-reducer-helpers";
import { beginStructuredItem, completeStructuredItem } from "./turn-reducer-structured";
export { applyPlanDelta, applyPlanUpdated } from "./turn-reducer-plan";
export type { PlanDeltaEvent, PlanUpdatedEvent } from "./turn-reducer-plan";

/** Per-thread mutable state the reducer maintains alongside the messages list. */
export interface ThreadReducerState {
  messages: CodexMessage[];
  /** Index of streaming assistant rows by (turnId, itemId). */
  streamingByItem: Record<string, string>;
  /** Fallback index of streaming assistant rows by turnId when itemId is unknown. */
  streamingFallbackByTurn: Record<string, string>;
  /** Streaming reasoning rows by (turnId, itemId). */
  streamingReasoningByItem: Record<string, string>;
  /** Streaming structured rows (tool calls, file changes, commands) by (turnId, itemId). */
  streamingStructuredByItem: Record<string, string>;
  /**
   * Plan rows are unique per (turnId, itemId|"_progress"). The progress slot holds the
   * structured plan steps emitted by `turn/plan/updated`; per-itemId slots hold the
   * streamed plan text from `item/plan/delta`.
   */
  streamingPlanByKey: Record<string, string>;
  /** Set of turnIds whose terminal frame has arrived. Late deltas patch silently. */
  terminalTurns: Record<string, true>;
  /** Currently active turnId for the thread (running). */
  activeTurnId?: string;
}

export function emptyThreadState(): ThreadReducerState {
  return {
    messages: [],
    streamingByItem: {},
    streamingFallbackByTurn: {},
    streamingReasoningByItem: {},
    streamingStructuredByItem: {},
    streamingPlanByKey: {},
    terminalTurns: {},
  };
}

// ─── Public dispatch ───────────────────────────────────────────────────────────

export interface ReducerEvent {
  threadId: string;
  turnId?: string;
  itemId?: string;
}

export function applyTurnStarted(state: ThreadReducerState, event: ReducerEvent): ThreadReducerState {
  if (!event.turnId) return state;
  return { ...state, activeTurnId: event.turnId, terminalTurns: removeKey(state.terminalTurns, event.turnId) };
}

export function applyTurnCompleted(state: ThreadReducerState, event: ReducerEvent): ThreadReducerState {
  if (!event.turnId) return state;
  let next = closeStreamingRowsForTurn(state, event.turnId);
  next = { ...next, terminalTurns: { ...next.terminalTurns, [event.turnId]: true } };
  if (next.activeTurnId === event.turnId) next = { ...next, activeTurnId: undefined };
  return next;
}

export function applyTurnFailed(state: ThreadReducerState, event: ReducerEvent, errorText?: string): ThreadReducerState {
  let next = applyTurnCompleted(state, event);
  // Always emit an inline marker — even when the bridge didn't include a
  // message — so the user can see *which* turn failed when scrolled. The
  // `deliveryState: "failed"` flag is what UserRow / MessageRow use to pick a
  // dedicated style instead of falling through to plain assistant rendering.
  next = appendOrUpdate(next, (messages) => [
    ...messages,
    createMessage({
      threadId: event.threadId,
      role: "system",
      kind: "chat",
      text: errorText && errorText.trim() ? errorText : "Turn failed.",
      turnId: event.turnId,
      deliveryState: "failed",
    }),
  ]);
  return next;
}

/** Streaming assistant prose. iOS: appendAgentDelta → applyAssistantDeltaBatch. */
export interface AgentDeltaEvent extends ReducerEvent {
  delta: string;
  assistantPhase?: string;
}
export function applyAgentDelta(state: ThreadReducerState, event: AgentDeltaEvent): ThreadReducerState {
  if (!event.turnId || !event.delta) return state;
  // Late-replay delta path: turn already terminal AND not active → patch silently.
  if (state.terminalTurns[event.turnId] && state.activeTurnId !== event.turnId) {
    return patchTerminalAssistantDelta(state, event);
  }
  return appendOrCreateStreamingAssistant(state, event);
}

/** Reasoning deltas land in their own row (kind: "thinking", role: "system"). */
export interface ReasoningDeltaEvent extends ReducerEvent {
  delta: string;
}
export function applyReasoningDelta(state: ThreadReducerState, event: ReasoningDeltaEvent): ThreadReducerState {
  if (!event.turnId || !event.delta) return state;
  return appendOrCreateStreamingReasoning(state, event);
}

/** item/started for any item type — registers the row placeholder. */
export interface ItemStartedEvent extends ReducerEvent {
  type?: string;
  role?: string;
  assistantPhase?: string;
}
export function applyItemStarted(state: ThreadReducerState, event: ItemStartedEvent): ThreadReducerState {
  const kind = inferKindFromType(event.type);
  if (kind === "chat") return beginAssistantMessage(state, event);
  if (kind === "thinking") return state; // reasoning rows are spawned by reasoning/textDelta
  return beginStructuredItem(state, event, kind);
}

/** item/completed with canonical text. */
export interface ItemCompletedEvent extends ReducerEvent {
  type?: string;
  text?: string;
  assistantPhase?: string;
  exitCode?: number;
  durationMs?: number;
  filePath?: string;
  diff?: string;
}
export function applyItemCompleted(state: ThreadReducerState, event: ItemCompletedEvent): ThreadReducerState {
  const kind = inferKindFromType(event.type);
  if (kind === "chat") return completeAssistantMessage(state, event);
  if (kind === "thinking") return completeReasoningRow(state, event);
  return completeStructuredItem(state, event, kind);
}

/** Tool/command output streaming. Appends to `command.outputTail`. */
export interface ItemOutputDeltaEvent extends ReducerEvent {
  delta: string;
  type?: string;
}
export function applyItemOutputDelta(state: ThreadReducerState, event: ItemOutputDeltaEvent): ThreadReducerState {
  if (!event.turnId || !event.itemId || !event.delta) return state;
  const key = compositeKey(event.turnId, event.itemId);
  const messageId = state.streamingStructuredByItem[key];
  if (!messageId) return state;
  return mutateMessage(state, messageId, (message) => {
    if (message.kind === "commandExecution" && message.command) {
      return { ...message, command: appendCommandOutput(message.command, event.delta) };
    }
    if (message.kind === "fileChange" && message.fileChange) {
      return { ...message, fileChange: { ...message.fileChange, diff: message.fileChange.diff + event.delta } };
    }
    return { ...message, text: message.text + event.delta };
  });
}

/** Optimistic local user echo before turn/started arrives. */
export function applyLocalUserMessage(
  state: ThreadReducerState,
  threadId: string,
  text: string,
  options: { attachments?: import("../models").ImageAttachment[] } = {}
): ThreadReducerState {
  return appendOrUpdate(state, (messages) => [
    ...messages,
    createMessage({
      threadId,
      role: "user",
      kind: "chat",
      text,
      attachments: options.attachments?.length ? options.attachments : undefined,
      deliveryState: "pending",
    }),
  ]);
}

// ─── beginAssistantMessage ─────────────────────────────────────────────────────
//   Mirrors CodexService+Messages.swift:2559. Maintains the dual-index (item +
//   turn-fallback) so deltas arriving before item/started still find a row.

function beginAssistantMessage(state: ThreadReducerState, event: ItemStartedEvent): ThreadReducerState {
  if (!event.turnId) return state;
  const itemKey = compositeKey(event.turnId, event.itemId);
  // (1) Already an item-scoped row for this exact (turn, item) → just refresh phase.
  const existingItemMessageId = event.itemId ? state.streamingByItem[itemKey] : undefined;
  if (existingItemMessageId) return refreshAssistantPhase(state, existingItemMessageId, event.assistantPhase);

  // (2) Turn-scoped fallback row exists → try to claim it for this item.
  const turnFallbackId = state.streamingFallbackByTurn[event.turnId];
  if (turnFallbackId) {
    const messageIndex = state.messages.findIndex((m) => m.id === turnFallbackId);
    if (messageIndex >= 0) {
      const row = state.messages[messageIndex];
      if (!row.itemId) {
        // (2a) Promote the fallback to item-scoped.
        const next = mutateMessage(state, turnFallbackId, (m) => ({ ...m, itemId: event.itemId }));
        return event.itemId
          ? { ...next, streamingByItem: { ...next.streamingByItem, [itemKey]: turnFallbackId } }
          : next;
      }
      if (row.itemId === event.itemId) return refreshAssistantPhase(state, turnFallbackId, event.assistantPhase);
      // (2b) Bound to a different item — close it and let a new row be created below.
      const closed = mutateMessage(state, turnFallbackId, (m) => ({ ...m, isStreaming: false }));
      return createNewAssistantStreamingRow(removeFallbackForTurn(closed, event.turnId), event);
    }
  }

  return createNewAssistantStreamingRow(state, event);
}

function createNewAssistantStreamingRow(state: ThreadReducerState, event: ItemStartedEvent): ThreadReducerState {
  if (!event.turnId) return state;
  const message = createMessage({
    threadId: event.threadId,
    role: "assistant",
    kind: "chat",
    assistantPhase: event.assistantPhase,
    turnId: event.turnId,
    itemId: event.itemId,
    isStreaming: true,
  });
  let next = appendOrUpdate(state, (messages) => [...messages, message]);
  if (event.itemId) {
    next = { ...next, streamingByItem: { ...next.streamingByItem, [compositeKey(event.turnId, event.itemId)]: message.id } };
  } else {
    next = { ...next, streamingFallbackByTurn: { ...next.streamingFallbackByTurn, [event.turnId]: message.id } };
  }
  return next;
}

// ─── appendAssistantDelta ──────────────────────────────────────────────────────

function appendOrCreateStreamingAssistant(state: ThreadReducerState, event: AgentDeltaEvent): ThreadReducerState {
  if (!event.turnId) return state;
  const messageId = ensureStreamingAssistantRow(state, event);
  if (!messageId) return state;
  return mutateMessage(state, messageId, (message) => ({
    ...message,
    text: message.text + event.delta,
    isStreaming: true,
    itemId: message.itemId ?? event.itemId,
    assistantPhase: event.assistantPhase ?? message.assistantPhase,
  }));
}

function ensureStreamingAssistantRow(state: ThreadReducerState, event: AgentDeltaEvent): string | undefined {
  if (!event.turnId) return undefined;
  if (event.itemId) {
    const itemKey = compositeKey(event.turnId, event.itemId);
    const existing = state.streamingByItem[itemKey];
    if (existing) return existing;
  }
  const fallback = state.streamingFallbackByTurn[event.turnId];
  if (fallback) {
    const messageIndex = state.messages.findIndex((m) => m.id === fallback);
    if (messageIndex >= 0 && (!state.messages[messageIndex].itemId || state.messages[messageIndex].itemId === event.itemId)) {
      return fallback;
    }
  }
  // Create a new row on the fly (matches iOS: deltas can arrive before item/started).
  const next = createNewAssistantStreamingRow(state, event);
  Object.assign(state, next); // intentional: caller mutates the returned state
  return event.itemId
    ? next.streamingByItem[compositeKey(event.turnId, event.itemId)]
    : next.streamingFallbackByTurn[event.turnId];
}

// Late-replay deltas: terminal turn, not the active one. Patch silently.
function patchTerminalAssistantDelta(state: ThreadReducerState, event: AgentDeltaEvent): ThreadReducerState {
  if (!event.turnId) return state;
  const targetIndex = findLateReplayTarget(state.messages, event);
  if (targetIndex < 0) return state; // discard, do not reopen
  const target = state.messages[targetIndex];
  return mutateMessage(state, target.id, (message) => ({
    ...message,
    text: message.text + event.delta,
    isStreaming: false,
  }));
}

function findLateReplayTarget(messages: CodexMessage[], event: AgentDeltaEvent): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || message.turnId !== event.turnId) continue;
    if (event.itemId && message.itemId && message.itemId !== event.itemId) continue;
    return index;
  }
  return -1;
}

// ─── completeAssistantMessage ──────────────────────────────────────────────────

function completeAssistantMessage(state: ThreadReducerState, event: ItemCompletedEvent): ThreadReducerState {
  const text = (event.text ?? "").trim();
  if (!event.turnId) {
    if (!text) return state;
    return appendOrUpdate(state, (messages) => [
      ...messages,
      createMessage({
        threadId: event.threadId,
        role: "assistant",
        kind: "chat",
        text,
        itemId: event.itemId,
        assistantPhase: event.assistantPhase,
      }),
    ]);
  }
  if (!text) {
    // Nothing to set, but still close the streaming row.
    return closeStreamingAssistantRow(state, event);
  }

  // Block-replay short-circuit: incoming canonical text is the concat of existing
  // rows. Stamp the last row as the canonical final, drop the streaming flag.
  const blockTerminalIndex = replayDeduper.findBlockTerminalIndex(state.messages, {
    threadId: event.threadId,
    turnId: event.turnId,
    text,
  });
  if (blockTerminalIndex !== null) {
    const terminal = state.messages[blockTerminalIndex];
    return closeStreamingAssistantRow(
      mutateMessage(state, terminal.id, (m) => ({ ...m, assistantPhase: event.assistantPhase ?? m.assistantPhase })),
      event
    );
  }

  // Exact replay: an existing row already holds the canonical text. Just close it.
  if (replayDeduper.isExactReplay(state.messages, { threadId: event.threadId, turnId: event.turnId, text })) {
    return closeStreamingAssistantRow(state, event);
  }

  // Find the streaming row and finalize it. If none, append a fresh terminal row.
  const messageId = lookupAssistantStreamingId(state, event);
  if (messageId) {
    const finalized = mutateMessage(state, messageId, (m) => ({
      ...m,
      text,
      isStreaming: false,
      assistantPhase: event.assistantPhase ?? m.assistantPhase,
    }));
    return clearAssistantStreamingIndices(finalized, event);
  }
  return appendOrUpdate(state, (messages) => [
    ...messages,
    createMessage({
      threadId: event.threadId,
      role: "assistant",
      kind: "chat",
      text,
      turnId: event.turnId,
      itemId: event.itemId,
      assistantPhase: event.assistantPhase,
    }),
  ]);
}

function closeStreamingAssistantRow(state: ThreadReducerState, event: ItemCompletedEvent): ThreadReducerState {
  const messageId = lookupAssistantStreamingId(state, event);
  if (!messageId) return state;
  const closed = mutateMessage(state, messageId, (m) => ({ ...m, isStreaming: false }));
  return clearAssistantStreamingIndices(closed, event);
}

function lookupAssistantStreamingId(state: ThreadReducerState, event: ReducerEvent): string | undefined {
  if (!event.turnId) return undefined;
  if (event.itemId) {
    const id = state.streamingByItem[compositeKey(event.turnId, event.itemId)];
    if (id) return id;
  }
  return state.streamingFallbackByTurn[event.turnId];
}

function clearAssistantStreamingIndices(state: ThreadReducerState, event: ReducerEvent): ThreadReducerState {
  if (!event.turnId) return state;
  let next = state;
  if (event.itemId) {
    const itemKey = compositeKey(event.turnId, event.itemId);
    if (next.streamingByItem[itemKey]) next = { ...next, streamingByItem: removeKey(next.streamingByItem, itemKey) };
  }
  if (next.streamingFallbackByTurn[event.turnId]) next = removeFallbackForTurn(next, event.turnId);
  return next;
}

function refreshAssistantPhase(state: ThreadReducerState, messageId: string, phase: string | undefined): ThreadReducerState {
  if (!phase) return state;
  return mutateMessage(state, messageId, (m) => (m.assistantPhase === phase ? m : { ...m, assistantPhase: phase }));
}

// ─── Reasoning rows ────────────────────────────────────────────────────────────

function appendOrCreateStreamingReasoning(state: ThreadReducerState, event: ReasoningDeltaEvent): ThreadReducerState {
  if (!event.turnId) return state;
  const itemKey = compositeKey(event.turnId, event.itemId ?? "default");
  const existingId = state.streamingReasoningByItem[itemKey];
  if (existingId) {
    return mutateMessage(state, existingId, (m) => ({ ...m, text: m.text + event.delta, isStreaming: true }));
  }
  const message = createMessage({
    threadId: event.threadId,
    role: "system",
    kind: "thinking",
    text: event.delta,
    turnId: event.turnId,
    itemId: event.itemId,
    isStreaming: true,
  });
  const next = appendOrUpdate(state, (messages) => [...messages, message]);
  return { ...next, streamingReasoningByItem: { ...next.streamingReasoningByItem, [itemKey]: message.id } };
}

function completeReasoningRow(state: ThreadReducerState, event: ItemCompletedEvent): ThreadReducerState {
  if (!event.turnId) return state;
  const itemKey = compositeKey(event.turnId, event.itemId ?? "default");
  const messageId = state.streamingReasoningByItem[itemKey];
  if (!messageId) return state;
  const closed = mutateMessage(state, messageId, (m) => ({
    ...m,
    text: event.text ?? m.text,
    isStreaming: false,
  }));
  return { ...closed, streamingReasoningByItem: removeKey(closed.streamingReasoningByItem, itemKey) };
}

// ─── Closing helpers ───────────────────────────────────────────────────────────

function closeStreamingRowsForTurn(state: ThreadReducerState, turnId: string): ThreadReducerState {
  const next = appendOrUpdate(state, (messages) =>
    messages.map((m) => {
      if (m.turnId !== turnId || !m.isStreaming) return m;
      const closed = { ...m, isStreaming: false };
      // Plan presentation transitions from streaming → ready when the turn closes.
      if (closed.plan && closed.plan.presentation === "resultStreaming") {
        closed.plan = { ...closed.plan, presentation: "resultReady" };
      }
      return closed;
    })
  );
  const turnIds = idsForTurn(next.messages, turnId);
  return {
    ...next,
    streamingByItem: filterByValueNotIn(next.streamingByItem, turnIds),
    streamingFallbackByTurn: removeKey(next.streamingFallbackByTurn, turnId),
    streamingReasoningByItem: filterByValueNotIn(next.streamingReasoningByItem, turnIds),
    streamingStructuredByItem: filterByValueNotIn(next.streamingStructuredByItem, turnIds),
    streamingPlanByKey: filterByValueNotIn(next.streamingPlanByKey, turnIds),
  };
}

function removeFallbackForTurn(state: ThreadReducerState, turnId: string): ThreadReducerState {
  if (!state.streamingFallbackByTurn[turnId]) return state;
  return { ...state, streamingFallbackByTurn: removeKey(state.streamingFallbackByTurn, turnId) };
}
