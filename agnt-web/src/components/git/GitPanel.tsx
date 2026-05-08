// Per-thread git panel. Shows branch + state + dirty file list, with a
// commit-message field and Commit/Push/Pull buttons. Each file row in the
// status list expands inline to its per-file diff slice (lazy: the unified
// diff is fetched once on first expand and reused across files).

import { useEffect, useMemo, useState } from "react";
import { computeDiffStats, formatDiffStats, sumDiffStats } from "../../lib/git-diff-stats";
import { splitUnifiedDiff } from "../../lib/git-diff-parser";
import type { JsonRpcClient } from "../../protocol/jsonrpc-client";
import { useGitStore } from "../../state/git-store";
import { DiffView } from "./DiffView";

interface GitPanelProps {
  threadId: string;
  rpc: JsonRpcClient | null;
}

export function GitPanel({ threadId, rpc }: GitPanelProps) {
  const status = useGitStore((state) => state.byThread[threadId]);
  const diff = useGitStore((state) => state.diffByThread[threadId]);
  const branches = useGitStore((state) => state.branchesByThread[threadId]);
  const loading = useGitStore((state) => Boolean(state.loadingByThread[threadId]));
  const error = useGitStore((state) => state.errorByThread[threadId]);
  const refreshStatus = useGitStore((state) => state.refreshStatus);
  const refreshDiff = useGitStore((state) => state.refreshDiff);
  const refreshBranches = useGitStore((state) => state.refreshBranches);
  const checkoutBranch = useGitStore((state) => state.checkoutBranch);
  const createBranch = useGitStore((state) => state.createBranch);
  const createWorktree = useGitStore((state) => state.createWorktree);
  const commit = useGitStore((state) => state.commit);
  const push = useGitStore((state) => state.push);
  const pull = useGitStore((state) => state.pull);
  const stash = useGitStore((state) => state.stash);
  const stashPop = useGitStore((state) => state.stashPop);

  const [commitMessage, setCommitMessage] = useState("");
  const [showBranches, setShowBranches] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createMode, setCreateMode] = useState<"branch" | "worktree">("branch");
  const [creationFeedback, setCreationFeedback] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set());

  // Slice the unified patch into per-file fragments once per fetch — every
  // expand-toggle would otherwise re-walk the full string.
  const diffByFile = useMemo(() => {
    const map = new Map<string, string>();
    if (!diff) return map;
    for (const entry of splitUnifiedDiff(diff)) map.set(entry.path, entry.patch);
    return map;
  }, [diff]);
  const statsByFile = useMemo(() => {
    const map = new Map<string, { insertions: number; deletions: number }>();
    for (const [path, patch] of diffByFile) map.set(path, computeDiffStats(patch));
    return map;
  }, [diffByFile]);
  // Prefer the bridge's `diffTotals` (returned by `git/status`) — it doesn't
  // require fetching the unified patch, so totals paint immediately. Fall back
  // to summing per-file stats when the bridge omits them and the user has
  // already expanded a file (which forces a diff fetch).
  const totalStats = useMemo(() => {
    if (status?.diffTotals) {
      return { insertions: status.diffTotals.insertions, deletions: status.diffTotals.deletions };
    }
    return sumDiffStats(statsByFile.values());
  }, [status?.diffTotals, statsByFile]);

  useEffect(() => {
    if (!rpc) return;
    void refreshStatus(threadId, rpc);
  }, [threadId, rpc, refreshStatus]);

  if (!rpc) return null;

  if (!status) {
    return (
      <div className="agnt-gitpanel agnt-gitpanel-empty">
        <span>Git status unavailable.</span>
        <button type="button" onClick={() => void refreshStatus(threadId, rpc)} disabled={loading}>
          {loading ? "loading…" : "retry"}
        </button>
      </div>
    );
  }

  if (!status.isGitRepository) {
    return <div className="agnt-gitpanel agnt-gitpanel-empty">Not a git repository.</div>;
  }

  return (
    <section className="agnt-gitpanel" aria-label="Git">
      <header className="agnt-gitpanel-header">
        <div className="agnt-gitpanel-branch">
          <span className="agnt-row-tag">branch</span>
          <strong>{status.currentBranch ?? "(detached)"}</strong>
          {status.trackingBranch && <span className="agnt-gitpanel-tracking">↳ {status.trackingBranch}</span>}
        </div>
        <div className="agnt-gitpanel-counts">
          {status.aheadCount > 0 && <span title="commits ahead of remote">↑{status.aheadCount}</span>}
          {status.behindCount > 0 && <span title="commits behind remote">↓{status.behindCount}</span>}
          {status.isDirty && <span className="agnt-gitpanel-dirty">dirty</span>}
          {(totalStats.insertions > 0 || totalStats.deletions > 0) && (
            <span className="agnt-gitpanel-totals" title="Total insertions / deletions across the dirty working tree">
              <span className="agnt-gitpanel-stat-add">+{totalStats.insertions}</span>
              <span className="agnt-gitpanel-stat-del">−{totalStats.deletions}</span>
            </span>
          )}
        </div>
      </header>

      {error && <div className="agnt-gitpanel-error">{error}</div>}

      {status.files.length > 0 && (
        <ul className="agnt-gitpanel-files">
          {status.files.map((file) => {
            const expanded = expandedFiles.has(file.path);
            const filePatch = diffByFile.get(file.path);
            return (
              <li key={file.path} className={"agnt-gitpanel-file" + (expanded ? " agnt-gitpanel-file-expanded" : "")}>
                <button
                  type="button"
                  className="agnt-gitpanel-file-row"
                  aria-expanded={expanded}
                  onClick={() => {
                    // Lazy-fetch on first expand so a clean repo doesn't pay
                    // the round-trip; later expands reuse the cached patch.
                    if (!diff) void refreshDiff(threadId, rpc);
                    setExpandedFiles((current) => {
                      const next = new Set(current);
                      if (next.has(file.path)) next.delete(file.path);
                      else next.add(file.path);
                      return next;
                    });
                  }}
                >
                  <span className={"agnt-gitpanel-file-status agnt-gitpanel-file-status-" + (file.status[0] ?? "?").toLowerCase()}>
                    {file.status || "?"}
                  </span>
                  <code>{file.path}</code>
                  {statsByFile.has(file.path) && (
                    <span
                      className="agnt-gitpanel-file-stats"
                      title={formatDiffStats(statsByFile.get(file.path)!)}
                    >
                      <span className="agnt-gitpanel-stat-add">+{statsByFile.get(file.path)!.insertions}</span>
                      <span className="agnt-gitpanel-stat-del">−{statsByFile.get(file.path)!.deletions}</span>
                    </span>
                  )}
                  <span className="agnt-gitpanel-file-chevron" aria-hidden>{expanded ? "▾" : "▸"}</span>
                </button>
                {expanded && (
                  filePatch
                    ? <DiffView patch={filePatch} />
                    : <div className="agnt-gitpanel-empty">{diff ? "No textual diff (binary or untracked)." : "Loading diff…"}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="agnt-gitpanel-actions">
        <input
          type="text"
          className="agnt-gitpanel-message"
          placeholder="Commit message"
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          disabled={loading}
        />
        <button
          type="button"
          className="agnt-button-primary"
          onClick={() => {
            void commit(threadId, rpc, commitMessage);
            setCommitMessage("");
          }}
          disabled={loading || !status.isDirty || !commitMessage.trim()}
        >
          Commit
        </button>
        <button
          type="button"
          className="agnt-button-ghost"
          onClick={() => void push(threadId, rpc)}
          disabled={loading || !status.canPush}
        >
          Push
        </button>
        <button
          type="button"
          className="agnt-button-ghost"
          onClick={() => void pull(threadId, rpc)}
          disabled={loading || status.behindCount === 0}
        >
          Pull
        </button>
        <button
          type="button"
          className="agnt-button-ghost"
          onClick={() => void stash(threadId, rpc)}
          disabled={loading || !status.isDirty}
          title="git stash push --include-untracked: save the working tree for later"
        >
          Stash
        </button>
        <button
          type="button"
          className="agnt-button-ghost"
          onClick={() => void stashPop(threadId, rpc)}
          disabled={loading || status.isDirty}
          title="git stash pop: restore the most recent stash. Disabled when the working tree is dirty so a stash pop can't conflict with uncommitted changes."
        >
          Stash pop
        </button>
        <button
          type="button"
          className="agnt-button-ghost"
          onClick={() => {
            const next = !showBranches;
            setShowBranches(next);
            if (next) void refreshBranches(threadId, rpc);
          }}
          disabled={loading}
        >
          {showBranches ? "Hide branches" : "Branches"}
        </button>
      </div>

      {showBranches && (
        <div className="agnt-gitpanel-create">
          <select
            value={createMode}
            onChange={(event) => setCreateMode(event.target.value as "branch" | "worktree")}
            disabled={loading}
            aria-label="Create mode"
          >
            <option value="branch">Branch</option>
            <option value="worktree">Worktree</option>
          </select>
          <input
            type="text"
            className="agnt-gitpanel-create-input"
            placeholder={createMode === "branch" ? "new-branch-name" : "feature/short-lived-cwd"}
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            disabled={loading}
          />
          <button
            type="button"
            className="agnt-button-ghost"
            disabled={loading || !createName.trim()}
            onClick={async () => {
              setCreationFeedback(null);
              if (createMode === "branch") {
                const created = await createBranch(threadId, rpc, createName);
                if (created) {
                  setCreationFeedback(`Created branch ${created}`);
                  setCreateName("");
                }
              } else {
                const path = await createWorktree(threadId, rpc, {
                  branch: createName,
                  baseBranch: branches?.currentBranch,
                });
                if (path) {
                  setCreationFeedback(`Worktree at ${path}`);
                  setCreateName("");
                }
              }
            }}
          >
            Create
          </button>
        </div>
      )}
      {creationFeedback && <div className="agnt-gitpanel-feedback">{creationFeedback}</div>}

      {showBranches && (
        <ul className="agnt-gitpanel-branches">
          {!branches ? (
            <li className="agnt-gitpanel-empty">Loading…</li>
          ) : branches.branches.length === 0 ? (
            <li className="agnt-gitpanel-empty">No branches.</li>
          ) : (
            branches.branches.map((branch) => {
              const isCurrent = branch === branches.currentBranch;
              const checkedOutElsewhere = branches.branchesCheckedOutElsewhere.has(branch);
              return (
                <li key={branch} className={"agnt-gitpanel-branch-row" + (isCurrent ? " agnt-gitpanel-branch-current" : "")}>
                  <span className="agnt-gitpanel-branch-name">
                    <code>{branch}</code>
                    {branch === branches.defaultBranch && <span className="agnt-row-tag">default</span>}
                    {checkedOutElsewhere && <span className="agnt-row-tag">other worktree</span>}
                  </span>
                  <button
                    type="button"
                    className="agnt-button-ghost"
                    disabled={loading || isCurrent || checkedOutElsewhere || status.isDirty}
                    title={
                      isCurrent
                        ? "Already on this branch"
                        : checkedOutElsewhere
                          ? "Checked out in another worktree"
                          : status.isDirty
                            ? "Working tree is dirty — commit or stash first"
                            : "Checkout this branch"
                    }
                    onClick={() => void checkoutBranch(threadId, rpc, branch)}
                  >
                    {isCurrent ? "Current" : "Checkout"}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </section>
  );
}
