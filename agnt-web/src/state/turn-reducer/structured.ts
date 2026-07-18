import { createMessage, type MessageKind } from "../../models";
import type { ItemCompletedEvent, ItemStartedEvent, ThreadReducerState } from "../turn-reducer";
import { appendOrUpdate, compositeKey, mutateMessage, removeKey } from "./helpers";

export function beginStructuredItem(
  state: ThreadReducerState,
  event: ItemStartedEvent,
  kind: MessageKind
): ThreadReducerState {
  if (!event.turnId || !event.itemId) return state;
  const itemKey = compositeKey(event.turnId, event.itemId);
  if (state.streamingStructuredByItem[itemKey]) return state;
  const message = createMessage({
    threadId: event.threadId,
    role: "system",
    kind,
    turnId: event.turnId,
    itemId: event.itemId,
    isStreaming: true,
    command:
      kind === "commandExecution"
        ? { fullCommand: "", outputTail: "" }
        : undefined,
    fileChange: kind === "fileChange" ? { diff: "" } : undefined,
  });
  const next = appendOrUpdate(state, (messages) => [...messages, message]);
  return { ...next, streamingStructuredByItem: { ...next.streamingStructuredByItem, [itemKey]: message.id } };
}

export function completeStructuredItem(
  state: ThreadReducerState,
  event: ItemCompletedEvent,
  kind: MessageKind
): ThreadReducerState {
  if (!event.turnId || !event.itemId) return state;
  const itemKey = compositeKey(event.turnId, event.itemId);
  const messageId = state.streamingStructuredByItem[itemKey];
  if (!messageId) return state;
  const closed = mutateMessage(state, messageId, (m) => ({
    ...m,
    isStreaming: false,
    text: event.text ?? m.text,
    kind,
    command:
      m.command && kind === "commandExecution"
        ? { ...m.command, exitCode: event.exitCode ?? m.command.exitCode, durationMs: event.durationMs ?? m.command.durationMs }
        : m.command,
    fileChange:
      kind === "fileChange"
        ? { path: event.filePath ?? m.fileChange?.path, diff: event.diff ?? m.fileChange?.diff ?? m.text }
        : m.fileChange,
  }));
  return { ...closed, streamingStructuredByItem: removeKey(closed.streamingStructuredByItem, itemKey) };
}
