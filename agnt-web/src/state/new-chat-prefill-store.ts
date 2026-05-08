// One-shot prefill slot for the New Chat modal. Currently used by the
// "Duplicate thread" context-menu action: the source thread's cwd + first
// user prompt are stamped here, then `Workspace` reads + clears the slot
// when it opens the modal.
//
// Single-slot by design — there's only ever one New Chat modal in flight,
// and stale values would be more confusing than helpful if a user opened
// the picker twice.

import { create } from "zustand";

export interface NewChatPrefill {
  cwd?: string;
  prompt?: string;
}

interface State {
  pending: NewChatPrefill | null;
  /** Set the prefill and signal `Workspace` to open the modal. The bumping
   *  `requestedAt` lets a Workspace effect fire even if the prefill payload
   *  hasn't otherwise changed. */
  request(prefill: NewChatPrefill): void;
  /** Read + clear the pending prefill. Returns null if nothing's queued. */
  consume(): NewChatPrefill | null;
}

export const useNewChatPrefillStore = create<State>((set, get) => ({
  pending: null,
  request(prefill) {
    set({ pending: { ...prefill } });
  },
  consume() {
    const value = get().pending;
    if (value) set({ pending: null });
    return value;
  },
}));
