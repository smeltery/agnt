// File-change row with per-file revert (AI Change Sets). The reducer
// already stores a unified diff per fileChange message; we send that as
// `forwardPatch` to the bridge's existing `workspace/revertPatchApply`,
// which reverse-applies it via `git apply -R`. Same safety checks as the
// per-turn checkpoint flow (no staged files, no merge conflicts).

import { useState } from "react";
import type { CodexMessage } from "../../../models";
import { useConnectionStore } from "../../../state/connection-store";
import { useThreadsStore } from "../../../state/threads-store";
import { revertPatchApply, revertPatchPreview } from "../../../protocol/workspace-checkpoints";
import { ArrowUturnLeft } from "../../shared/Icon";

type RevertState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "applying" }
  | { phase: "blocked"; reason: string }
  | { phase: "done"; files: string[] };

export function FileChangeRow({ message }: { message: CodexMessage }) {
  const [expanded, setExpanded] = useState(false);
  const [revert, setRevert] = useState<RevertState>({ phase: "idle" });
  const fileChange = message.fileChange;
  const connection = useConnectionStore((state) => state.connection);
  const thread = useThreadsStore((state) => {
    if (!message.threadId) return undefined;
    return (
      state.threads.find((t) => t.id === message.threadId) ??
      state.archivedThreads.find((t) => t.id === message.threadId)
    );
  });

  if (!fileChange) return null;

  const canRevert =
    !!connection?.rpc &&
    !!thread?.cwd &&
    typeof fileChange.diff === "string" &&
    fileChange.diff.trim().length > 0 &&
    revert.phase !== "done";

  async function handleRevert() {
    if (!connection?.rpc || !thread?.cwd || !fileChange?.diff) return;
    setRevert({ phase: "checking" });
    try {
      const preview = await revertPatchPreview(connection.rpc, {
        cwd: thread.cwd,
        forwardPatch: fileChange.diff,
      });
      if (!preview.canRevert) {
        // Surface the most-actionable reason: staged files come first, then
        // conflicts (a follow-up edit re-touched the same hunk), then the
        // bridge's "unsupported" catalog. Keep it terse — this is a chip.
        const reason =
          preview.stagedFiles.length > 0
            ? `Unstage ${preview.stagedFiles.length} file${preview.stagedFiles.length === 1 ? "" : "s"} first.`
            : preview.conflicts.length > 0
              ? "Conflicts with later edits."
              : preview.unsupportedReasons[0] ?? "Bridge can't reverse this patch.";
        setRevert({ phase: "blocked", reason });
        return;
      }
      setRevert({ phase: "applying" });
      const result = await revertPatchApply(connection.rpc, {
        cwd: thread.cwd,
        forwardPatch: fileChange.diff,
      });
      if (result.success) {
        setRevert({ phase: "done", files: result.revertedFiles });
      } else {
        const reason =
          result.stagedFiles.length > 0
            ? `Unstage ${result.stagedFiles.length} file${result.stagedFiles.length === 1 ? "" : "s"} first.`
            : result.conflicts.length > 0
              ? "Conflicts with later edits."
              : "Apply failed.";
        setRevert({ phase: "blocked", reason });
      }
    } catch (error) {
      setRevert({ phase: "blocked", reason: (error as Error).message });
    }
  }

  return (
    <div
      className="agnt-row agnt-row-filechange"
      title={new Date(message.createdAt).toLocaleString()}
      data-message-id={message.id}
    >
      <button
        type="button"
        className="agnt-row-filechange-summary"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
      >
        <span className="agnt-row-tag">File change</span>
        <code>{fileChange.path ?? "(unknown path)"}</code>
      </button>
      {expanded && fileChange.diff && (
        <>
          <pre className="agnt-row-filechange-diff">{fileChange.diff}</pre>
          <div className="agnt-row-filechange-actions">
            {canRevert && (
              <button
                type="button"
                className="agnt-row-action"
                onClick={handleRevert}
                disabled={revert.phase === "checking" || revert.phase === "applying"}
                title="Reverse this patch via `git apply -R`"
              >
                <ArrowUturnLeft />{" "}
                {revert.phase === "checking"
                  ? "Checking…"
                  : revert.phase === "applying"
                    ? "Reverting…"
                    : "Revert this change"}
              </button>
            )}
            {revert.phase === "blocked" && (
              <span className="agnt-row-action-meta agnt-row-action-warning" title={revert.reason}>
                Can't revert — {revert.reason}
              </span>
            )}
            {revert.phase === "done" && (
              <span className="agnt-row-action-meta agnt-row-action-done" title="Reverse-applied via git apply -R">
                Reverted {revert.files.length === 0 ? "" : `${revert.files.length} file${revert.files.length === 1 ? "" : "s"}`}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
