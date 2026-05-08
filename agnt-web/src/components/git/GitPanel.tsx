// Per-thread git panel. Shows branch + state + dirty file list, with a
// commit-message field and Commit/Push/Pull buttons. Diff toggles open a
// monospaced patch view (lazy: only fetched when user opens it).

import { useEffect, useState } from "react";
import type { JsonRpcClient } from "../../protocol/jsonrpc-client";
import { useGitStore } from "../../state/git-store";

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

  const [commitMessage, setCommitMessage] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createMode, setCreateMode] = useState<"branch" | "worktree">("branch");
  const [creationFeedback, setCreationFeedback] = useState<string | null>(null);

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
        </div>
      </header>

      {error && <div className="agnt-gitpanel-error">{error}</div>}

      {status.files.length > 0 && (
        <ul className="agnt-gitpanel-files">
          {status.files.map((file) => (
            <li key={file.path}>
              <span className={"agnt-gitpanel-file-status agnt-gitpanel-file-status-" + (file.status[0] ?? "?").toLowerCase()}>
                {file.status || "?"}
              </span>
              <code>{file.path}</code>
            </li>
          ))}
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
          onClick={() => {
            const next = !showDiff;
            setShowDiff(next);
            if (next) void refreshDiff(threadId, rpc);
          }}
          disabled={loading}
        >
          {showDiff ? "Hide diff" : "View diff"}
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

      {showDiff && diff && <pre className="agnt-gitpanel-diff">{diff}</pre>}
      {showDiff && !diff && <div className="agnt-gitpanel-empty">No diff yet.</div>}

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
