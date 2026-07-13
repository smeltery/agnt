import type { ThreadGoal } from "../models";
import { decodeThreadGoalEnvelope } from "../models";

interface GoalRpc {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export async function readThreadGoal(rpc: GoalRpc, threadId: string): Promise<ThreadGoal | null> {
  const response = await rpc.request<Record<string, unknown>>("thread/goal/get", { threadId });
  return decodeThreadGoalEnvelope(response, threadId);
}

export async function writeThreadGoal(
  rpc: GoalRpc,
  input: { threadId: string; objective?: string; status?: ThreadGoal["status"]; tokenBudget?: number | null }
): Promise<ThreadGoal | null> {
  const params: Record<string, unknown> = { threadId: input.threadId };
  if (input.objective !== undefined) params.objective = input.objective;
  if (input.status !== undefined) params.status = input.status;
  if (input.tokenBudget !== undefined) params.tokenBudget = input.tokenBudget;
  const response = await rpc.request<Record<string, unknown>>("thread/goal/set", params);
  return decodeThreadGoalEnvelope(response, input.threadId);
}

export async function removeThreadGoal(rpc: GoalRpc, threadId: string): Promise<void> {
  await rpc.request("thread/goal/clear", { threadId });
}

export function patchThreadGoalMap(
  current: Record<string, ThreadGoal>,
  threadId: string,
  goal: ThreadGoal | null
): Record<string, ThreadGoal> {
  const next = { ...current };
  if (goal) next[threadId] = goal;
  else delete next[threadId];
  return next;
}

export function isUnsupportedGoalError(error: unknown): boolean {
  const code = (error as { code?: number })?.code;
  if (code === -32601 || code === -32004) return true;
  const message = (error as { message?: string })?.message?.toLowerCase() ?? "";
  return message.includes("method not found")
    || message.includes("goals feature is disabled")
    || message.includes("does not support goals")
    || message.includes("thread goals require");
}
