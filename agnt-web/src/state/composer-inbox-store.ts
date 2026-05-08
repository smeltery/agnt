// Tiny one-slot inbox so message rows (Reply / quote) can ask the composer
// to prepend text into its current draft. The composer owns the actual
// draft string locally — lifting it into a global store would force a
// re-render of every row on every keystroke, which is exactly the cost we
// avoided in earlier sessions.
//
// The producer publishes `{threadId, body}`; the composer effect consumes
// it on the next render only if it matches the active thread. Mismatches
// stay queued until the user switches threads.

import { create } from "zustand";

export interface ComposerPrependRequest {
  threadId: string;
  body: string;
}

interface ComposerInboxState {
  pending: ComposerPrependRequest | null;
  request(request: ComposerPrependRequest): void;
  consume(threadId: string): string | null;
}

export const useComposerInboxStore = create<ComposerInboxState>((set, get) => ({
  pending: null,
  request(request) {
    set({ pending: request });
  },
  consume(threadId) {
    const pending = get().pending;
    if (!pending || pending.threadId !== threadId) return null;
    set({ pending: null });
    return pending.body;
  },
}));
