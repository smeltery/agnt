// Per-thread composer drafts. Switching threads or reloading the tab used to
// drop whatever the user had typed; this keeps a tiny IndexedDB-backed map
// keyed by threadId so unfinished prompts survive both. Empty drafts are
// removed rather than stored as "" so we don't accumulate dead entries.
//
// We keep the on-disk shape flat and additive — older blobs without the
// fields a future feature might add still load cleanly.

import { idb } from "./idb";

const DRAFTS_KEY = "composer.drafts";

type DraftMap = Record<string, string>;

let cachedMap: DraftMap | null = null;

async function loadMap(): Promise<DraftMap> {
  if (cachedMap) return cachedMap;
  const raw = (await idb.get<DraftMap>(DRAFTS_KEY)) ?? {};
  cachedMap = raw;
  return raw;
}

export const draftsStore = {
  async load(threadId: string): Promise<string> {
    if (!threadId) return "";
    const map = await loadMap();
    return map[threadId] ?? "";
  },
  async save(threadId: string, draft: string): Promise<void> {
    if (!threadId) return;
    const map = await loadMap();
    if (!draft.trim()) {
      // Empty drafts are noise. Remove the entry so the store stays small.
      if (!(threadId in map)) return;
      delete map[threadId];
    } else if (map[threadId] === draft) {
      return;
    } else {
      map[threadId] = draft;
    }
    await idb.set(DRAFTS_KEY, map);
  },
  async clear(threadId: string): Promise<void> {
    if (!threadId) return;
    const map = await loadMap();
    if (!(threadId in map)) return;
    delete map[threadId];
    await idb.set(DRAFTS_KEY, map);
  },
  /** Test-only: drop the in-memory cache so a fresh idb read happens. */
  __resetForTests(): void {
    cachedMap = null;
  },
};
