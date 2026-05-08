// Two-column layout: thread sidebar on the left, chat view on the right.
// Mirrors AgntMobile's split-view at the highest level — feature parity rolls out
// inside each column over follow-up sessions.

import { useEffect, useState } from "react";
import { useShortcut } from "../../lib/keyboard";
import { useConnectionStore } from "../../state/connection-store";
import { useThreadsStore } from "../../state/threads-store";
import { ApprovalModal } from "../approvals/ApprovalModal";
import { ChatView } from "../chat/ChatView";
import { AboutModal } from "../settings/AboutModal";
import { SettingsModal } from "../settings/SettingsModal";
import { Sidebar } from "../sidebar/Sidebar";
import { NoticeStack } from "../shared/NoticeStack";
import { StatusPill } from "../shared/StatusPill";
import { StructuredInputModal } from "../structured-input/StructuredInputModal";

export function Workspace() {
  const status = useConnectionStore((state) => state.status);
  const reconnect = useConnectionStore((state) => state.reconnect);
  const hydrateFromDisk = useThreadsStore((state) => state.hydrateFromDisk);
  const [overlay, setOverlay] = useState<"settings" | "about" | null>(null);

  useEffect(() => {
    void hydrateFromDisk();
  }, [hydrateFromDisk]);

  // `/` jumps focus to the composer (Linear/GitHub-style). Only fires when
  // the user isn't already typing somewhere — useShortcut handles that.
  useShortcut("/", (event) => {
    event.preventDefault();
    document.getElementById("agnt-composer-input")?.focus();
  });

  // Esc closes any open overlay so users always have a way out.
  useShortcut(
    "Escape",
    () => {
      if (overlay) setOverlay(null);
    },
    { skipWhenTyping: false }
  );

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
          <button className="agnt-button-ghost" onClick={() => setOverlay("settings")}>
            Settings
          </button>
          <button className="agnt-button-ghost" onClick={() => setOverlay("about")}>
            About
          </button>
        </div>
      </header>
      <div className="agnt-workspace-body">
        <Sidebar />
        <ChatView />
      </div>
      <NoticeStack />
      <ApprovalModal />
      <StructuredInputModal />
      {overlay === "settings" && <SettingsModal onClose={() => setOverlay(null)} />}
      {overlay === "about" && <AboutModal onClose={() => setOverlay(null)} />}
    </div>
  );
}
