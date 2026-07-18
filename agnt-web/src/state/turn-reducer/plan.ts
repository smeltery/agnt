import { createMessage, type PlanState, type PlanStep } from "../../models";
import type { ReducerEvent, ThreadReducerState } from "../turn-reducer";
import { appendOrUpdate, compositeKey, mutateMessage } from "./helpers";

export interface PlanUpdatedEvent extends ReducerEvent {
  explanation?: string;
  steps: PlanStep[];
}

export function applyPlanUpdated(state: ThreadReducerState, event: PlanUpdatedEvent): ThreadReducerState {
  if (!event.turnId) return state;
  const key = compositeKey(event.turnId, "_progress");
  return upsertPlanRow(state, event, key, () => ({
    explanation: event.explanation,
    steps: event.steps,
    presentation: "progress",
  }));
}

export interface PlanDeltaEvent extends ReducerEvent {
  delta: string;
}

export function applyPlanDelta(state: ThreadReducerState, event: PlanDeltaEvent): ThreadReducerState {
  if (!event.turnId || !event.itemId || !event.delta) return state;
  const key = compositeKey(event.turnId, event.itemId);
  const existingId = state.streamingPlanByKey[key];
  if (existingId) {
    return mutateMessage(state, existingId, (m) => ({
      ...m,
      text: m.text + event.delta,
      isStreaming: true,
      plan: { ...(m.plan ?? { steps: [] as PlanStep[], presentation: "resultStreaming" }), presentation: "resultStreaming" },
    }));
  }
  return upsertPlanRow(
    state,
    event,
    key,
    (existing) => existing ?? { steps: [], presentation: "resultStreaming" as const },
    event.delta
  );
}

function upsertPlanRow(
  state: ThreadReducerState,
  event: ReducerEvent,
  key: string,
  buildPlan: (existing: PlanState | undefined) => PlanState,
  appendText?: string
): ThreadReducerState {
  if (!event.turnId) return state;
  const existingId = state.streamingPlanByKey[key];
  if (existingId) {
    return mutateMessage(state, existingId, (m) => ({
      ...m,
      text: appendText ? m.text + appendText : m.text,
      isStreaming: true,
      plan: buildPlan(m.plan),
    }));
  }
  const message = createMessage({
    threadId: event.threadId,
    role: "system",
    kind: "plan",
    text: appendText ?? "",
    turnId: event.turnId,
    itemId: event.itemId,
    isStreaming: true,
    plan: buildPlan(undefined),
  });
  const next = appendOrUpdate(state, (messages) => [...messages, message]);
  return { ...next, streamingPlanByKey: { ...next.streamingPlanByKey, [key]: message.id } };
}
