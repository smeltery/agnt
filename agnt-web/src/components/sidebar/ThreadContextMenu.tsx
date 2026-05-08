// Inline action menu attached to a sidebar row. Compact + keyboard-friendly:
// the trigger button toggles open, escape or click-outside closes, and each
// action runs and closes the menu.

import { useEffect, useRef, useState } from "react";
import { defaultExportFilename, downloadMarkdown, exportThreadToMarkdown } from "../../lib/thread-export";
import type { CodexThread } from "../../models";
import { useThreadsStore } from "../../state/threads-store";

interface Props {
  thread: CodexThread;
  pinned?: boolean;
}

export function ThreadContextMenu({ thread, pinned = false }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const renameThread = useThreadsStore((state) => state.renameThread);
  const archiveThread = useThreadsStore((state) => state.archiveThread);
  const unarchiveThread = useThreadsStore((state) => state.unarchiveThread);
  const forkThread = useThreadsStore((state) => state.forkThread);
  const compactThread = useThreadsStore((state) => state.compactThread);
  const togglePinThread = useThreadsStore((state) => state.togglePinThread);
  const exportMessages = useThreadsStore(
    (state) => state.reducerStates[thread.id]?.messages ?? []
  );

  function exportThread() {
    const markdown = exportThreadToMarkdown({ thread, messages: exportMessages });
    downloadMarkdown(defaultExportFilename(thread.name ?? thread.title), markdown);
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
        ⋯
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
            onClick={action(() => togglePinThread(thread.id))}
            title={pinned ? "Remove from the top of the sidebar" : "Sort to the top of the sidebar"}
          >
            {pinned ? "Unpin" : "Pin to top"}
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
    </div>
  );
}
