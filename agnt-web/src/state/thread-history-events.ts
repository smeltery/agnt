import {
  applyItemCompleted,
  applyItemStarted,
  type ThreadReducerState,
} from "./turn-reducer";

interface SyntheticEvent {
  kind: "started" | "completed";
  params: Record<string, unknown>;
}

export function flattenTurnsToEvents(turns: unknown[], threadId: string): SyntheticEvent[] {
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

export function applyHistoryEvent(state: ThreadReducerState, event: SyntheticEvent): ThreadReducerState {
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
