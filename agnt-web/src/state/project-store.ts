// Project picker state. Owns the current browse path, listing/search results,
// and a debounced search-on-type. Used by the New-Chat flow to pick a cwd
// before issuing thread/start, and surfaceable from the chat header for
// switching projects on an existing thread.

import { create } from "zustand";
import { makeLogger } from "../lib/log";
import type { JsonRpcClient } from "../protocol/jsonrpc-client";
import {
  fetchQuickLocations,
  listDirectory,
  type ProjectDirectoryEntry,
  type ProjectQuickLocation,
  searchDirectories,
} from "../protocol/project";

const log = makeLogger("project");

interface State {
  open: boolean;
  loading: boolean;
  error: string | null;
  quickLocations: ProjectQuickLocation[];
  currentPath: string | null;
  parentPath: string | null;
  entries: ProjectDirectoryEntry[];
  /** Most recent search query; empty string means listing mode. */
  query: string;
  /** Last selected path the caller (e.g. New Chat flow) can read on close. */
  selectedPath: string | null;

  show(rpc: JsonRpcClient, options?: { startPath?: string }): Promise<void>;
  hide(): void;
  navigate(rpc: JsonRpcClient, path: string): Promise<void>;
  ascend(rpc: JsonRpcClient): Promise<void>;
  setQuery(rpc: JsonRpcClient, query: string): void;
  select(path: string): void;
  reset(): void;
}

let searchHandle: ReturnType<typeof setTimeout> | null = null;

export const useProjectStore = create<State>((set, get) => ({
  open: false,
  loading: false,
  error: null,
  quickLocations: [],
  currentPath: null,
  parentPath: null,
  entries: [],
  query: "",
  selectedPath: null,

  async show(rpc, options = {}) {
    set({ open: true, loading: true, error: null, query: "", selectedPath: null });
    try {
      // Quick locations seed the picker on open. We don't depend on them being
      // present — if the bridge is restricted (e.g. AGNT_PROJECT_ROOTS), an
      // empty list still lets the user descend from a known path.
      const [quickLocations] = await Promise.all([fetchQuickLocations(rpc).catch((error) => {
        log.warn("quickLocations failed", error);
        return [] as ProjectQuickLocation[];
      })]);
      const startPath = options.startPath ?? quickLocations[0]?.path ?? null;
      set({ quickLocations });
      if (startPath) await get().navigate(rpc, startPath);
      else set({ loading: false });
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
    }
  },

  hide() {
    if (searchHandle) {
      clearTimeout(searchHandle);
      searchHandle = null;
    }
    set({ open: false });
  },

  async navigate(rpc, path) {
    set({ loading: true, error: null, query: "" });
    try {
      const listing = await listDirectory(rpc, { path });
      set({
        loading: false,
        currentPath: listing.path,
        parentPath: listing.parentPath,
        entries: listing.entries,
      });
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
    }
  },

  async ascend(rpc) {
    const { parentPath } = get();
    if (!parentPath) return;
    await get().navigate(rpc, parentPath);
  },

  setQuery(rpc, nextQuery) {
    set({ query: nextQuery });
    if (searchHandle) clearTimeout(searchHandle);
    const trimmed = nextQuery.trim();
    if (!trimmed) {
      // Empty query → reload listing so we don't leave stale matches on screen.
      const path = get().currentPath;
      if (path) void get().navigate(rpc, path);
      return;
    }
    // Debounce so each keystroke doesn't fan out an RPC.
    searchHandle = setTimeout(() => {
      const path = get().currentPath;
      if (!path) return;
      void runSearch(rpc, path, trimmed, set);
    }, 200);
  },

  select(path) {
    set({ selectedPath: path });
  },

  reset() {
    if (searchHandle) {
      clearTimeout(searchHandle);
      searchHandle = null;
    }
    set({
      open: false,
      loading: false,
      error: null,
      quickLocations: [],
      currentPath: null,
      parentPath: null,
      entries: [],
      query: "",
      selectedPath: null,
    });
  },
}));

async function runSearch(
  rpc: JsonRpcClient,
  path: string,
  query: string,
  set: (partial: Partial<State>) => void
): Promise<void> {
  set({ loading: true, error: null });
  try {
    const result = await searchDirectories(rpc, { path, query });
    set({ loading: false, entries: result.entries });
  } catch (error) {
    set({ loading: false, error: errorMessage(error) });
  }
}

function errorMessage(error: unknown): string {
  return (error as Error)?.message ?? "Project picker failed.";
}

// Test helper: keeping activeRpc isolated so tests can clear between cases.
export function __resetProjectStoreForTests(): void {
  useProjectStore.getState().reset();
}
