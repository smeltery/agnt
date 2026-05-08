// Small file-browser cache. The browser pane is keyed by the active thread's
// `cwd`; each directory's listing is fetched lazily on first expand and
// cached so re-collapsing + re-expanding stays instant. We don't try to
// invalidate against filesystem mutations — the user can hit Refresh on the
// pane to reload the current cwd.

import { create } from "zustand";
import { listDirectory, type ProjectDirectoryEntry } from "../protocol/project";
import type { JsonRpcClient } from "../protocol/jsonrpc-client";

export interface DirectoryListing {
  path: string;
  entries: ProjectDirectoryEntry[];
}

interface FileBrowserState {
  /** Path → cached listing. The cache is global rather than per-thread so
   *  switching threads inside the same monorepo keeps listings warm. */
  listings: Record<string, DirectoryListing>;
  loading: Record<string, boolean>;
  error: Record<string, string>;
  expanded: Set<string>;
  loadDirectory(rpc: JsonRpcClient, path: string): Promise<void>;
  toggleExpanded(path: string): void;
  invalidate(path: string): void;
  reset(): void;
}

export const useFileBrowserStore = create<FileBrowserState>((set, get) => ({
  listings: {},
  loading: {},
  error: {},
  expanded: new Set(),

  async loadDirectory(rpc, path) {
    if (get().loading[path]) return;
    set({ loading: { ...get().loading, [path]: true } });
    try {
      const listing = await listDirectory(rpc, { path, limit: 200 });
      set({
        listings: { ...get().listings, [path]: { path: listing.path || path, entries: listing.entries } },
        error: omit(get().error, path),
      });
    } catch (failure) {
      set({ error: { ...get().error, [path]: (failure as Error).message } });
    } finally {
      set({ loading: omit(get().loading, path) });
    }
  },

  toggleExpanded(path) {
    const next = new Set(get().expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set({ expanded: next });
  },

  invalidate(path) {
    set({
      listings: omit(get().listings, path),
      error: omit(get().error, path),
    });
  },

  reset() {
    set({ listings: {}, loading: {}, error: {}, expanded: new Set() });
  },
}));

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}
