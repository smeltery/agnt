import { useEffect, useMemo, useRef, useState } from "react";
import type { CodexThread } from "../../models";
import { useTranslator } from "../../lib/i18n";
import { useShortcuts } from "../../lib/keyboard";
import {
  ChevronDown,
  ChevronRight,
  Line3Horizontal,
  Line3HorizontalDecrease,
  PinFill,
  Plus,
} from "../shared/Icon";
import {
  defaultExportFilename,
  downloadMarkdown,
  exportThreadsToMarkdown,
} from "../../lib/thread-export";
import { filterThreads } from "../../state/thread-filter";
import { groupThreadsByRecency, type ThreadGroup } from "../../state/thread-grouping";
import { buildHashLocation } from "../../lib/hash-routing";
import { isThreadUnread, useThreadsStore } from "../../state/threads-store";
import {
  prefsStore,
  THREAD_COLOR_VALUES,
  type SidebarDensity,
  type SidebarTabPreference,
  type ThreadColor,
} from "../../storage/prefs-store";
import { EmptyState, SidebarSkeleton } from "../shared/Loading";
import { MagnifyingGlass } from "../shared/Icon";
import { ThreadContextMenu } from "./ThreadContextMenu";

interface SidebarProps {
  onNewChat(): void;
  /** Called after a thread row is single-clicked (used to close the mobile drawer). */
  onAfterSelect?(): void;
}

type SidebarTab = SidebarTabPreference;

