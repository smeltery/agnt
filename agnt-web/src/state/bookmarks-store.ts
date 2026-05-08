// Per-thread bookmarked message ids. Pure client-side feature: lets users
// star important messages within a long thread and filter the timeline (or
// the cross-thread palette) to just the starred set.
//
// Membership is the entire contract — we don't store labels, notes, or order.
// Set<messageId> per thread; the persistence layer flattens to string[]
// because IndexedDB doesn't natively encode Set.

import { create } from "zustand";
import { prefsStore } from "../storage/prefs-store";

interface BookmarksState {
  hydrated: boolean;
  byThread: Record<string, Set<string>>;
  hydrate(): Promise<void>;
  toggle(threadId: string, messageId: string): void;
  isBookmarked(threadId: string, messageId: string): boolean;
  countForThread(threadId: string): number;
  clearThread(threadId: string): void;
}

export const useBookmarksStore = create<BookmarksState>((set, get) => ({
  hydrated: false,
  byThread: {},

  async hydrate() {
    if (get().hydrated) return;
    const persisted = await prefsStore.loadBookmarks();
    const byThread: Record<string, Set<string>> = {};
    for (const [threadId, ids] of Object.entries(persisted)) {
      byThread[threadId] = new Set(ids);
    }
    set({ byThread, hydrated: true });
  },

  toggle(threadId, messageId) {
    const current = get().byThread[threadId];
    const next = new Set(current ?? []);
    if (next.has(messageId)) next.delete(messageId);
    else next.add(messageId);
    const byThread = { ...get().byThread };
    if (next.size === 0) delete byThread[threadId];
    else byThread[threadId] = next;
    set({ byThread });
    void persist(byThread);
  },

  isBookmarked(threadId, messageId) {
    return Boolean(get().byThread[threadId]?.has(messageId));
  },

  countForThread(threadId) {
    return get().byThread[threadId]?.size ?? 0;
  },

  clearThread(threadId) {
    if (!get().byThread[threadId]) return;
    const byThread = { ...get().byThread };
    delete byThread[threadId];
    set({ byThread });
    void persist(byThread);
  },
}));

function persist(byThread: Record<string, Set<string>>): Promise<void> {
  const flat: Record<string, string[]> = {};
  for (const [threadId, ids] of Object.entries(byThread)) flat[threadId] = [...ids];
  return prefsStore.saveBookmarks(flat);
}
