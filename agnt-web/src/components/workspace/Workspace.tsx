// Two-column layout: thread sidebar on the left, chat view on the right.
// Mirrors AgntMobile's split-view at the highest level — feature parity rolls
// out inside each column over follow-up sessions.

import { useEffect, useRef, useState } from "react";
import { useDocumentTitle } from "../../lib/document-title";
import { buildHashLocation, parseHashLocation } from "../../lib/hash-routing";
import { useShortcut } from "../../lib/keyboard";
import { defaultExportFilename, downloadMarkdown, exportThreadToMarkdown } from "../../lib/thread-export";
import { useChatFocusStore } from "../../state/chat-focus-store";
import { useCheckpointsStore } from "../../state/checkpoints-store";
import { useConnectionStore } from "../../state/connection-store";
import { useNewChatPrefillStore } from "../../state/new-chat-prefill-store";
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
import { CommandPalette } from "../shared/CommandPalette";
import { HelpModal } from "../shared/HelpModal";
import { Lightbox } from "../shared/Lightbox";
import { NoticeStack } from "../shared/NoticeStack";
import { ReconnectBanner } from "../shared/ReconnectBanner";
import { StatusPill } from "../shared/StatusPill";
import { UndoToast } from "../shared/UndoToast";
import { StructuredInputModal } from "../structured-input/StructuredInputModal";

