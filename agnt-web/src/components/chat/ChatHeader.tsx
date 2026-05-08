// Sticky header that surfaces the active thread's title + cwd, plus a toggle
// for the git panel. Visible only when a thread is selected.

import { useState } from "react";
import type { JsonRpcClient } from "../../protocol/jsonrpc-client";
import { selectActiveTurnRunning, useThreadsStore } from "../../state/threads-store";
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
  const [showGit, setShowGit] = useState(false);

  if (!selectedThreadId || !thread) return null;
  const title = thread.name ?? thread.title ?? "Untitled";

  return (
    <header className="agnt-chat-header">
      <div className="agnt-chat-header-titles">
        <h1 className="agnt-chat-header-title">{title}</h1>
        {thread.cwd && <code className="agnt-chat-header-cwd">{thread.cwd}</code>}
        {thread.modelProvider && (
          <span className="agnt-row-tag agnt-chat-header-provider">{thread.modelProvider}</span>
        )}
        <div className="agnt-chat-header-actions">
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
            onClick={() => setShowGit((open) => !open)}
            aria-expanded={showGit}
          >
            {showGit ? "Hide git" : "Git"}
          </button>
        </div>
      </div>
      {showGit && <GitPanel threadId={selectedThreadId} rpc={rpc} />}
    </header>
  );
}