export function Sidebar({ onNewChat, onAfterSelect }: SidebarProps) {
  const t = useTranslator();
  const liveThreads = useThreadsStore((state) => state.threads);
  const archivedThreads = useThreadsStore((state) => state.archivedThreads);
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  const loading = useThreadsStore((state) => state.loading);
  const runningThreadIds = useThreadsStore((state) => state.runningThreadIds);
  const pinnedThreadIds = useThreadsStore((state) => state.pinnedThreadIds);
  const lastVisitedByThread = useThreadsStore((state) => state.lastVisitedByThread);
  const colorByThread = useThreadsStore((state) => state.colorByThread);
  const selectThread = useThreadsStore((state) => state.selectThread);
  const archiveThread = useThreadsStore((state) => state.archiveThread);
  const unarchiveThread = useThreadsStore((state) => state.unarchiveThread);
  const reorderPinnedThreads = useThreadsStore((state) => state.reorderPinnedThreads);
  const reducerStates = useThreadsStore((state) => state.reducerStates);
  const [tab, setTab] = useState<SidebarTab>("live");
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [density, setDensity] = useState<SidebarDensity>("comfortable");
  // Multi-select mode: when on, row clicks toggle selection instead of
  // navigating. The action bar at the top performs Archive / Unarchive /
  // Export across the chosen set.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // null = no color filter (show every color). The strip below toggles
  // a swatch on/off; toggling the same swatch twice clears the filter.
  // Intentionally not persisted — color filter is a transient lens, not
  // a long-lived view state.
  const [colorFilter, setColorFilter] = useState<ThreadColor | null>(null);
  const hydratedRef = useRef(false);

  // Hydrate persisted prefs once; later changes to tab/query persist via the
  // effect below. Reading them from IndexedDB is async so we set hydratedRef
  // to gate the saver — otherwise the initial setTab("live") call would
  // overwrite the just-loaded preference.
  useEffect(() => {
    void prefsStore.loadSidebar().then((prefs) => {
      if (prefs.tab === "archived" || prefs.tab === "live") setTab(prefs.tab);
      if (typeof prefs.query === "string") setQuery(prefs.query);
      if (Array.isArray(prefs.collapsedGroups)) setCollapsedGroups(new Set(prefs.collapsedGroups));
      if (prefs.density === "compact" || prefs.density === "comfortable") setDensity(prefs.density);
      hydratedRef.current = true;
    });
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    // Tiny payloads, no debounce — every tab toggle and every keystroke writes.
    void prefsStore.saveSidebar({
      tab,
      query,
      collapsedGroups: [...collapsedGroups],
      density,
    });
  }, [tab, query, collapsedGroups, density]);

  function toggleGroupCollapse(groupId: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  // Switching tabs while in select mode would surface a confusing "selected
  // count" that includes IDs no longer visible. Reset selection on tab change.
  useEffect(() => {
    if (selectedIds.size > 0) setSelectedIds(new Set());
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // The visible list drives j/k navigation (it has to be flat for that),
  // while `groups` is the partitioned view we render. Both stay in sync via
  // the same filter + grouping pass.
  const { visible, groups } = useMemo(() => {
    let filtered = filterThreads(tab === "live" ? liveThreads : archivedThreads, query);
    // Color filter intersects with the search filter — only threads that
    // pass both end up in the visible list. `null` means "all colors";
    // otherwise restrict to threads tagged with the picked color.
    if (colorFilter) {
      filtered = filtered.filter((thread) => colorByThread[thread.id] === colorFilter);
    }
    if (tab !== "live") {
      const archivedGroup = { id: "earlier" as const, label: "Archived", threads: filtered };
      const visibleArchived = collapsedGroups.has(archivedGroup.id) ? [] : filtered;
      return { visible: visibleArchived, groups: [archivedGroup] };
    }
    const sectioned = groupThreadsByRecency(filtered, { pinnedIds: pinnedThreadIds });
    // Threads in collapsed groups stay rendered as a header-only row but are
    // skipped by j/k navigation since they're not visible to the user.
    const flat = sectioned.flatMap((group) => (collapsedGroups.has(group.id) ? [] : group.threads));
    return { visible: flat, groups: sectioned };
  }, [tab, liveThreads, archivedThreads, query, pinnedThreadIds, collapsedGroups, colorFilter, colorByThread]);

  // j/k navigate the visible list, like Gmail/Linear. Wraps at the boundaries
  // so muscle memory works either direction. Disabled in multi-select mode so
  // users can't accidentally jump-and-archive the wrong thread.
  useShortcuts({
    j: () => !selectMode && stepSelection(visible, selectedThreadId, 1, selectThread),
    k: () => !selectMode && stepSelection(visible, selectedThreadId, -1, selectThread),
  });

  // Cmd / Ctrl + 1..9 jumps to the Nth visible thread. Cmd+1 selects the
  // first row in the current view (which is whatever's at the top after
  // pinning + recency grouping); Cmd+9 selects the ninth. Different from
  // j / k because:
  //   - Bypasses the "skip when typing" check — Cmd+digit is unambiguously
  //     a global shortcut, never text input.
  //   - Skips selectMode gate — power users running bulk-archive still
  //     want to hop to a different thread mid-flow.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      // `event.code` keeps "Digit1" stable across keyboard layouts; the
      // `event.key` would surface localized digits or accented variants
      // on some keyboards.
      if (!event.code?.startsWith("Digit")) return;
      const digit = Number(event.code.slice(5));
      if (!digit || digit < 1 || digit > 9) return;
      const target = visible[digit - 1];
      if (!target) return;
      event.preventDefault();
      void selectThread(target.id);
      onAfterSelect?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selectThread, onAfterSelect]);

  function handleRowSelect(thread: CodexThread) {
    if (selectMode) {
      toggleId(thread.id);
      return;
    }
    void selectThread(thread.id);
    onAfterSelect?.();
  }

  function toggleId(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  async function archiveSelected() {
    // Walk a copy because each archive call moves the thread out of `threads`
    // and our snapshot would shift under the iterator.
    const ids = Array.from(selectedIds);
    for (const id of ids) await archiveThread(id);
    exitSelectMode();
  }

  async function unarchiveSelected() {
    const ids = Array.from(selectedIds);
    for (const id of ids) await unarchiveThread(id);
    exitSelectMode();
  }

  function exportSelected() {
    const all = [...liveThreads, ...archivedThreads];
    const exports = Array.from(selectedIds).flatMap((id) => {
      const thread = all.find((t) => t.id === id);
      if (!thread) return [];
      const messages = reducerStates[id]?.messages ?? [];
      if (messages.length === 0) return [];
      return [{ thread, messages }];
    });
    if (exports.length === 0) {
      exitSelectMode();
      return;
    }
    const markdown = exportThreadsToMarkdown(exports);
    const filename = exports.length === 1
      ? defaultExportFilename(exports[0].thread.name ?? exports[0].thread.title)
      : `agnt-threads-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    downloadMarkdown(filename, markdown);
    exitSelectMode();
  }

  return (
    <aside className={"agnt-sidebar agnt-sidebar-density-" + density}>
      <div className="agnt-sidebar-header">
        <span className="agnt-sidebar-title">Threads</span>
        {loading && <span className="agnt-sidebar-loading">syncing…</span>}
        {!selectMode && (
          <button
            type="button"
            className="agnt-sidebar-density-toggle"
            onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}
            title={density === "compact" ? "Switch to comfortable density" : "Switch to compact density"}
            aria-label={density === "compact" ? "Comfortable density" : "Compact density"}
          >
            {density === "compact" ? <Line3HorizontalDecrease /> : <Line3Horizontal />}
          </button>
        )}
        {!selectMode && (
          <button
            type="button"
            className="agnt-sidebar-select-toggle"
            onClick={() => setSelectMode(true)}
            title="Select multiple threads"
          >
            Select
          </button>
        )}
        <button type="button" className="agnt-sidebar-new" onClick={onNewChat} title="New chat" aria-label="New chat">
          <Plus /> {t("sidebar.newChat")}
        </button>
      </div>
      {selectMode && (
        <div className="agnt-sidebar-select-bar">
          <span className="agnt-sidebar-select-count">{selectedIds.size} selected</span>
          <div className="agnt-sidebar-select-actions">
            {tab === "live" ? (
              <button
                type="button"
                className="agnt-button-ghost"
                disabled={selectedIds.size === 0}
                onClick={() => void archiveSelected()}
              >
                Archive
              </button>
            ) : (
              <button
                type="button"
                className="agnt-button-ghost"
                disabled={selectedIds.size === 0}
                onClick={() => void unarchiveSelected()}
              >
                Unarchive
              </button>
            )}
            <button
              type="button"
              className="agnt-button-ghost"
              disabled={selectedIds.size === 0}
              onClick={exportSelected}
            >
              Export
            </button>
            <button type="button" className="agnt-button-ghost" onClick={exitSelectMode}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="agnt-sidebar-tabs" role="tablist">
        <SidebarTabButton current={tab} value="live" label={`Live (${liveThreads.length})`} onClick={setTab} />
        <SidebarTabButton current={tab} value="archived" label={`Archived (${archivedThreads.length})`} onClick={setTab} />
      </div>
      <div className="agnt-sidebar-search">
        <input
          type="search"
          className="agnt-sidebar-search-input"
          placeholder={t("sidebar.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            }
          }}
        />
      </div>
      {/* Color filter strip: only renders when at least one thread is
          tagged. Otherwise the swatches are dead-clickable buttons that
          just empty the visible list — confusing. The "All" affordance
          is implicit: clicking the active swatch a second time clears
          the filter. */}
      {Object.keys(colorByThread).length > 0 && (
        <div className="agnt-sidebar-color-filter" role="toolbar" aria-label="Filter by color tag">
          {THREAD_COLOR_VALUES.map((color) => {
            // Suppress swatches for colors that don't appear in the
            // current tab's threads — clicking one would zero the list.
            const present = visible.some((t) => colorByThread[t.id] === color)
              || (colorFilter !== color && Object.values(colorByThread).includes(color));
            if (!present) return null;
            const active = colorFilter === color;
            return (
              <button
                key={color}
                type="button"
                className={"agnt-thread-color-swatch agnt-thread-color-" + color
                  + (active ? " agnt-thread-color-swatch-active" : "")}
                onClick={() => setColorFilter(active ? null : color)}
                aria-pressed={active}
                title={active ? `Clear ${color} filter` : `Filter to ${color}-tagged threads`}
              />
            );
          })}
          {colorFilter && (
            <button
              type="button"
              className="agnt-sidebar-color-filter-clear"
              onClick={() => setColorFilter(null)}
              title="Show all colors"
            >
              Clear
            </button>
          )}
        </div>
      )}
      {/* Cold start: bridge `thread/list` is in flight and we have nothing
          local to paint yet. Show shimmer rows instead of an empty card so
          the user sees that something's happening. */}
      {loading && visible.length === 0 && liveThreads.length === 0 && archivedThreads.length === 0 ? (
        <SidebarSkeleton />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<MagnifyingGlass size={22} />}
          title={
            query
              ? t("sidebar.empty.search")
              : tab === "live"
                ? t("sidebar.empty.live")
                : t("sidebar.empty.archived")
          }
          message={
            query
              ? "Try a different search."
              : tab === "live"
                ? "Tap + New to start a conversation."
                : "Archived threads land here once you archive them."
          }
        />
      ) : (
        <div className="agnt-sidebar-groups">
          {groups.map((group) => {
            const collapsed = collapsedGroups.has(group.id);
            // Show the collapsible header for archived (single group) too, so the
            // collapse-everything affordance is consistent across tabs.
            const showHeader = tab === "live" ? groups.length > 1 : true;
            return (
              <SidebarGroup
                key={group.id}
                group={group}
                showHeader={showHeader}
                collapsed={collapsed}
                onToggleCollapse={showHeader ? () => toggleGroupCollapse(group.id) : undefined}
                selectedThreadId={selectedThreadId}
                runningThreadIds={runningThreadIds}
                pinnedThreadIds={pinnedThreadIds}
                lastVisitedByThread={lastVisitedByThread}
                colorByThread={colorByThread}
                selectMode={selectMode}
                selectedIds={selectedIds}
                onSelect={handleRowSelect}
                onReorderPinned={
                  group.id === "pinned" && !selectMode
                    ? (orderedIds) => void reorderPinnedThreads(orderedIds)
                    : undefined
                }
              />
            );
          })}
        </div>
      )}
    </aside>
  );
}

function stepSelection(
  visible: CodexThread[],
  current: string | null,
  delta: 1 | -1,
  selectThread: (id: string) => Promise<void> | void
): void {
  if (visible.length === 0) return;
  const currentIndex = current ? visible.findIndex((thread) => thread.id === current) : -1;
  const nextIndex =
    currentIndex < 0
      ? delta === 1
        ? 0
        : visible.length - 1
      : (currentIndex + delta + visible.length) % visible.length;
  void selectThread(visible[nextIndex].id);
}

function SidebarTabButton({
  current,
  value,
  label,
  onClick,
}: {
  current: SidebarTab;
  value: SidebarTab;
  label: string;
  onClick: (next: SidebarTab) => void;
}) {
  return (
    <button
      role="tab"
      type="button"
      aria-selected={current === value}
      className={"agnt-sidebar-tab" + (current === value ? " agnt-sidebar-tab-active" : "")}
      onClick={() => onClick(value)}
    >
      {label}
    </button>
  );
}

function SidebarGroup({
  group,
  showHeader,
  collapsed,
  onToggleCollapse,
  selectedThreadId,
  runningThreadIds,
  pinnedThreadIds,
  lastVisitedByThread,
  colorByThread,
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
  // Inline rename: double-click the title to swap the row into edit mode.
  // Enter commits the rename via threads-store; Esc / blur reverts.
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
        // Stash the thread id so a future cross-component drop could read it,
        // but keep the move logic state-driven via the React handlers.
        if (draggable) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", thread.id);
          onDragStart?.();
        }
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
        // Surface the full title + cwd as a hover tooltip — long names
        // truncate via `text-overflow: ellipsis` and the user otherwise
        // can't see what was clipped without selecting the row.
        title={thread.cwd ? `${title}\n${thread.cwd}` : title}
        onClick={(event) => {
          // ⌘/Ctrl-click + middle-click open the thread in a new tab via
          // the existing hash deep-link route. This lets power users keep
          // a long-running thread in one tab while exploring others.
          if (event.metaKey || event.ctrlKey || event.button === 1) {
            event.preventDefault();
            const url =
              window.location.pathname +
              window.location.search +
              buildHashLocation({ threadId: thread.id });
            window.open(url, "_blank", "noopener,noreferrer");
            return;
          }
          onSelect();
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          const url =
            window.location.pathname +
            window.location.search +
            buildHashLocation({ threadId: thread.id });
          window.open(url, "_blank", "noopener,noreferrer");
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
      </button>
      {!selectMode && <ThreadContextMenu thread={thread} pinned={pinned} />}
    </li>
  );
}
