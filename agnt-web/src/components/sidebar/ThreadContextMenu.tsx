// Inline action menu attached to a sidebar row. Compact + keyboard-friendly:
// the trigger button toggles open, escape or click-outside closes, and each
// action runs and closes the menu.

import { useEffect, useRef, useState } from "react";
import {
  defaultExportFilename,
  defaultJsonExportFilename,
  downloadJson,
  downloadMarkdown,
  exportThreadToJson,
  exportThreadToMarkdown,
} from "../../lib/thread-export";
import type { CodexThread } from "../../models";
import { useNewChatPrefillStore } from "../../state/new-chat-prefill-store";
import { isThreadUnread, useThreadsStore } from "../../state/threads-store";
import { THREAD_COLOR_VALUES, type ThreadColor } from "../../storage/prefs-store";
import { Ellipsis } from "../shared/Icon";
import { ThreadOverridesSheet } from "./ThreadOverridesSheet";

interface Props {
  thread: CodexThread;
  pinned?: boolean;
}

export function ThreadContextMenu({ thread, pinned = false }: Props) {
  const [open, setOpen] = useState(false);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const renameThread = useThreadsStore((state) => state.renameThread);
  const archiveThread = useThreadsStore((state) => state.archiveThread);
  const unarchiveThread = useThreadsStore((state) => state.unarchiveThread);
  const forkThread = useThreadsStore((state) => state.forkThread);
  const compactThread = useThreadsStore((state) => state.compactThread);
  const togglePinThread = useThreadsStore((state) => state.togglePinThread);
  const markThreadUnread = useThreadsStore((state) => state.markThreadUnread);
  const setThreadColor = useThreadsStore((state) => state.setThreadColor);
  const currentColor = useThreadsStore((state) => state.colorByThread[thread.id]);
  const unread = useThreadsStore((state) => isThreadUnread(thread, state.lastVisitedByThread));
  const exportMessages = useThreadsStore(
    (state) => state.reducerStates[thread.id]?.messages ?? []
  );

  function exportThread() {
    const markdown = exportThreadToMarkdown({ thread, messages: exportMessages });
    downloadMarkdown(defaultExportFilename(thread.name ?? thread.title), markdown);
  }

  function exportThreadAsJson() {
    const json = exportThreadToJson({ thread, messages: exportMessages });
    downloadJson(defaultJsonExportFilename(thread.name ?? thread.title), json);
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const action = (work: () => Promise<unknown> | void) => () => {
    setOpen(false);
    void work();
  };

  return (
    <div className="agnt-thread-menu" ref={containerRef}>
      <button
        type="button"
        className="agnt-thread-menu-trigger"
        aria-label="Thread actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <Ellipsis />
      </button>
      {open && (
        <div className="agnt-thread-menu-popover" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={action(() => {
              const next = window.prompt("Rename thread", thread.name ?? thread.title ?? "");
              if (next !== null && next.trim()) return renameThread(thread.id, next);
            })}
          >
            Rename…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={action(() => forkThread(thread.id))}
          >
            Fork from this thread
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={action(() => {
              // Pre-fill the New Chat modal with the source thread's cwd and
              // the first user prompt. The user reviews/edits before sending —
              // this is "clone the starting state" not "send the same turn".
              const firstUserText = exportMessages.find((m) => m.role === "user" && m.text.trim())?.text;
              useNewChatPrefillStore.getState().request({
                cwd: thread.cwd,
                prompt: firstUserText,
              });
            })}
            title="Open New Chat with this thread's cwd + first prompt pre-filled"
          >
            Duplicate…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={action(() => togglePinThread(thread.id))}
            title={pinned ? "Remove from the top of the sidebar" : "Sort to the top of the sidebar"}
          >
            {pinned ? "Unpin" : "Pin to top"}
          </button>
          <div className="agnt-thread-menu-colors" role="group" aria-label="Color tag">
            <span className="agnt-thread-menu-colors-label">Color</span>
            {THREAD_COLOR_VALUES.map((color) => (
              <button
                key={color}
                type="button"
                className={
                  "agnt-thread-color-swatch agnt-thread-color-" + color
                  + (currentColor === color ? " agnt-thread-color-swatch-active" : "")
                }
                aria-label={`Tag with ${color}`}
                aria-pressed={currentColor === color}
                onClick={action(() => setThreadColor(thread.id, color as ThreadColor))}
              />
            ))}
            <button
              type="button"
              className="agnt-thread-color-swatch agnt-thread-color-clear"
              aria-label="Clear color tag"
              aria-pressed={!currentColor}
              onClick={action(() => setThreadColor(thread.id, null))}
              title="Clear color"
            >
              ✕
            </button>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={action(() => setOverridesOpen(true))}
            title="Pin a system prompt + model + reasoning effort for this thread"
          >
            Thread overrides…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={action(() => compactThread(thread.id))}
            title="Summarize older turns to free context window space"
          >
            Compact thread…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={action(() => exportThread())}
            disabled={exportMessages.length === 0}
            title={exportMessages.length === 0 ? "No messages to export yet" : "Download a Markdown copy"}
          >
            Export to Markdown
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={action(() => exportThreadAsJson())}
            disabled={exportMessages.length === 0}
            title={exportMessages.length === 0 ? "No messages to export yet" : "Download a structured JSON copy"}
          >
            Export to JSON
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={action(() => markThreadUnread(thread.id))}
            disabled={unread}
            title={unread ? "Already marked unread" : "Restore the unread dot for revisit"}
          >
            Mark as unread
          </button>
          {thread.syncState === "live" ? (
            <button type="button" role="menuitem" onClick={action(() => archiveThread(thread.id))}>
              Archive
            </button>
          ) : (
            <button type="button" role="menuitem" onClick={action(() => unarchiveThread(thread.id))}>
              Unarchive
            </button>
          )}
        </div>
      )}
      {overridesOpen && (
        <ThreadOverridesSheet thread={thread} onClose={() => setOverridesOpen(false)} />
      )}
    </div>
  );
}
