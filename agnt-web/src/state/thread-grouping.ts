// Group threads into recency buckets (Today / Yesterday / This week / Earlier)
// for the sidebar. Pure function so the partition can be tested without a
// DOM env. Pinned threads are kept separate via a Pinned bucket that always
// sorts first.
//
// "Recency" reads from `updatedAt` first, then `createdAt` — both are
// optional (the bridge doesn't always include either), so a thread missing
// both ends up under "Earlier" rather than at the top.

import type { CodexThread } from "../models";

export interface ThreadGroup {
  id: "pinned" | "today" | "yesterday" | "thisWeek" | "earlier";
  label: string;
  threads: CodexThread[];
}

export interface GroupOptions {
  pinnedIds: ReadonlySet<string>;
  /** Reference "now" in milliseconds — pass a constant for deterministic tests. */
  nowMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function groupThreadsByRecency(threads: CodexThread[], options: GroupOptions): ThreadGroup[] {
  const now = options.nowMs ?? Date.now();
  const startOfToday = startOfDay(now);
  const startOfYesterday = startOfToday - DAY_MS;
  const startOfThisWeek = startOfToday - 6 * DAY_MS; // Today + previous 6 = "this week"

  // Pinned bucket follows pin-list iteration order so the user's manual
  // ordering survives. We index threads by id once so the lookup stays O(1)
  // per pin even on big lists.
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const pinned: CodexThread[] = [];
  for (const pinnedId of options.pinnedIds) {
    const thread = threadById.get(pinnedId);
    if (thread) pinned.push(thread);
  }

  const today: CodexThread[] = [];
  const yesterday: CodexThread[] = [];
  const thisWeek: CodexThread[] = [];
  const earlier: CodexThread[] = [];

  for (const thread of threads) {
    if (options.pinnedIds.has(thread.id)) continue;
    const timestamp = thread.updatedAt ?? thread.createdAt ?? 0;
    if (timestamp >= startOfToday) today.push(thread);
    else if (timestamp >= startOfYesterday) yesterday.push(thread);
    else if (timestamp >= startOfThisWeek) thisWeek.push(thread);
    else earlier.push(thread);
  }

  const groups: ThreadGroup[] = [];
  if (pinned.length > 0) groups.push({ id: "pinned", label: "Pinned", threads: pinned });
  if (today.length > 0) groups.push({ id: "today", label: "Today", threads: today });
  if (yesterday.length > 0) groups.push({ id: "yesterday", label: "Yesterday", threads: yesterday });
  if (thisWeek.length > 0) groups.push({ id: "thisWeek", label: "This week", threads: thisWeek });
  if (earlier.length > 0) groups.push({ id: "earlier", label: "Earlier", threads: earlier });
  return groups;
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
