// One-slot pending "scroll into view this message id" used by deep-link
// boot. The Workspace publishes when it parses a `#thread/<t>/message/<m>`
// hash; ChatView consumes once the matching thread's messages have
// hydrated. Mismatches stay queued until the user navigates to the right
// thread (same single-slot pattern as composer-inbox-store).

import { create } from "zustand";

interface ChatFocusState {
  pendingMessageId: { threadId: string; messageId: string } | null;
  request(threadId: string, messageId: string): void;
  consume(threadId: string): string | null;
  clear(): void;
}

export const useChatFocusStore = create<ChatFocusState>((set, get) => ({
  pendingMessageId: null,
  request(threadId, messageId) {
    set({ pendingMessageId: { threadId, messageId } });
  },
  consume(threadId) {
    const pending = get().pendingMessageId;
    if (!pending || pending.threadId !== threadId) return null;
    set({ pendingMessageId: null });
    return pending.messageId;
  },
  clear() {
    set({ pendingMessageId: null });
  },
}));
