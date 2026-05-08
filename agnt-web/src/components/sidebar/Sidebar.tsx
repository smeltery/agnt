import { useEffect, useMemo, useRef, useState } from "react";
import type { CodexThread } from "../../models";
import { useShortcuts } from "../../lib/keyboard";
import {
  defaultExportFilename,
  downloadMarkdown,
  exportThreadsToMarkdown,
} from "../../lib/thread-export";
import { filterThreads } from "../../state/thread-filter";
import { groupThreadsByRecency, type ThreadGroup } from "../../state/thread-grouping";
import { useThreadsStore } from "../../state/threads-store";
import { prefsStore, type SidebarTabPreference } from "../../storage/prefs-store";
import { ThreadContextMenu } from "./ThreadContextMenu";

interface SidebarProps {
  onNewChat(): void;
  /** Called after a thread row is single-clicked (used to close the mobile drawer). */
  onAfterSelect?(): void;
}

type SidebarTab = SidebarTabPreference;

export function Sidebar({ onNewChat, onAfterSelect }: SidebarProps) {
  const liveThreads = useThreadsStore((state) => state.threads);
  const archivedThreads = useThreadsStore((state) => state.archivedThreads);
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  const loading = useThreadsStore((state) => state.loading);
  const runningThreadIds = useThreadsStore((state) => state.runningThreadIds);
  const pinnedThreadIds = useThreadsStore((state) => state.pinnedThreadIds);
  const selectThread = useThreadsStore((state) => state.selectThread);
  const archiveThread = useThreadsStore((state) => state.archiveThread);
  const unarchiveThread = useThreadsStore((state) => state.unarchiveThread);
  const reducerStates = useThreadsStore((state) => state.reducerStates);
  const [tab, setTab] = useState<SidebarTab>("live");
  const [query, setQuery] = useState("");
  // Multi-select mode: when on, row clicks toggle selection instead of
  // navigating. The action bar at the top performs Archive / Unarchive /
  // Export across the chosen set.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const hydratedRef = useRef(false);

  // Hydrate persisted prefs once; later changes to tab/query persist via the
  // effect below. Reading them from IndexedDB is async so we set hydratedRef
  // to gate the saver — otherwise the initial setTab("live") call would
  // overwrite the just-loaded preference.
  useEffect(() => {
    void prefsStore.loadSidebar().then((prefs) => {
      if (prefs.tab === "archived" || prefs.tab === "live") setTab(prefs.tab);
      if (typeof prefs.query === "string") setQuery(prefs.query);
      hydratedRef.current = true;
    });
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    // Tiny payloads, no debounce — every tab toggle and every keystroke writes.
    void prefsStore.saveSidebar({ tab, query });
  }, [tab, query]);

  // Switching tabs while in select mode would surface a confusing "selected
  // count" that includes IDs no longer visible. Reset selection on tab change.
  useEffect(() => {
    if (selectedIds.size > 0) setSelectedIds(new Set());
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // The visible list drives j/k navigation (it has to be flat for that),
  // while `groups` is the partitioned view we render. Both stay in sync via
  // the same filter + grouping pass.
  const { visible, groups } = useMemo(() => {
    const filtered = filterThreads(tab === "live" ? liveThreads : archivedThreads, query);
    if (tab !== "live") {
      return { visible: filtered, groups: [{ id: "earlier" as const, label: "Archived", threads: filtered }] };
    }
    const sectioned = groupThreadsByRecency(filtered, { pinnedIds: pinnedThreadIds });
    const flat = sectioned.flatMap((group) => group.threads);
    return { visible: flat, groups: sectioned };
  }, [tab, liveThreads, archivedThreads, query, pinnedThreadIds]);

  // j/k navigate the visible list, like Gmail/Linear. Wraps at the boundaries
  // so muscle memory works either direction. Disabled in multi-select mode so
  // users can't accidentally jump-and-archive the wrong thread.
  useShortcuts({
    j: () => !selectMode && stepSelection(visible, selectedThreadId, 1, selectThread),
    k: () => !selectMode && stepSelection(visible, selectedThreadId, -1, selectThread),
  });

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
    <aside className="agnt-sidebar">
      <div className="agnt-sidebar-header">
        <span className="agnt-sidebar-title">Threads</span>
        {loading && <span className="agnt-sidebar-loading">syncing…</span>}
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
        <button type="button" className="agnt-sidebar-new" onClick={onNewChat} title="New chat">
          + New
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
          placeholder="Search threads…"
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
      {visible.length === 0 ? (
        <div className="agnt-sidebar-empty">
          {query ? "No threads match your search." : tab === "live" ? "No live threads yet." : "No archived threads."}
        </div>
      ) : (
        <div className="agnt-sidebar-groups">
          {groups.map((group) => (
            <SidebarGroup
              key={group.id}
              group={group}
              showHeader={tab === "live" && groups.length > 1}
              selectedThreadId={selectedThreadId}
              runningThreadIds={runningThreadIds}
              pinnedThreadIds={pinnedThreadIds}
              selectMode={selectMode}
              selectedIds={selectedIds}
              onSelect={handleRowSelect}
            />
          ))}
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
  selectedThreadId,
  runningThreadIds,
  pinnedThreadIds,
  selectMode,
  selectedIds,
  onSelect,
}: {
  group: ThreadGroup;
  showHeader: boolean;
  selectedThreadId: string | null;
  runningThreadIds: Set<string>;
  pinnedThreadIds: Set<string>;
  selectMode: boolean;
  selectedIds: Set<string>;
  onSelect: (thread: CodexThread) => void;
}) {
  return (
    <section className="agnt-sidebar-group">
      {showHeader && <h3 className="agnt-sidebar-group-header">{group.label}</h3>}
      <ul className="agnt-sidebar-list">
        {group.threads.map((thread) => (
          <SidebarRow
            key={thread.id}
            thread={thread}
            selected={thread.id === selectedThreadId}
            running={runningThreadIds.has(thread.id)}
            pinned={pinnedThreadIds.has(thread.id)}
            selectMode={selectMode}
            checked={selectedIds.has(thread.id)}
            onSelect={() => onSelect(thread)}
          />
        ))}
      </ul>
    </section>
  );
}

function SidebarRow({
  thread,
  selected,
  running,
  pinned,
  selectMode,
  checked,
  onSelect,
}: {
  thread: CodexThread;
  selected: boolean;
  running: boolean;
  pinned: boolean;
  selectMode: boolean;
  checked: boolean;
  onSelect: () => void;
}) {
  const title = thread.name ?? thread.title ?? "Untitled";
  return (
    <li
      className={
        "agnt-sidebar-row"
        + (selected ? " agnt-sidebar-row-selected" : "")
        + (selectMode && checked ? " agnt-sidebar-row-checked" : "")
      }
    >
      <button
        type="button"
        className="agnt-sidebar-thread"
        onClick={onSelect}
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
          {running && <span className="agnt-sidebar-running-dot" aria-label="running" title="Running" />}
          {pinned && (
            <span className="agnt-sidebar-pinned" aria-label="pinned" title="Pinned">
              ★
            </span>
          )}
          {title}
        </span>
        {thread.cwd && <span className="agnt-sidebar-thread-cwd">{thread.cwd}</span>}
      </button>
      {!selectMode && <ThreadContextMenu thread={thread} pinned={pinned} />}
    </li>
  );
}
