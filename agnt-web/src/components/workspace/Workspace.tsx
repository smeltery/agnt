// Two-column layout: thread sidebar on the left, chat view on the right.
// Mirrors AgntMobile's split-view at the highest level — feature parity rolls out
// inside each column over follow-up sessions.

import { useEffect } from "react";
import { useConnectionStore } from "../../state/connection-store";
import { useThreadsStore } from "../../state/threads-store";
import { ChatView } from "../chat/ChatView";
import { Sidebar } from "../sidebar/Sidebar";
import { StatusPill } from "../shared/StatusPill";

export function Workspace() {
  const status = useConnectionStore((state) => state.status);
  const reconnect = useConnectionStore((state) => state.reconnect);
  const forget = useConnectionStore((state) => state.forget);
  const refreshThreads = useThreadsStore((state) => state.refreshThreads);

  useEffect(() => {
    if (status.kind === "open") void refreshThreads();
  }, [status.kind, refreshThreads]);

  return (
    <div className="agnt-workspace">
      <header className="agnt-workspace-header">
        <span className="agnt-brand">agnt</span>
        <StatusPill status={status} />
        <div className="agnt-workspace-actions">
          {status.kind !== "open" && status.kind !== "connecting" && status.kind !== "handshaking" && (
            <button className="agnt-button-ghost" onClick={() => void reconnect()}>
              Reconnect
            </button>
          )}
          <button className="agnt-button-ghost agnt-button-danger" onClick={() => void forget()}>
            Forget pairing
          </button>
        </div>
      </header>
      <div className="agnt-workspace-body">
        <Sidebar />
        <ChatView />
      </div>
    </div>
  );
}
