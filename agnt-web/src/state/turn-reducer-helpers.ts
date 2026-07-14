import { type CodexMessage, compareMessages, type MessageKind } from "../models";
import type { ThreadReducerState } from "./turn-reducer";

export function appendOrUpdate(
  state: ThreadReducerState,
  mutator: (messages: CodexMessage[]) => CodexMessage[]
): ThreadReducerState {
  const messages = mutator(state.messages).sort(compareMessages);
  return { ...state, messages };
}

export function mutateMessage(
  state: ThreadReducerState,
  messageId: string,
  patch: (message: CodexMessage) => CodexMessage
): ThreadReducerState {
  const index = state.messages.findIndex((m) => m.id === messageId);
  if (index < 0) return state;
  const messages = state.messages.slice();
  messages[index] = patch(messages[index]);
  return { ...state, messages };
}

export function compositeKey(turnId: string, itemId?: string): string {
  return `${turnId}::${itemId ?? "_"}`;
}

export function idsForTurn(messages: CodexMessage[], turnId: string): Set<string> {
  return new Set(messages.filter((m) => m.turnId === turnId).map((m) => m.id));
}

export function removeKey<T extends Record<string, V>, V>(record: T, key: string): T {
  if (!(key in record)) return record;
  const next = { ...record } as Record<string, V>;
  delete next[key];
  return next as T;
}

export function filterByValueNotIn<T extends Record<string, string>>(record: T, exclude: Set<string>): T {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) if (!exclude.has(value)) next[key] = value;
  return next as T;
}

export function inferKindFromType(type: string | undefined): MessageKind {
  switch ((type ?? "").toLowerCase()) {
    case "agentmessage":
    case "assistantmessage":
      return "chat";
    case "reasoning":
      return "thinking";
    case "filechange":
      return "fileChange";
    case "commandexecution":
      return "commandExecution";
    case "toolcall":
    case "collabtoolcall":
    case "collabagenttoolcall":
      return "toolActivity";
    case "plan":
      return "plan";
    case "userinputprompt":
      return "userInputPrompt";
    default:
      return "chat";
  }
}
