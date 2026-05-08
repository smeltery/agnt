// Git actions cache. Mirrors AgntMobile's GitActionsService minus the worktree
// flows (which depend on iOS-specific UX). Per-thread because git status is
// cwd-scoped and iOS keeps the same partition.

import { create } from "zustand";
import type { JsonRpcClient } from "../protocol/jsonrpc-client";

export interface GitChangedFile {
  path: string;
  status: string;
}

export interface GitDiffTotals {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitRepoSync {
  isGitRepository: boolean;
  repoRoot?: string;
  currentBranch?: string;
  trackingBranch?: string;
  isDirty: boolean;
  hasHeadCommit: boolean;
  hasPushRemote: boolean;
  aheadCount: number;
  behindCount: number;
  state: string;
  canPush: boolean;
  isPublishedToRemote: boolean;
  files: GitChangedFile[];
  diffTotals?: GitDiffTotals;
}

export interface GitState {
  byThread: Record<string, GitRepoSync>;
  diffByThread: Record<string, string>;
  loadingByThread: Record<string, boolean>;
  errorByThread: Record<string, string>;

  refreshStatus(threadId: string, rpc: JsonRpcClient): Promise<void>;
  refreshDiff(threadId: string, rpc: JsonRpcClient): Promise<void>;
  commit(threadId: string, rpc: JsonRpcClient, message: string): Promise<void>;
  push(threadId: string, rpc: JsonRpcClient): Promise<void>;
  pull(threadId: string, rpc: JsonRpcClient): Promise<void>;
  reset(): void;
}

export const useGitStore = create<GitState>((set, get) => ({
  byThread: {},
  diffByThread: {},
  loadingByThread: {},
  errorByThread: {},

  async refreshStatus(threadId, rpc) {
    setLoading(set, threadId, true);
    try {
      const json = await rpc.request<Record<string, unknown>>("git/status", { threadId });
      const status = decodeRepoSync(json);
      set({ byThread: { ...get().byThread, [threadId]: status } });
      clearError(set, get, threadId);
    } catch (error) {
      setError(set, get, threadId, (error as Error).message);
    } finally {
      setLoading(set, threadId, false);
    }
  },

  async refreshDiff(threadId, rpc) {
    setLoading(set, threadId, true);
    try {
      const json = await rpc.request<Record<string, unknown>>("git/diff", { threadId });
      const patch = typeof json.patch === "string" ? json.patch : "";
      set({ diffByThread: { ...get().diffByThread, [threadId]: patch } });
      clearError(set, get, threadId);
    } catch (error) {
      setError(set, get, threadId, (error as Error).message);
    } finally {
      setLoading(set, threadId, false);
    }
  },

  async commit(threadId, rpc, message) {
    setLoading(set, threadId, true);
    try {
      await rpc.request("git/commit", { threadId, message });
      await get().refreshStatus(threadId, rpc);
      await get().refreshDiff(threadId, rpc);
    } catch (error) {
      setError(set, get, threadId, (error as Error).message);
    } finally {
      setLoading(set, threadId, false);
    }
  },

  async push(threadId, rpc) {
    setLoading(set, threadId, true);
    try {
      await rpc.request("git/push", { threadId });
      await get().refreshStatus(threadId, rpc);
    } catch (error) {
      setError(set, get, threadId, (error as Error).message);
    } finally {
      setLoading(set, threadId, false);
    }
  },

  async pull(threadId, rpc) {
    setLoading(set, threadId, true);
    try {
      await rpc.request("git/pull", { threadId });
      await get().refreshStatus(threadId, rpc);
    } catch (error) {
      setError(set, get, threadId, (error as Error).message);
    } finally {
      setLoading(set, threadId, false);
    }
  },

  reset() {
    set({ byThread: {}, diffByThread: {}, loadingByThread: {}, errorByThread: {} });
  },
}));

export function decodeRepoSync(json: Record<string, unknown> | undefined): GitRepoSync {
  const obj = json ?? {};
  return {
    isGitRepository: obj.isRepo === undefined ? true : Boolean(obj.isRepo),
    repoRoot: typeof obj.repoRoot === "string" ? obj.repoRoot.trim() || undefined : undefined,
    currentBranch: typeof obj.branch === "string" ? obj.branch : undefined,
    trackingBranch: typeof obj.tracking === "string" ? obj.tracking : undefined,
    isDirty: Boolean(obj.dirty),
    hasHeadCommit: obj.hasHeadCommit === undefined ? true : Boolean(obj.hasHeadCommit),
    hasPushRemote: obj.hasPushRemote === undefined ? true : Boolean(obj.hasPushRemote),
    aheadCount: numberField(obj.ahead),
    behindCount: numberField(obj.behind),
    state: typeof obj.state === "string" ? obj.state : "up_to_date",
    canPush: Boolean(obj.canPush),
    isPublishedToRemote: Boolean(obj.publishedToRemote),
    files: Array.isArray(obj.files)
      ? obj.files
          .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
          .map((f) => ({
            path: typeof f.path === "string" ? f.path : "",
            status: typeof f.status === "string" ? f.status.trim() : "",
          }))
          .filter((f) => f.path)
      : [],
    diffTotals: decodeDiffTotals(obj.diff),
  };
}

function decodeDiffTotals(value: unknown): GitDiffTotals | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const filesChanged = numberField(obj.filesChanged ?? obj.files_changed);
  const insertions = numberField(obj.insertions);
  const deletions = numberField(obj.deletions);
  if (filesChanged === 0 && insertions === 0 && deletions === 0) return undefined;
  return { filesChanged, insertions, deletions };
}

function numberField(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function setLoading(
  set: (partial: Partial<GitState>) => void,
  threadId: string,
  loading: boolean
): void {
  set({ loadingByThread: { ...useGitStore.getState().loadingByThread, [threadId]: loading } });
}

function clearError(
  set: (partial: Partial<GitState>) => void,
  get: () => GitState,
  threadId: string
): void {
  if (!get().errorByThread[threadId]) return;
  const next = { ...get().errorByThread };
  delete next[threadId];
  set({ errorByThread: next });
}

function setError(
  set: (partial: Partial<GitState>) => void,
  get: () => GitState,
  threadId: string,
  message: string
): void {
  set({ errorByThread: { ...get().errorByThread, [threadId]: message } });
}
