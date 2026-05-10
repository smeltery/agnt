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

export interface GitBranchesSnapshot {
  branches: string[];
  currentBranch?: string;
  defaultBranch?: string;
  branchesCheckedOutElsewhere: Set<string>;
}

export interface GitState {
  byThread: Record<string, GitRepoSync>;
  diffByThread: Record<string, string>;
  branchesByThread: Record<string, GitBranchesSnapshot>;
  loadingByThread: Record<string, boolean>;
  errorByThread: Record<string, string>;

  refreshStatus(threadId: string, rpc: JsonRpcClient): Promise<void>;
  refreshDiff(threadId: string, rpc: JsonRpcClient): Promise<void>;
  refreshBranches(threadId: string, rpc: JsonRpcClient): Promise<void>;
  checkoutBranch(threadId: string, rpc: JsonRpcClient, branch: string): Promise<void>;
  createBranch(threadId: string, rpc: JsonRpcClient, name: string): Promise<string | null>;
  createWorktree(
    threadId: string,
    rpc: JsonRpcClient,
    params: { branch: string; baseBranch?: string }
  ): Promise<string | null>;
  commit(threadId: string, rpc: JsonRpcClient, message: string): Promise<void>;
  /** AI-drafted commit message (Codex-only on the bridge). Returns the
   *  fullMessage string ready to drop into the commit textarea, or null
   *  when the bridge errors (other providers, no diff to summarize, etc.).
   *  Surface the error via `setError` for diagnostics either way. */
  generateCommitMessage(threadId: string, rpc: JsonRpcClient): Promise<string | null>;
  push(threadId: string, rpc: JsonRpcClient): Promise<void>;
  pull(threadId: string, rpc: JsonRpcClient): Promise<void>;
  /** `git stash push --include-untracked`. Saves the entire working tree
   *  for later, leaving the branch clean. Bridge: `git/stash`. */
  stash(threadId: string, rpc: JsonRpcClient): Promise<void>;
  /** `git stash pop`. Restores the most recent stash; the bridge surfaces
   *  conflicts as a `stash_pop_conflict` error. Bridge: `git/stashPop`. */
  stashPop(threadId: string, rpc: JsonRpcClient): Promise<void>;
  reset(): void;
}

export const useGitStore = create<GitState>((set, get) => ({
  byThread: {},
  diffByThread: {},
  branchesByThread: {},
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

  async refreshBranches(threadId, rpc) {
    setLoading(set, threadId, true);
    try {
      const json = await rpc.request<Record<string, unknown>>("git/branches", { threadId });
      const snapshot = decodeBranches(json);
      set({ branchesByThread: { ...get().branchesByThread, [threadId]: snapshot } });
      clearError(set, get, threadId);
    } catch (error) {
      setError(set, get, threadId, (error as Error).message);
    } finally {
      setLoading(set, threadId, false);
    }
  },

  async checkoutBranch(threadId, rpc, branch) {
    setLoading(set, threadId, true);
    try {
      await rpc.request("git/checkout", { threadId, branch });
      // Refresh both views concurrently — status reflects working-tree
      // changes, branches reflects the new HEAD pointer.
      await Promise.all([get().refreshStatus(threadId, rpc), get().refreshBranches(threadId, rpc)]);
    } catch (error) {
      setError(set, get, threadId, (error as Error).message);
    } finally {
      setLoading(set, threadId, false);
    }
  },

  async createBranch(threadId, rpc, name) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    setLoading(set, threadId, true);
    try {
      const result = await rpc.request<{ branch?: string }>("git/createBranch", { threadId, name: trimmed });
      const created = typeof result.branch === "string" && result.branch ? result.branch : trimmed;
      await get().refreshBranches(threadId, rpc);
      return created;
    } catch (error) {
      setError(set, get, threadId, (error as Error).message);
      return null;
    } finally {
      setLoading(set, threadId, false);
    }
  },

  async createWorktree(threadId, rpc, params) {
    const branch = params.branch.trim();
    if (!branch) return null;
    setLoading(set, threadId, true);
    try {
      const result = await rpc.request<{ worktreePath?: string }>("git/createWorktree", {
        threadId,
        branch,
        baseBranch: params.baseBranch,
      });
      const path = typeof result.worktreePath === "string" ? result.worktreePath : null;
      await get().refreshBranches(threadId, rpc);
      return path;
    } catch (error) {
      setError(set, get, threadId, (error as Error).message);
      return null;
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

  async generateCommitMessage(threadId, rpc) {
    setLoading(set, threadId, true);
    try {
      // Bridge response: { subject, body, fullMessage }. We surface
      // fullMessage because the textarea is one input — callers that want
      // subject-only can split on the first blank line.
      const result = await rpc.request<{ fullMessage?: string; subject?: string }>(
        "git/generateCommitMessage",
        { threadId }
      );
      const drafted = typeof result?.fullMessage === "string" && result.fullMessage.trim()
        ? result.fullMessage.trim()
        : typeof result?.subject === "string" && result.subject.trim()
          ? result.subject.trim()
          : null;
      return drafted;
    } catch (error) {
      // Most likely path: non-Codex provider returns
      // "managed externally" or the staged diff is empty. Surface either
      // way so the user gets a hint instead of a silent failure.
      setError(set, get, threadId, (error as Error).message);
      return null;
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

  async stash(threadId, rpc) {
    setLoading(set, threadId, true);
    try {
      await rpc.request("git/stash", { threadId });
      await get().refreshStatus(threadId, rpc);
      await get().refreshDiff(threadId, rpc);
    } catch (error) {
      setError(set, get, threadId, (error as Error).message);
    } finally {
      setLoading(set, threadId, false);
    }
  },

  async stashPop(threadId, rpc) {
    setLoading(set, threadId, true);
    try {
      await rpc.request("git/stashPop", { threadId });
      await get().refreshStatus(threadId, rpc);
      await get().refreshDiff(threadId, rpc);
    } catch (error) {
      setError(set, get, threadId, (error as Error).message);
    } finally {
      setLoading(set, threadId, false);
    }
  },

  reset() {
    set({ byThread: {}, diffByThread: {}, branchesByThread: {}, loadingByThread: {}, errorByThread: {} });
  },
}));

export function decodeBranches(json: Record<string, unknown> | undefined): GitBranchesSnapshot {
  const obj = json ?? {};
  const branches = Array.isArray(obj.branches)
    ? (obj.branches as unknown[]).filter((b): b is string => typeof b === "string")
    : [];
  const elsewhere = Array.isArray(obj.branchesCheckedOutElsewhere)
    ? new Set(
        (obj.branchesCheckedOutElsewhere as unknown[]).filter((b): b is string => typeof b === "string")
      )
    : new Set<string>();
  return {
    branches,
    currentBranch: typeof obj.current === "string" ? obj.current : undefined,
    defaultBranch: typeof obj.default === "string" ? obj.default : undefined,
    branchesCheckedOutElsewhere: elsewhere,
  };
}

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
