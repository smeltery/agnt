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
  // String id is opaque to consumers — for recency it's a fixed bucket
  // name; for project it's a stable derivation of the cwd. Used as the
  // React key and the persisted "collapsed" state key.
  id: string;
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

/** Group by project directory (`thread.cwd`). Threads without a cwd
 *  cluster under "Other"; pinned threads stay in their own bucket on top
 *  so the user's manual pin order isn't dispersed by project shuffling.
 *
 *  Projects are sorted by their most-recently-updated thread so the
 *  "active" project floats to the top, matching the recency feel. */
export function groupThreadsByProject(threads: CodexThread[], options: GroupOptions): ThreadGroup[] {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const pinned: CodexThread[] = [];
  for (const pinnedId of options.pinnedIds) {
    const thread = threadById.get(pinnedId);
    if (thread) pinned.push(thread);
  }

  // Bucket non-pinned threads by cwd. Threads with no cwd go to the
  // "Other" bucket; we keep that bucket last regardless of recency.
  const byCwd = new Map<string, CodexThread[]>();
  const noCwd: CodexThread[] = [];
  for (const thread of threads) {
    if (options.pinnedIds.has(thread.id)) continue;
    const cwd = thread.cwd?.trim();
    if (!cwd) {
      noCwd.push(thread);
      continue;
    }
    const existing = byCwd.get(cwd);
    if (existing) existing.push(thread);
    else byCwd.set(cwd, [thread]);
  }

  // Sort each cwd-bucket's threads by recency (newest first) so the
  // active conversation in the project sits at the top of its group.
  const recency = (thread: CodexThread): number => thread.updatedAt ?? thread.createdAt ?? 0;
  for (const list of byCwd.values()) {
    list.sort((a, b) => recency(b) - recency(a));
  }

  // Order project groups by their newest thread.
  const entries = Array.from(byCwd.entries());
  entries.sort(([, a], [, b]) => recency(b[0]) - recency(a[0]));

  const groups: ThreadGroup[] = [];
  if (pinned.length > 0) groups.push({ id: "pinned", label: "Pinned", threads: pinned });
  for (const [cwd, list] of entries) {
    groups.push({
      // Prefix with `project:` so the id can't collide with the
      // hardcoded recency ids — collapsedGroups state outlives a
      // grouping-mode switch and we don't want a stale "today" entry
      // to silently match a project group with the same label.
      id: `project:${cwd}`,
      label: shortenCwd(cwd),
      threads: list,
    });
  }
  if (noCwd.length > 0) {
    noCwd.sort((a, b) => recency(b) - recency(a));
    groups.push({ id: "project:__none__", label: "Other", threads: noCwd });
  }
  return groups;
}

/** Render label for a project group: the trailing path component is the
 *  most-identifying part, so we surface it on its own and keep the full
 *  path in a tooltip via the row's existing cwd display. */
function shortenCwd(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return trimmed || cwd;
  return trimmed.slice(idx + 1) || cwd;
}
