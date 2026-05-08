import { useThreadsStore } from "../../state/threads-store";

export function Sidebar() {
  const threads = useThreadsStore((state) => state.threads);
  const selectedThreadId = useThreadsStore((state) => state.selectedThreadId);
  const loading = useThreadsStore((state) => state.loading);
  const selectThread = useThreadsStore((state) => state.selectThread);
  const refreshThreads = useThreadsStore((state) => state.refreshThreads);

  return (
    <aside className="agnt-sidebar">
      <div className="agnt-sidebar-header">
        <span className="agnt-sidebar-title">Threads</span>
        <button className="agnt-button-ghost" onClick={() => void refreshThreads()} disabled={loading}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>
      {threads.length === 0 ? (
        <div className="agnt-sidebar-empty">No threads yet. Start one from the chat.</div>
      ) : (
        <ul className="agnt-sidebar-list">
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                className={
                  "agnt-sidebar-thread" + (thread.id === selectedThreadId ? " agnt-sidebar-thread-selected" : "")
                }
                onClick={() => void selectThread(thread.id)}
              >
                <span className="agnt-sidebar-thread-title">{thread.title || "Untitled"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
