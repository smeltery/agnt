// Sticky header that surfaces the active thread's title + cwd, plus a toggle
// for the git panel. Visible only when a thread is selected.

import { useEffect, useState } from "react";
import type { JsonRpcClient } from "../../protocol/jsonrpc-client";
import { formatStreamingStats, useStreamingStatsStore } from "../../state/streaming-stats-store";
import { selectActiveTurnRunning, useThreadsStore } from "../../state/threads-store";
import { FileBrowser } from "../files/FileBrowser";
import { GitPanel } from "../git/GitPanel";

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
  const [showGit, setShowGit] = useState(false);
  const [showFiles, setShowFiles] = useState(false);

  if (!selectedThreadId || !thread) return null;
  const title = thread.name ?? thread.title ?? "Untitled";

  return (
    <header className={"agnt-chat-header" + (color ? ` agnt-chat-header-color agnt-thread-color-${color}` : "")}>
      <div className="agnt-chat-header-titles">
        {color && (
          <span className="agnt-chat-header-color-dot" aria-label={`${color} tag`} title={`${color} tag`} />
        )}
        <h1 className="agnt-chat-header-title">{title}</h1>
        {thread.cwd && <code className="agnt-chat-header-cwd">{thread.cwd}</code>}
        {thread.modelProvider && (
          <span className="agnt-row-tag agnt-chat-header-provider">{thread.modelProvider}</span>
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
      {showFiles && thread.cwd && (
        <FileBrowser threadId={selectedThreadId} cwd={thread.cwd} rpc={rpc} />
      )}
      {showGit && <GitPanel threadId={selectedThreadId} rpc={rpc} />}
    </header>
  );
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
