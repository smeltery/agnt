import { useState } from "react";
import type { CodexThread } from "../../models";
import { buildHashLocation } from "../../lib/hash-routing";
import { isThreadUnread, useThreadsStore } from "../../state/threads-store";
import type { ThreadGroup } from "../../state/thread-grouping";
import { ChevronDown, ChevronRight, PinFill } from "../shared/Icon";
import { ThreadContextMenu } from "./ThreadContextMenu";

export function SidebarGroup({
  group,
  showHeader,
  collapsed,
  onToggleCollapse,
  selectedThreadId,
  runningThreadIds,
  pinnedThreadIds,
  lastVisitedByThread,
  colorByThread,
  previewByThread,
  selectMode,
  selectedIds,
  onSelect,
  onReorderPinned,
}: {
  group: ThreadGroup;
  showHeader: boolean;
  collapsed: boolean;
  onToggleCollapse?(): void;
  selectedThreadId: string | null;
  runningThreadIds: Set<string>;
  pinnedThreadIds: Set<string>;
  lastVisitedByThread: Record<string, number>;
  colorByThread: Record<string, string>;
  previewByThread: Record<string, string>;
  selectMode: boolean;
  selectedIds: Set<string>;
  onSelect: (thread: CodexThread) => void;
  onReorderPinned?(orderedIds: string[]): void;
}) {
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const draggable = Boolean(onReorderPinned);

  function commitReorder(targetId: string) {
    if (!onReorderPinned || !dragSourceId || dragSourceId === targetId) return;
    const ids = group.threads.map((thread) => thread.id);
    const fromIndex = ids.indexOf(dragSourceId);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...ids];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    onReorderPinned(next);
  }

  return (
    <section className={"agnt-sidebar-group" + (collapsed ? " agnt-sidebar-group-collapsed" : "")}>
      {showHeader && (
        onToggleCollapse ? (
          <button
            type="button"
            className="agnt-sidebar-group-header agnt-sidebar-group-header-button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-controls={`agnt-sidebar-group-${group.id}`}
          >
            <span className="agnt-sidebar-group-chevron" aria-hidden>
              {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
            </span>
            <span>{group.label}</span>
            <span className="agnt-sidebar-group-count">{group.threads.length}</span>
          </button>
        ) : (
          <h3 className="agnt-sidebar-group-header">{group.label}</h3>
        )
      )}
      {collapsed ? null : (
        <ul className="agnt-sidebar-list" id={`agnt-sidebar-group-${group.id}`}>
          {group.threads.map((thread) => (
            <SidebarRow
              key={thread.id}
              thread={thread}
              selected={thread.id === selectedThreadId}
              running={runningThreadIds.has(thread.id)}
              pinned={pinnedThreadIds.has(thread.id)}
              unread={isThreadUnread(thread, lastVisitedByThread) && thread.id !== selectedThreadId}
              color={colorByThread[thread.id]}
              preview={previewByThread[thread.id]}
              selectMode={selectMode}
              checked={selectedIds.has(thread.id)}
              onSelect={() => onSelect(thread)}
              draggable={draggable}
              isDragSource={dragSourceId === thread.id}
              isDropTarget={dropTargetId === thread.id && dragSourceId !== thread.id}
              onDragStart={() => setDragSourceId(thread.id)}
              onDragEnd={() => {
                setDragSourceId(null);
                setDropTargetId(null);
              }}
              onDragEnter={() => {
                if (dragSourceId && dragSourceId !== thread.id) setDropTargetId(thread.id);
              }}
              onDrop={() => {
                commitReorder(thread.id);
                setDragSourceId(null);
                setDropTargetId(null);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SidebarRow({
  thread,
  selected,
  running,
  pinned,
  unread,
  color,
  preview,
  selectMode,
  checked,
  onSelect,
  draggable,
  isDragSource,
  isDropTarget,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
}: {
  thread: CodexThread;
  selected: boolean;
  running: boolean;
  pinned: boolean;
  unread: boolean;
  color?: string;
  preview?: string;
  selectMode: boolean;
  checked: boolean;
  onSelect: () => void;
  draggable?: boolean;
  isDragSource?: boolean;
  isDropTarget?: boolean;
  onDragStart?(): void;
  onDragEnd?(): void;
  onDragEnter?(): void;
  onDrop?(): void;
}) {
  const title = thread.name ?? thread.title ?? "Untitled";
  const renameThread = useThreadsStore((state) => state.renameThread);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(title);

  function startEditing() {
    if (selectMode) return;
    setDraftName(title);
    setEditing(true);
  }
  function commitEdit() {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== title) void renameThread(thread.id, trimmed);
    setEditing(false);
  }

  return (
    <li
      className={
        "agnt-sidebar-row"
        + (selected ? " agnt-sidebar-row-selected" : "")
        + (selectMode && checked ? " agnt-sidebar-row-checked" : "")
        + (unread ? " agnt-sidebar-row-unread" : "")
        + (color ? ` agnt-sidebar-row-color agnt-thread-color-${color}` : "")
        + (isDragSource ? " agnt-sidebar-row-dragging" : "")
        + (isDropTarget ? " agnt-sidebar-row-drop-target" : "")
        + (editing ? " agnt-sidebar-row-editing" : "")
      }
      draggable={draggable}
      onDragStart={(event) => {
        if (!draggable) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", thread.id);
        onDragStart?.();
      }}
      onDragEnd={() => onDragEnd?.()}
      onDragEnter={() => onDragEnter?.()}
      onDragOver={(event) => {
        if (!draggable) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        if (!draggable) return;
        event.preventDefault();
        onDrop?.();
      }}
    >
      <button
        type="button"
        className="agnt-sidebar-thread"
        title={thread.cwd ? `${title}\n${thread.cwd}` : title}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.button === 1) {
            event.preventDefault();
            openThreadTab(thread.id);
            return;
          }
          onSelect();
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          openThreadTab(thread.id);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          startEditing();
        }}
        aria-pressed={selectMode ? checked : undefined}
      >
        <span className="agnt-sidebar-thread-title">
          {selectMode && (
            <input
              type="checkbox"
              className="agnt-sidebar-row-checkbox"
              checked={checked}
              onChange={onSelect}
              onClick={(event) => event.stopPropagation()}
              aria-label={checked ? `Deselect ${title}` : `Select ${title}`}
            />
          )}
          {unread && !selectMode && (
            <span className="agnt-sidebar-unread-dot" aria-label="unread" title="New activity since you last viewed this thread" />
          )}
          {running && <span className="agnt-sidebar-running-dot" aria-label="running" title="Running" />}
          {pinned && (
            <span className="agnt-sidebar-pinned" aria-label="pinned" title="Pinned">
              <PinFill size={10} />
            </span>
          )}
          {editing ? (
            <input
              type="text"
              autoFocus
              className="agnt-sidebar-thread-rename"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitEdit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                }
              }}
              onClick={(event) => event.stopPropagation()}
              onBlur={commitEdit}
              aria-label={`Rename ${title}`}
            />
          ) : (
            title
          )}
        </span>
        {thread.cwd && <span className="agnt-sidebar-thread-cwd">{thread.cwd}</span>}
        {preview && <span className="agnt-sidebar-thread-preview">{preview}</span>}
      </button>
      {!selectMode && <ThreadContextMenu thread={thread} pinned={pinned} />}
    </li>
  );
}

function openThreadTab(threadId: string) {
  const url = window.location.pathname + window.location.search + buildHashLocation({ threadId });
  window.open(url, "_blank", "noopener,noreferrer");
}
