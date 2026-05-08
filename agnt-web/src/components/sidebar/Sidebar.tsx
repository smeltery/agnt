import { useEffect, useMemo, useRef, useState } from "react";
import type { CodexThread } from "../../models";
import { useShortcuts } from "../../lib/keyboard";
import { filterThreads } from "../../state/thread-filter";
import { groupThreadsByRecency, type ThreadGroup } from "../../state/thread-grouping";
import { useThreadsStore } from "../../state/threads-store";
import { prefsStore, type SidebarTabPreference } from "../../storage/prefs-store";
import { ThreadContextMenu } from "./ThreadContextMenu";

interface SidebarProps {
  onNewChat(): void;
}

type SidebarTab = SidebarTabPreference;

export function Sidebar({ onNewChat }: SidebarProps) {
  const liveThreads = useThreadsStore((state) => state.threads);
  const archivedThreads = useThreadsStore((state) => state.archivedThreads);
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  const loading = useThreadsStore((state) => state.loading);
  const runningThreadIds = useThreadsStore((state) => state.runningThreadIds);
  const pinnedThreadIds = useThreadsStore((state) => state.pinnedThreadIds);
  const selectThread = useThreadsStore((state) => state.selectThread);
  const [tab, setTab] = useState<SidebarTab>("live");
  const [query, setQuery] = useState("");
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
  // so muscle memory works either direction.
  useShortcuts({
    j: () => stepSelection(visible, selectedThreadId, 1, selectThread),
    k: () => stepSelection(visible, selectedThreadId, -1, selectThread),
  });

  return (
    <aside className="agnt-sidebar">
      <div className="agnt-sidebar-header">
        <span className="agnt-sidebar-title">Threads</span>
        {loading && <span className="agnt-sidebar-loading">syncing…</span>}
        <button type="button" className="agnt-sidebar-new" onClick={onNewChat} title="New chat">
          + New
        </button>
      </div>
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
              onSelect={selectThread}
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
  onSelect,
}: {
  group: ThreadGroup;
  showHeader: boolean;
  selectedThreadId: string | null;
  runningThreadIds: Set<string>;
  pinnedThreadIds: Set<string>;
  onSelect: (threadId: string) => Promise<void> | void;
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
            onSelect={() => void onSelect(thread.id)}
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
  onSelect,
}: {
  thread: CodexThread;
  selected: boolean;
  running: boolean;
  pinned: boolean;
  onSelect: () => void;
}) {
  const title = thread.name ?? thread.title ?? "Untitled";
  return (
    <li className={"agnt-sidebar-row" + (selected ? " agnt-sidebar-row-selected" : "")}>
      <button type="button" className="agnt-sidebar-thread" onClick={onSelect}>
        <span className="agnt-sidebar-thread-title">
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
      <ThreadContextMenu thread={thread} pinned={pinned} />
    </li>
  );
}
