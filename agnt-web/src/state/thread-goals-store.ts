import { create } from "zustand";
import { makeLogger } from "../lib/log";
import type { Connection } from "../protocol";
import type { ThreadGoal } from "../models";
import {
  isUnsupportedGoalError,
  patchThreadGoalMap,
  readThreadGoal,
  removeThreadGoal,
  writeThreadGoal,
} from "./thread-goal-utils";
import { decodeThreadGoalEnvelope } from "../models";

const log = makeLogger("thread-goals");

interface ThreadGoalsState {
  byThread: Record<string, ThreadGoal>;
  bind(connection: Connection): void;
  refresh(threadId: string): Promise<void>;
  setGoal(input: { threadId: string; objective?: string; status?: ThreadGoal["status"]; tokenBudget?: number | null }): Promise<boolean>;
  clear(threadId: string): Promise<boolean>;
  reset(): void;
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
      if (goal) set({ byThread: patchThreadGoalMap(get().byThread, goal.threadId, goal) });
    }));
    teardownHandlers.push(connection.rpc.onNotification("thread/goal/cleared", (params) => {
      const threadId = readString(params, "threadId");
      if (threadId) set({ byThread: patchThreadGoalMap(get().byThread, threadId, null) });
    }));
  },

  async refresh(threadId) {
    if (!activeConnection?.rpc || !threadId) return;
    try {
      set({ byThread: patchThreadGoalMap(get().byThread, threadId, await readThreadGoal(activeConnection.rpc, threadId)) });
    } catch (error) {
      if (isUnsupportedGoalError(error)) set({ byThread: patchThreadGoalMap(get().byThread, threadId, null) });
      else log.warn("thread/goal/get failed", error);
    }
  },

  async setGoal(input) {
    if (!activeConnection?.rpc || !input.threadId) return false;
    try {
      const goal = await writeThreadGoal(activeConnection.rpc, input);
      if (goal) set({ byThread: patchThreadGoalMap(get().byThread, input.threadId, goal) });
      return Boolean(goal);
    } catch (error) {
      log.warn(goalErrorMessage(error));
      return false;
    }
  },

  async clear(threadId) {
    if (!activeConnection?.rpc || !threadId) return false;
    try {
      await removeThreadGoal(activeConnection.rpc, threadId);
      set({ byThread: patchThreadGoalMap(get().byThread, threadId, null) });
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

function goalErrorMessage(error: unknown): string {
  return isUnsupportedGoalError(error) ? "This provider does not support thread goals." : (error as Error).message;
}

function readString(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
