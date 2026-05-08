// Two-column layout: thread sidebar on the left, chat view on the right.
// Mirrors AgntMobile's split-view at the highest level — feature parity rolls
// out inside each column over follow-up sessions.

import { useEffect, useState } from "react";
import { useShortcut } from "../../lib/keyboard";
import { useConnectionStore } from "../../state/connection-store";
import { useProjectStore } from "../../state/project-store";
import { useThreadsStore } from "../../state/threads-store";
import { ApprovalModal } from "../approvals/ApprovalModal";
import { ChatView } from "../chat/ChatView";
import { NewChatModal } from "../chat/NewChatModal";
import { RevertSheet } from "../checkpoints/RevertSheet";
import { ProjectPicker } from "../project/ProjectPicker";
import { AboutModal } from "../settings/AboutModal";
import { SettingsModal } from "../settings/SettingsModal";
import { Sidebar } from "../sidebar/Sidebar";
import { HelpModal } from "../shared/HelpModal";
import { NoticeStack } from "../shared/NoticeStack";
import { ReconnectBanner } from "../shared/ReconnectBanner";
import { StatusPill } from "../shared/StatusPill";
import { StructuredInputModal } from "../structured-input/StructuredInputModal";

export function Workspace() {
  const status = useConnectionStore((state) => state.status);
  const reconnect = useConnectionStore((state) => state.reconnect);
  const connection = useConnectionStore((state) => state.connection);
  const hydrateFromDisk = useThreadsStore((state) => state.hydrateFromDisk);
  const showProjectPicker = useProjectStore((state) => state.show);
  const projectPickerOpen = useProjectStore((state) => state.open);
  const [overlay, setOverlay] = useState<"settings" | "about" | "newChat" | "help" | null>(null);
  // The picker can be invoked either from a "Change project" affordance or
  // from the "New Chat" flow. We track who asked so we can route the result.
  const [pickerCallback, setPickerCallback] = useState<((path: string) => void) | null>(null);

  useEffect(() => {
    void hydrateFromDisk();
  }, [hydrateFromDisk]);

  useShortcut("/", (event) => {
    event.preventDefault();
    document.getElementById("agnt-composer-input")?.focus();
  });

  useShortcut("?", () => {
    // skipWhenTyping is on by default, so the user can still type "?" in the
    // composer without summoning the help. If they're outside an input the
    // overlay opens (or closes if it's already up).
    setOverlay((current) => (current === "help" ? null : "help"));
  });

  useShortcut("Escape", () => {
    if (overlay) setOverlay(null);
  }, { skipWhenTyping: false });

  function openNewChat() {
    setOverlay("newChat");
  }

  function pickProject(callback: (path: string) => void) {
    if (!connection?.rpc) return;
    setPickerCallback(() => callback);
    void showProjectPicker(connection.rpc);
  }

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
          <button
            className="agnt-button-ghost"
            onClick={() => setOverlay("help")}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
          >
            ?
          </button>
          <button className="agnt-button-ghost" onClick={() => setOverlay("settings")}>
            Settings
          </button>
          <button className="agnt-button-ghost" onClick={() => setOverlay("about")}>
            About
          </button>
        </div>
      </header>
      <ReconnectBanner />
      <div className="agnt-workspace-body">
        <Sidebar onNewChat={openNewChat} />
        <ChatView />
      </div>
      <NoticeStack />
      <ApprovalModal />
      <StructuredInputModal />
      <RevertSheet />
      {overlay === "settings" && <SettingsModal onClose={() => setOverlay(null)} />}
      {overlay === "about" && <AboutModal onClose={() => setOverlay(null)} />}
      {overlay === "help" && <HelpModal onClose={() => setOverlay(null)} />}
      {overlay === "newChat" && (
        <NewChatModal
          onClose={() => setOverlay(null)}
          onPickProject={pickProject}
        />
      )}
      {projectPickerOpen && pickerCallback && (
        <ProjectPicker
          onPick={(path) => {
            pickerCallback(path);
            setPickerCallback(null);
          }}
          onCancel={() => setPickerCallback(null)}
        />
      )}
    </div>
  );
}
