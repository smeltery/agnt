import { useState } from "react";
import type { CodexThread } from "../../models";
import { useThreadsStore } from "../../state/threads-store";

type SidebarTab = "live" | "archived";

export function Sidebar() {
  const liveThreads = useThreadsStore((state) => state.threads);
  const archivedThreads = useThreadsStore((state) => state.archivedThreads);
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  const loading = useThreadsStore((state) => state.loading);
  const selectThread = useThreadsStore((state) => state.selectThread);
  const [tab, setTab] = useState<SidebarTab>("live");
  const visible = tab === "live" ? liveThreads : archivedThreads;

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
      {visible.length === 0 ? (
        <div className="agnt-sidebar-empty">{tab === "live" ? "No live threads yet." : "No archived threads."}</div>
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
    <li>
      <button
        type="button"
        className={"agnt-sidebar-thread" + (selected ? " agnt-sidebar-thread-selected" : "")}
        onClick={onSelect}
      >
        <span className="agnt-sidebar-thread-title">{title}</span>
        {thread.cwd && <span className="agnt-sidebar-thread-cwd">{thread.cwd}</span>}
      </button>
    </li>
  );
}
