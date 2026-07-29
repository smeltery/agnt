// Per-thread message cache. Hydrating this on app boot makes reconnects render
// the full prior timeline without waiting for a `thread/read` round-trip.

import type { CodexMessage } from "../models";
import { idb } from "./idb";

const KEY_PREFIX = "messages:";
// Caps the persisted history per thread to keep IndexedDB writes cheap. Older
// rows can always be re-fetched via thread/turns/list.
export const MAX_PERSISTED_PER_THREAD = 50;

export const messagesStore = {
  async load(threadId: string): Promise<CodexMessage[]> {
    return (await idb.get<CodexMessage[]>(KEY_PREFIX + threadId)) ?? [];
  },
  async save(threadId: string, messages: CodexMessage[]): Promise<void> {
    const trimmed = messages.length > MAX_PERSISTED_PER_THREAD ? messages.slice(-MAX_PERSISTED_PER_THREAD) : messages;
    await idb.set(KEY_PREFIX + threadId, trimmed);
  },
  async clear(threadId: string): Promise<void> {
    await idb.remove(KEY_PREFIX + threadId);
  },
  async loadHighestOrderIndex(): Promise<number> {
    // Used to seed the order counter so newly-created rows after boot sort
    // after rows already on disk. Implemented as a per-thread scan because the
    // tiny idb wrapper doesn't expose a cursor; cheap in practice.
    const knownThreadIds = (await idb.get<string[]>(`${KEY_PREFIX}__index`)) ?? [];
    let max = -1;
    for (const threadId of knownThreadIds) {
      const messages = await idb.get<CodexMessage[]>(KEY_PREFIX + threadId);
      if (!messages) continue;
      for (const message of messages) if (message.orderIndex > max) max = message.orderIndex;
    }
    return max;
  },
  async registerThread(threadId: string): Promise<void> {
    const known = (await idb.get<string[]>(`${KEY_PREFIX}__index`)) ?? [];
    if (known.includes(threadId)) return;
    known.push(threadId);
    await idb.set(`${KEY_PREFIX}__index`, known);
  },
};
