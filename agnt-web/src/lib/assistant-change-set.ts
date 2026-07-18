import { computeDiffStats } from "./git-diff-stats";
import type { CodexMessage } from "../models";

export interface AssistantChangeSetPatch {
  id: string;
  path?: string;
  forwardPatch: string;
}

export interface AssistantChangeSetSummary {
  count: number;
  firstId: string;
  insertions: number;
  deletions: number;
  patches: AssistantChangeSetPatch[];
}

export function collectAssistantChangeSet(
  messages: CodexMessage[],
  assistant: Pick<CodexMessage, "threadId" | "turnId">
): AssistantChangeSetSummary | null {
  if (!assistant.threadId || !assistant.turnId) return null;
  let firstId = "";
  let insertions = 0;
  let deletions = 0;
  const patches: AssistantChangeSetPatch[] = [];

  for (const message of messages) {
    if (message.threadId !== assistant.threadId) continue;
    if (message.turnId !== assistant.turnId) continue;
    if (message.kind !== "fileChange") continue;
    const diff = message.fileChange?.diff?.trim();
    if (!diff) continue;
    if (!firstId) firstId = message.id;
    const stats = computeDiffStats(diff);
    insertions += stats.insertions;
    deletions += stats.deletions;
    patches.push({
      id: message.id,
      path: message.fileChange?.path,
      forwardPatch: diff.endsWith("\n") ? diff : `${diff}\n`,
    });
  }

  if (patches.length === 0) return null;
  return { count: patches.length, firstId, insertions, deletions, patches };
}
