// Lazy file/directory browser pane rooted at the active thread's cwd.
// Stacks above (visually beside) the GitPanel inside the chat header — the
// idea being users can browse workspace files in the same place they look
// at git status. Selecting an entry inserts a `@cwd-relative-path` mention
// into the composer via the Session 27 inbox.

import { useEffect } from "react";
import { formatMentionPath } from "../../lib/file-mention";
import type { JsonRpcClient } from "../../protocol/jsonrpc-client";
import type { ProjectDirectoryEntry } from "../../protocol/project";
import { useComposerInboxStore } from "../../state/composer-inbox-store";
import { useFileBrowserStore } from "../../state/file-browser-store";

interface FileBrowserProps {
  threadId: string;
  cwd: string;
  rpc: JsonRpcClient | null;
}

export function FileBrowser({ threadId, cwd, rpc }: FileBrowserProps) {
  const listing = useFileBrowserStore((state) => state.listings[cwd]);
  const loading = useFileBrowserStore((state) => Boolean(state.loading[cwd]));
  const error = useFileBrowserStore((state) => state.error[cwd]);
  const loadDirectory = useFileBrowserStore((state) => state.loadDirectory);
  const invalidate = useFileBrowserStore((state) => state.invalidate);

  // Fetch on mount + whenever cwd changes. We don't auto-refresh on
  // filesystem mutations (no watcher RPC); a manual refresh button covers
  // the case where the user just edited files outside the agent.
  useEffect(() => {
    if (!rpc || !cwd) return;
    if (!listing) void loadDirectory(rpc, cwd);
  }, [rpc, cwd, listing, loadDirectory]);

  if (!rpc) return null;
  if (!cwd) {
    return (
      <div className="agnt-files-empty">Set a project (cwd) to browse workspace files.</div>
    );
  }

  return (
    <section className="agnt-files-panel" aria-label="Workspace files">
      <header className="agnt-files-header">
        <span className="agnt-row-tag">files</span>
        <code className="agnt-files-cwd">{cwd}</code>
        <button
          type="button"
          className="agnt-button-ghost"
          onClick={() => {
            invalidate(cwd);
            void loadDirectory(rpc, cwd);
          }}
          disabled={loading}
          title="Reload directory listing"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </header>
      {error && <div className="agnt-files-error">{error}</div>}
      {!listing && !error && !loading && (
        <div className="agnt-files-empty">Loading workspace files…</div>
      )}
      {listing && listing.entries.length === 0 && (
        <div className="agnt-files-empty">Empty directory.</div>
      )}
      {listing && listing.entries.length > 0 && (
        <ul className="agnt-files-list" role="tree">
          {listing.entries.map((entry) => (
            <FileEntry key={entry.path} entry={entry} cwd={cwd} threadId={threadId} rpc={rpc} depth={0} />
          ))}
        </ul>
      )}
    </section>
  );
}

interface FileEntryProps {
  entry: ProjectDirectoryEntry;
  cwd: string;
  threadId: string;
  rpc: JsonRpcClient;
  depth: number;
}

function FileEntry({ entry, cwd, threadId, rpc, depth }: FileEntryProps) {
  const expanded = useFileBrowserStore((state) => state.expanded.has(entry.path));
  const childListing = useFileBrowserStore((state) => state.listings[entry.path]);
  const childLoading = useFileBrowserStore((state) => Boolean(state.loading[entry.path]));
  const toggleExpanded = useFileBrowserStore((state) => state.toggleExpanded);
  const loadDirectory = useFileBrowserStore((state) => state.loadDirectory);

  const isDirectory = looksLikeDirectory(entry);

  function activate() {
    if (isDirectory) {
      if (!childListing && !childLoading) void loadDirectory(rpc, entry.path);
      toggleExpanded(entry.path);
      return;
    }
    // Files insert a `@path` mention into the composer draft — same path
    // formatter the inline @-picker uses, so behavior is consistent.
    const path = formatMentionPath(entry.path, cwd);
    useComposerInboxStore.getState().request({ threadId, body: `@${path} ` });
    document.getElementById("agnt-composer-input")?.focus();
  }

  return (
    <li className="agnt-files-item" role="treeitem" aria-expanded={isDirectory ? expanded : undefined}>
      <button
        type="button"
        className="agnt-files-row"
        onClick={activate}
        style={{ paddingLeft: 6 + depth * 14 }}
        title={isDirectory ? `Expand ${entry.name}` : `Insert @${formatMentionPath(entry.path, cwd)} into the draft`}
      >
        <span className="agnt-files-row-icon" aria-hidden>
          {isDirectory ? (expanded ? "▾" : "▸") : "·"}
        </span>
        <code className="agnt-files-row-name">{entry.name}</code>
      </button>
      {isDirectory && expanded && (
        <ul className="agnt-files-list" role="group">
          {childLoading && !childListing && (
            <li className="agnt-files-empty agnt-files-empty-nested">Loading…</li>
          )}
          {childListing && childListing.entries.length === 0 && (
            <li className="agnt-files-empty agnt-files-empty-nested">Empty.</li>
          )}
          {childListing?.entries.map((child) => (
            <FileEntry
              key={child.path}
              entry={child}
              cwd={cwd}
              threadId={threadId}
              rpc={rpc}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The bridge's `ProjectDirectoryEntry` doesn't include an explicit isDir
 * flag — historically files and dirs both surface as plain {name, path}.
 * We treat anything with no extension as a directory candidate (cheap
 * heuristic that covers most real-world repos); names with a `.` get
 * treated as files unless they're known dotfiles like `.github`.
 */
function looksLikeDirectory(entry: ProjectDirectoryEntry): boolean {
  if (entry.name.startsWith(".") && !entry.name.includes(".", 1)) return true;
  return !entry.name.includes(".");
}
