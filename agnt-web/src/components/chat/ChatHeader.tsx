// Sticky header that surfaces the active thread's title + cwd, plus a toggle
// for the git panel. Visible only when a thread is selected.

import { lazy, Suspense, useEffect, useState } from "react";
import type { JsonRpcClient } from "../../protocol/jsonrpc-client";
import { useGitStore } from "../../state/git-store";
import { formatStreamingStats, useStreamingStatsStore } from "../../state/streaming-stats-store";
import { selectActiveTurnRunning, useThreadsStore } from "../../state/threads-store";

// Code-split: most chat sessions never open these panels, so the bundles
// stay out of the first paint until the user clicks Files / Git.
const FileBrowser = lazy(() =>
  import("../files/FileBrowser").then((m) => ({ default: m.FileBrowser }))
);
const GitPanel = lazy(() =>
  import("../git/GitPanel").then((m) => ({ default: m.GitPanel }))
);

interface ChatHeaderProps {
  rpc: JsonRpcClient | null;
}

export function ChatHeader({ rpc }: ChatHeaderProps) {
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  const thread = useThreadsStore((state) =>
    selectedThreadId
      ? state.threads.find((t) => t.id === selectedThreadId) ??
        state.archivedThreads.find((t) => t.id === selectedThreadId)
      : undefined
  );
  const running = useThreadsStore(selectActiveTurnRunning);
  const stopTurn = useThreadsStore((state) => state.stopTurn);
  const color = useThreadsStore((state) =>
    selectedThreadId ? state.colorByThread[selectedThreadId] : undefined
  );
  // Resolve the model that the *next* turn would use. Per-thread override
  // wins over the global flag; either wins over the thread's last-known
  // model from the bridge. Falls back to undefined when none of those are
  // set — we hide the chip rather than show "default" because the user
  // gets that signal from the absence of a value already.
  const overrideModel = useThreadsStore((state) =>
    selectedThreadId ? state.overridesByThread[selectedThreadId]?.model : undefined
  );
  const flagModel = useThreadsStore((state) => state.turnFlags.model);
  const activeModel = overrideModel ?? flagModel ?? thread?.model;
  const modelSource: "override" | "flag" | "thread" | null = overrideModel
    ? "override"
    : flagModel
      ? "flag"
      : thread?.model
        ? "thread"
        : null;

  // thread (it's populated by GitPanel's first refresh + later writes).
  // We don't fetch on mount — that would be a status request per thread
  // selection even when the user never opens the git panel.
  const gitStatus = useGitStore((state) =>
    selectedThreadId ? state.byThread[selectedThreadId] : undefined
  );
  const branchLabel = gitStatus?.currentBranch;
  const isDirty = Boolean(gitStatus?.isDirty);
  const refreshStatus = useGitStore((state) => state.refreshStatus);
  const [showGit, setShowGit] = useState(false);
  const [showFiles, setShowFiles] = useState(false);

  // Lazy first fetch of git status when a thread with cwd is selected,
  // so the branch pill populates without forcing the user to open the
  // git panel. Re-runs on cwd / threadId change but not on later status
  // mutations (those write back into the store directly).
  useEffect(() => {
    if (!rpc || !selectedThreadId || !thread?.cwd) return;
    if (gitStatus !== undefined) return; // already cached; let GitPanel manage refreshes.
    void refreshStatus(selectedThreadId, rpc);
  }, [rpc, selectedThreadId, thread?.cwd, gitStatus, refreshStatus]);

  if (!selectedThreadId || !thread) return null;
  const title = thread.name ?? thread.title ?? "Untitled";

  return (
    <header className={"agnt-chat-header" + (color ? ` agnt-chat-header-color agnt-thread-color-${color}` : "")}>
      <div className="agnt-chat-header-titles">
        {color && (
          <span className="agnt-chat-header-color-dot" aria-label={`${color} tag`} title={`${color} tag`} />
        )}
        <div className="agnt-chat-title-copy">
          {thread.cwd && <span className="agnt-chat-project" title={thread.cwd}>{thread.cwd.split(/[\\/]/).filter(Boolean).at(-1)}</span>}
          <h1 className="agnt-chat-header-title">{title}</h1>
        </div>
        {thread.modelProvider && (
          <span
            className={"agnt-row-tag agnt-chat-header-provider agnt-provider-" + providerSlug(thread.modelProvider)}
            title={`Provider: ${thread.modelProvider}`}
          >
            {thread.modelProvider}
          </span>
        )}
        {activeModel && (
          <span
            className="agnt-row-tag agnt-chat-header-model"
            title={
              modelSource === "override"
                ? `Per-thread override: ${activeModel}`
                : modelSource === "flag"
                  ? `Global pick: ${activeModel}`
                  : `Last seen on this thread: ${activeModel}`
            }
          >
            {activeModel}
          </span>
        )}
        <div className="agnt-chat-header-actions">
          {running && <ThroughputPill threadId={selectedThreadId} />}
          {running && (
            // Header-level Stop mirrors the composer button so users who've
            // scrolled up to read history don't have to hunt for it.
            <button
              type="button"
              className="agnt-button-danger"
              onClick={() => void stopTurn()}
              title="Interrupt the running turn"
            >
              Stop
            </button>
          )}
          <button
            type="button"
            className="agnt-button-ghost"
            onClick={() => setShowFiles((open) => !open)}
            aria-expanded={showFiles}
            disabled={!thread.cwd}
            title={thread.cwd ? "Browse workspace files" : "Set a project (cwd) to browse files"}
          >
            {showFiles ? "Hide files" : "Files"}
          </button>
          {branchLabel && (
            <button
              type="button"
              className={"agnt-row-tag agnt-chat-header-branch" + (isDirty ? " agnt-chat-header-branch-dirty" : "")}
              onClick={() => setShowGit(true)}
              title={
                isDirty
                  ? `On ${branchLabel} · uncommitted changes — click to open Git`
                  : `On ${branchLabel} — click to open Git`
              }
            >
              {/* The leading glyph is a Unicode branch icon, kept inline so
                  we don't pull in a new icon-component dependency. The
                  bullet on dirty branches mirrors what most IDE status
                  bars do. */}
              ⎇ {branchLabel}{isDirty ? " •" : ""}
            </button>
          )}
          <button
            type="button"
            className="agnt-button-ghost"
            onClick={() => setShowGit((open) => !open)}
            aria-expanded={showGit}
          >
            {showGit ? "Hide git" : "Git"}
          </button>
        </div>
      </div>
      {/* Lazy panels share a single Suspense boundary; the chunks fetch on
          first toggle and reuse on later opens. Null fallback while loading
          keeps the header from jumping. */}
      <Suspense fallback={null}>
        {showFiles && thread.cwd && (
          <FileBrowser threadId={selectedThreadId} cwd={thread.cwd} rpc={rpc} />
        )}
        {showGit && <GitPanel threadId={selectedThreadId} rpc={rpc} />}
      </Suspense>
    </header>
  );
}

// Maps a free-form `modelProvider` string (whatever the bridge reports) to a
// short stable slug so `.agnt-provider-<slug>` CSS rules can color the badge.
// Unknown providers fall through to a generic neutral tone.
function providerSlug(provider: string): string {
  const lower = provider.toLowerCase();
  if (lower.includes("codex")) return "codex";
  if (lower.includes("claude")) return "claude";
  if (lower.includes("opencode")) return "opencode";
  if (lower.includes("cursor")) return "cursor";
  return "other";
}

// Re-renders every 500 ms while a turn is running so the elapsed counter ticks.
// Only mounted when `running` is true, so the interval is naturally bounded.
function ThroughputPill({ threadId }: { threadId: string }) {
  const stats = useStreamingStatsStore((state) => state.byThread[threadId]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  if (!stats) return null;
  const { rate, elapsed } = formatStreamingStats(stats, now);
  return (
    <span
      className="agnt-chat-header-throughput"
      title="Streaming activity since this turn started — characters per second is a rough proxy for throughput."
    >
      <span className="agnt-chat-header-throughput-dot" aria-hidden /> {rate} · {elapsed}
    </span>
  );
}