export function Workspace() {
  const status = useConnectionStore((state) => state.status);
  const reconnect = useConnectionStore((state) => state.reconnect);
  const connection = useConnectionStore((state) => state.connection);
  const hydrateFromDisk = useThreadsStore((state) => state.hydrateFromDisk);
  const showProjectPicker = useProjectStore((state) => state.show);
  const projectPickerOpen = useProjectStore((state) => state.open);
  const activeThreadTitle = useThreadsStore((state) => {
    const id = state.selectedThreadId;
    if (!id) return undefined;
    const thread = state.threads.find((t) => t.id === id) ?? state.archivedThreads.find((t) => t.id === id);
    return thread?.name ?? thread?.title;
  });
  useDocumentTitle(activeThreadTitle);
  const [overlay, setOverlay] = useState<"settings" | "about" | "newChat" | "help" | null>(null);
  const [newChatPrefill, setNewChatPrefill] = useState<{ cwd?: string; prompt?: string }>({});
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Watch the prefill store for incoming "Duplicate thread" requests. The
  // store is single-slot so we consume immediately and stash the values into
  // local state for the modal.
  const prefillPending = useNewChatPrefillStore((state) => state.pending);
  useEffect(() => {
    if (!prefillPending) return;
    const value = useNewChatPrefillStore.getState().consume();
    if (!value) return;
    setNewChatPrefill(value);
    setOverlay("newChat");
  }, [prefillPending]);
  // The drawer toggle only matters on narrow viewports — on wide ones the
  // sidebar is always visible regardless of this flag, courtesy of CSS.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The picker can be invoked either from a "Change project" affordance or
  // from the "New Chat" flow. We track who asked so we can route the result.
  const [pickerCallback, setPickerCallback] = useState<((path: string) => void) | null>(null);

  useEffect(() => {
    void hydrateFromDisk();
  }, [hydrateFromDisk]);

  // Deep-link boot. Parse `#thread/<id>` (optionally with `/message/<id>`)
  // once we have hydrated state — selectThread is async and `selectedThreadId`
  // would otherwise race with the hash on initial paint. We only run this
  // once per session; `applyHashOnceRef` gates against the StrictMode double
  // invoke that would otherwise re-fire selection on every mount.
  const applyHashOnceRef = useRef(false);
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  useEffect(() => {
    if (applyHashOnceRef.current) return;
    if (typeof window === "undefined") return;
    const location = parseHashLocation(window.location.hash);
    if (!location.threadId) {
      applyHashOnceRef.current = true;
      return;
    }
    applyHashOnceRef.current = true;
    void useThreadsStore.getState().selectThread(location.threadId);
    if (location.messageId) {
      useChatFocusStore.getState().request(location.threadId, location.messageId);
    }
  }, []);

  // Keep the URL hash in sync with the active thread so reload restores the
  // view. `replaceState` (not pushState) avoids spawning a back-button stack
  // entry per navigation. The hash gets cleared when no thread is selected.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = selectedThreadId ? buildHashLocation({ threadId: selectedThreadId }) : "";
    if (window.location.hash === target) return;
    if (window.location.hash === "" && target === "") return;
    const url = window.location.pathname + window.location.search + target;
    window.history.replaceState(null, "", url);
  }, [selectedThreadId]);

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

  // ⌘/Ctrl+K opens the cross-thread search palette. Handled at the workspace
  // level (rather than through useShortcut's bare-key gate) so the modifier
  // chord wins inside inputs too — nothing in the composer expects K with a
  // modifier.
  useShortcut("k", (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    setPaletteOpen((open) => !open);
  }, { skipWhenTyping: false });

  // `n` opens the New Chat modal — bypasses the sidebar button when the
  // user's hands are already on the keyboard.
  useShortcut("n", () => {
    setOverlay("newChat");
  });

  // `p` toggles pin on the active thread. Skipped when nothing's selected so
  // we don't surprise users with a "what just happened" no-op.
  useShortcut("p", () => {
    const state = useThreadsStore.getState();
    if (!state.selectedThreadId) return;
    void state.togglePinThread(state.selectedThreadId);
  });

  // `e` exports the active thread to Markdown. Lazy-grabs the threads-store
  // snapshot so we don't subscribe Workspace to per-message state churn.
  useShortcut("e", () => {
    const state = useThreadsStore.getState();
    const threadId = state.selectedThreadId;
    if (!threadId) return;
    const thread =
      state.threads.find((t) => t.id === threadId)
      ?? state.archivedThreads.find((t) => t.id === threadId);
    const messages = state.reducerStates[threadId]?.messages ?? [];
    if (messages.length === 0) return;
    const markdown = exportThreadToMarkdown({ thread, messages });
    downloadMarkdown(defaultExportFilename(thread?.name ?? thread?.title), markdown);
  });

  // `r` opens the revert sheet for the last-completed turn so power users
  // can roll back without scrolling to find the per-row Revert button.
  useShortcut("r", () => {
    if (!connection?.rpc) return;
    const state = useThreadsStore.getState();
    const threadId = state.selectedThreadId;
    if (!threadId) return;
    const thread =
      state.threads.find((t) => t.id === threadId)
      ?? state.archivedThreads.find((t) => t.id === threadId);
    if (!thread?.cwd) return;
    const messages = state.reducerStates[threadId]?.messages ?? [];
    // Walk backward and pick the last assistant turn that's settled — a
    // streaming turn isn't checkpoint-revertable yet.
    let targetTurnId: string | undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message.turnId) continue;
      if (message.role === "assistant" && !message.isStreaming) {
        targetTurnId = message.turnId;
        break;
      }
    }
    if (!targetTurnId) return;
    void useCheckpointsStore.getState().show(connection.rpc, {
      threadId,
      turnId: targetTurnId,
      cwd: thread.cwd,
    });
  });

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
        <button
          type="button"
          className="agnt-workspace-menu"
          aria-label={sidebarOpen ? "Close threads sidebar" : "Open threads sidebar"}
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          ☰
        </button>
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
      <div className={"agnt-workspace-body" + (sidebarOpen ? " agnt-sidebar-open" : "")}>
        {sidebarOpen && (
          <div
            className="agnt-sidebar-backdrop"
            role="presentation"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <Sidebar
          onNewChat={() => {
            setSidebarOpen(false);
            openNewChat();
          }}
          onAfterSelect={() => setSidebarOpen(false)}
        />
        <ChatView />
      </div>
      <NoticeStack />
      <UndoToast />
      <ApprovalModal />
      <StructuredInputModal />
      <RevertSheet />
      <Lightbox />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {overlay === "settings" && <SettingsModal onClose={() => setOverlay(null)} />}
      {overlay === "about" && <AboutModal onClose={() => setOverlay(null)} />}
      {overlay === "help" && <HelpModal onClose={() => setOverlay(null)} />}
      {overlay === "newChat" && (
        <NewChatModal
          onClose={() => {
            setOverlay(null);
            // Clear any consumed prefill so the next plain "+ New" doesn't
            // inherit a stale cwd/prompt from a duplicate-thread action.
            setNewChatPrefill({});
          }}
          onPickProject={pickProject}
          initialCwd={newChatPrefill.cwd}
          initialPrompt={newChatPrefill.prompt}
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
