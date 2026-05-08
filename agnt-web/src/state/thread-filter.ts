// Pure thread filter. Input is whatever the user typed; output is the subset
// of threads matching against title / name / cwd / agent metadata. Pure
// function so the sidebar can stay dumb and the matcher can be unit-tested.

import type { CodexThread } from "../models";

export function filterThreads<T extends CodexThread>(threads: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return threads;
  return threads.filter((thread) => threadMatches(thread, normalized));
}

function threadMatches(thread: CodexThread, needle: string): boolean {
  const haystacks = [
    thread.title,
    thread.name,
    thread.preview,
    thread.cwd,
    thread.agentNickname,
    thread.agentRole,
    thread.model,
    thread.modelProvider,
  ];
  for (const candidate of haystacks) {
    if (typeof candidate !== "string") continue;
    if (candidate.toLowerCase().includes(needle)) return true;
  }
  return false;
}
