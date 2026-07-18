import { prefsStore } from "../storage/prefs-store";
import type { ThreadsState } from "./threads-store";

export function bumpVisitIfActive(
  threadId: string,
  set: (partial: Partial<ThreadsState>) => void,
  get: () => ThreadsState
): void {
  if (get().selectedThreadId !== threadId) return;
  const next = { ...get().lastVisitedByThread, [threadId]: Date.now() };
  set({ lastVisitedByThread: next });
  void prefsStore.saveLastVisited(next);
}
