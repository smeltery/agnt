// Whitespace-insensitive replay detector. Faithful port of
// AssistantReplayDeduper.swift. Used by the turn reducer when item/completed
// arrives so we don't duplicate a final assistant row that's already in the
// timeline (single-row replay) or that's the concatenation of several existing
// rows (block replay — common after a reconnect history merge).

import type { CodexMessage } from "../models";

export interface ReplayCandidate {
  threadId: string;
  turnId?: string;
  text: string;
  excludingMessageId?: string;
}

export const replayDeduper = {
  /** True if `text` matches a single existing assistant message in the same turn. */
  isExactReplay(messages: CodexMessage[], candidate: ReplayCandidate): boolean {
    return findExactReplayIndex(messages, candidate) !== null;
  },

  /**
   * True if `text` is the (whitespace-tolerant) concatenation of several
   * existing assistant messages in the same turn — i.e. the bridge re-sent the
   * full transcript as one item/completed after streaming several deltas.
   */
  isBlockReplay(messages: CodexMessage[], candidate: ReplayCandidate): boolean {
    return findBlockReplayIndices(messages, candidate) !== null;
  },

  isReplay(messages: CodexMessage[], candidate: ReplayCandidate): boolean {
    return replayDeduper.isExactReplay(messages, candidate) || replayDeduper.isBlockReplay(messages, candidate);
  },

  /**
   * If the incoming text is a block replay of multiple existing rows, return
   * the index of the LAST row in that block — the caller can stamp it as the
   * canonical final row and skip inserting a duplicate.
   */
  findBlockTerminalIndex(messages: CodexMessage[], candidate: ReplayCandidate): number | null {
    const indices = findBlockReplayIndices(messages, candidate);
    return indices ? indices[indices.length - 1] : null;
  },
};

function findExactReplayIndex(messages: CodexMessage[], candidate: ReplayCandidate): number | null {
  const incomingTokens = tokenize(candidate.text);
  if (incomingTokens.length === 0) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistantTurnRow(message, candidate)) continue;
    if (message.id === candidate.excludingMessageId) continue;
    if (tokensEqual(tokenize(message.text), incomingTokens)) return index;
  }
  return null;
}

function findBlockReplayIndices(messages: CodexMessage[], candidate: ReplayCandidate): number[] | null {
  const incomingTokens = tokenize(candidate.text);
  if (incomingTokens.length === 0) return null;
  // Find the contiguous tail of assistant rows in the same turn, then check if
  // their concatenation matches the incoming text.
  const matchingIndices: number[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistantTurnRow(message, candidate)) continue;
    if (message.id === candidate.excludingMessageId) continue;
    matchingIndices.push(index);
    if (matchingIndices.length < 2) continue;
    const orderedIndices = [...matchingIndices].reverse();
    const concatenation = orderedIndices.flatMap((idx) => tokenize(messages[idx].text));
    if (tokensEqual(concatenation, incomingTokens)) return orderedIndices;
  }
  return null;
}

function isAssistantTurnRow(message: CodexMessage, candidate: ReplayCandidate): boolean {
  if (message.threadId !== candidate.threadId) return false;
  if (message.role !== "assistant") return false;
  if (candidate.turnId !== undefined && message.turnId !== candidate.turnId) return false;
  return true;
}

function tokenize(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

function tokensEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
