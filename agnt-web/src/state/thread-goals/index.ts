import { create } from "zustand";
import { makeLogger } from "../../lib/log";
import type { Connection } from "../../protocol";
import { decodeThreadGoalEnvelope, type ThreadGoal } from "../../models";

const log = makeLogger("thread-goals");

interface ThreadGoalsState {
  byThread: Record<string, ThreadGoal>;
  bind(connection: Connection): void;
  refresh(threadId: string): Promise<void>;
  setGoal(input: { threadId: string; objective?: string; status?: ThreadGoal["status"]; tokenBudget?: number | null }): Promise<boolean>;
  clear(threadId: string): Promise<boolean>;
  reset(): void;
}

interface GoalRpc {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

let activeConnection: Connection | null = null;
const teardownHandlers: Array<() => void> = [];

export const useThreadGoalsStore = create<ThreadGoalsState>((set, get) => ({
  byThread: {},

  bind(connection) {
    while (teardownHandlers.length) teardownHandlers.pop()?.();
    activeConnection = connection;
    teardownHandlers.push(connection.rpc.onNotification("thread/goal/updated", (params) => {
      const goal = decodeThreadGoalEnvelope(params, readString(params, "threadId"));
      if (goal) set({ byThread: patchGoal(get().byThread, goal.threadId, goal) });
    }));
    teardownHandlers.push(connection.rpc.onNotification("thread/goal/cleared", (params) => {
      const threadId = readString(params, "threadId");
      if (threadId) set({ byThread: patchGoal(get().byThread, threadId, null) });
    }));
  },

  async refresh(threadId) {
    if (!activeConnection?.rpc || !threadId) return;
    try {
      set({ byThread: patchGoal(get().byThread, threadId, await readGoal(activeConnection.rpc, threadId)) });
    } catch (error) {
      if (isUnsupportedGoalError(error)) set({ byThread: patchGoal(get().byThread, threadId, null) });
      else log.warn("thread/goal/get failed", error);
    }
  },

  async setGoal(input) {
    if (!activeConnection?.rpc || !input.threadId) return false;
    try {
      const goal = await writeGoal(activeConnection.rpc, input);
      if (goal) set({ byThread: patchGoal(get().byThread, input.threadId, goal) });
      return Boolean(goal);
    } catch (error) {
      log.warn(goalErrorMessage(error));
      return false;
    }
  },

  async clear(threadId) {
    if (!activeConnection?.rpc || !threadId) return false;
    try {
      await activeConnection.rpc.request("thread/goal/clear", { threadId });
      set({ byThread: patchGoal(get().byThread, threadId, null) });
      return true;
    } catch (error) {
      log.warn(goalErrorMessage(error));
      return false;
    }
  },

  reset() {
    while (teardownHandlers.length) teardownHandlers.pop()?.();
    activeConnection = null;
    set({ byThread: {} });
  },
}));

async function readGoal(rpc: GoalRpc, threadId: string): Promise<ThreadGoal | null> {
  const response = await rpc.request<Record<string, unknown>>("thread/goal/get", { threadId });
  return decodeThreadGoalEnvelope(response, threadId);
}

async function writeGoal(
  rpc: GoalRpc,
  input: { threadId: string; objective?: string; status?: ThreadGoal["status"]; tokenBudget?: number | null }
): Promise<ThreadGoal | null> {
  const params: Record<string, unknown> = { threadId: input.threadId };
  if (input.objective !== undefined) params.objective = input.objective;
  if (input.status !== undefined) params.status = input.status;
  if (input.tokenBudget !== undefined) params.tokenBudget = input.tokenBudget;
  return decodeThreadGoalEnvelope(await rpc.request<Record<string, unknown>>("thread/goal/set", params), input.threadId);
}

function patchGoal(
  current: Record<string, ThreadGoal>,
  threadId: string,
  goal: ThreadGoal | null
): Record<string, ThreadGoal> {
  const next = { ...current };
  if (goal) next[threadId] = goal;
  else delete next[threadId];
  return next;
}

function goalErrorMessage(error: unknown): string {
  return isUnsupportedGoalError(error) ? "This provider does not support thread goals." : (error as Error).message;
}

function isUnsupportedGoalError(error: unknown): boolean {
  const code = (error as { code?: number })?.code;
  if (code === -32601 || code === -32004) return true;
  const message = (error as { message?: string })?.message?.toLowerCase() ?? "";
  return message.includes("method not found")
    || message.includes("goals feature is disabled")
    || message.includes("does not support goals")
    || message.includes("thread goals require");
}

function readString(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
