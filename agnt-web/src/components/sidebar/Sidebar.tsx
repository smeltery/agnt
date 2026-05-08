import { useMemo, useState } from "react";
import type { CodexThread } from "../../models";
import { useShortcuts } from "../../lib/keyboard";
import { filterThreads } from "../../state/thread-filter";
import { useThreadsStore } from "../../state/threads-store";
import { ThreadContextMenu } from "./ThreadContextMenu";

type SidebarTab = "live" | "archived";

export function Sidebar() {
  const liveThreads = useThreadsStore((state) => state.threads);
  const archivedThreads = useThreadsStore((state) => state.archivedThreads);
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  const loading = useThreadsStore((state) => state.loading);
  const selectThread = useThreadsStore((state) => state.selectThread);
  const [tab, setTab] = useState<SidebarTab>("live");
  const [query, setQuery] = useState("");
  const visible = useMemo(
    () => filterThreads(tab === "live" ? liveThreads : archivedThreads, query),
    [tab, liveThreads, archivedThreads, query]
  );

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
        <ul className="agnt-sidebar-list">
          {visible.map((thread) => (
            <SidebarRow
              key={thread.id}
              thread={thread}
              selected={thread.id === selectedThreadId}
              onSelect={() => void selectThread(thread.id)}
            />
          ))}
        </ul>
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

function SidebarRow({ thread, selected, onSelect }: { thread: CodexThread; selected: boolean; onSelect: () => void }) {
  const title = thread.name ?? thread.title ?? "Untitled";
  return (
    <li className={"agnt-sidebar-row" + (selected ? " agnt-sidebar-row-selected" : "")}>
      <button type="button" className="agnt-sidebar-thread" onClick={onSelect}>
        <span className="agnt-sidebar-thread-title">{title}</span>
        {thread.cwd && <span className="agnt-sidebar-thread-cwd">{thread.cwd}</span>}
      </button>
      <ThreadContextMenu thread={thread} />
    </li>
  );
}
