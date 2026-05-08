// CodexMessage equivalent. Mirrors the field set from
// AgntMobile/Models/CodexMessage.swift so the reducer + persistence behave the
// same way the iOS client does.

import { orderCounter } from "./order-counter";

export type MessageRole = "user" | "assistant" | "system";

/**
 * High-level row category. The UI dispatches on this to pick a renderer
 * (assistant prose vs reasoning vs tool call vs file change vs plan vs prompt).
 */
export type MessageKind =
  | "chat"
  | "thinking"
  | "toolActivity"
  | "fileChange"
  | "commandExecution"
  | "subagentAction"
  | "plan"
  | "userInputPrompt";

export type DeliveryState = "pending" | "confirmed" | "failed";

export interface CommandExecutionDetails {
  fullCommand: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  outputTail: string; // last N lines, see appendOutput()
}

export const COMMAND_OUTPUT_MAX_LINES = 30;

export function appendCommandOutput(details: CommandExecutionDetails, chunk: string): CommandExecutionDetails {
  const merged = `${details.outputTail}${chunk}`;
  const lines = merged.split("\n");
  const tail = lines.length > COMMAND_OUTPUT_MAX_LINES ? lines.slice(-COMMAND_OUTPUT_MAX_LINES).join("\n") : merged;
  return { ...details, outputTail: tail };
}

export interface FileChangeDetails {
  path?: string;
  diff: string; // unified diff body
}

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed" | "failed";
}

export interface PlanState {
  explanation?: string;
  steps: PlanStep[];
  presentation: "progress" | "resultStreaming" | "resultReady" | "resultClosed";
}

export interface CodexMessage {
  id: string;
  threadId: string;
  role: MessageRole;
  kind: MessageKind;
  /** Optional sub-phase tag (e.g. "planning", "final_answer") published by the bridge. */
  assistantPhase?: string;
  text: string;
  createdAt: number; // ms epoch
  turnId?: string;
  itemId?: string;
  isStreaming: boolean;
  deliveryState: DeliveryState;
  command?: CommandExecutionDetails;
  fileChange?: FileChangeDetails;
  plan?: PlanState;
  /** Stable insertion order; primary sort key. */
  orderIndex: number;
}

export interface CreateMessageInput {
  id?: string;
  threadId: string;
  role: MessageRole;
  kind?: MessageKind;
  assistantPhase?: string;
  text?: string;
  createdAt?: number;
  turnId?: string;
  itemId?: string;
  isStreaming?: boolean;
  deliveryState?: DeliveryState;
  command?: CommandExecutionDetails;
  fileChange?: FileChangeDetails;
  plan?: PlanState;
  orderIndex?: number;
}

export function createMessage(input: CreateMessageInput): CodexMessage {
  return {
    id: input.id ?? crypto.randomUUID(),
    threadId: input.threadId,
    role: input.role,
    kind: input.kind ?? "chat",
    assistantPhase: input.assistantPhase,
    text: input.text ?? "",
    createdAt: input.createdAt ?? Date.now(),
    turnId: input.turnId,
    itemId: input.itemId,
    isStreaming: input.isStreaming ?? false,
    deliveryState: input.deliveryState ?? "confirmed",
    command: input.command,
    fileChange: input.fileChange,
    plan: input.plan,
    orderIndex: input.orderIndex ?? orderCounter.next(),
  };
}

export function compareMessages(a: CodexMessage, b: CodexMessage): number {
  if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
  return a.createdAt - b.createdAt;
}
