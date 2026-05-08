// Inline action menu attached to a sidebar row. Compact + keyboard-friendly:
// the trigger button toggles open, escape or click-outside closes, and each
// action runs and closes the menu.

import { useEffect, useRef, useState } from "react";
import type { CodexThread } from "../../models";
import { useThreadsStore } from "../../state/threads-store";

interface Props {
  thread: CodexThread;
}

export function ThreadContextMenu({ thread }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const renameThread = useThreadsStore((state) => state.renameThread);
  const archiveThread = useThreadsStore((state) => state.archiveThread);
  const unarchiveThread = useThreadsStore((state) => state.unarchiveThread);
  const forkThread = useThreadsStore((state) => state.forkThread);

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
