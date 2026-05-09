// Modal folder picker. Two columns: quick locations on the left, browse +
// search on the right. Single-click selects a folder; double-click drills
// into it. Submitting passes the selected path to the caller through a
// callback (so the same picker can drive "New Chat" and other flows later).

import { useEffect, useState } from "react";
import { useConnectionStore } from "../../state/connection-store";
import { useProjectStore } from "../../state/project-store";
import { Xmark } from "../shared/Icon";
import { Sheet } from "../shared/Sheet";

interface ProjectPickerProps {
  onPick(path: string): void;
  onCancel(): void;
}

export function ProjectPicker({ onPick, onCancel }: ProjectPickerProps) {
  const open = useProjectStore((state) => state.open);
  const loading = useProjectStore((state) => state.loading);
  const error = useProjectStore((state) => state.error);
  const quickLocations = useProjectStore((state) => state.quickLocations);
  const currentPath = useProjectStore((state) => state.currentPath);
  const parentPath = useProjectStore((state) => state.parentPath);
  const entries = useProjectStore((state) => state.entries);
  const query = useProjectStore((state) => state.query);
  const selectedPath = useProjectStore((state) => state.selectedPath);
  const navigate = useProjectStore((state) => state.navigate);
  const ascend = useProjectStore((state) => state.ascend);
  const setQuery = useProjectStore((state) => state.setQuery);
  const select = useProjectStore((state) => state.select);
  const hide = useProjectStore((state) => state.hide);
  const connection = useConnectionStore((state) => state.connection);

  const [hoveredQuickId, setHoveredQuickId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hide();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, hide, onCancel]);

  if (!open) return null;
  const rpc = connection?.rpc;
  if (!rpc) return null;

  const submit = () => {
    const path = selectedPath ?? currentPath;
    if (!path) return;
    hide();
    onPick(path);
  };

  function dismiss() {
    hide();
    onCancel();
  }

  return (
    <Sheet open onClose={dismiss} ariaLabel="Pick a project folder" maxWidth={720}>
      <div className="agnt-project-modal">
        <header className="agnt-modal-header agnt-settings-header">
          <h2 id="agnt-project-title">Pick a project folder</h2>
          <button
            type="button"
            className="agnt-button-ghost"
            onClick={dismiss}
            aria-label="Close"
          >
            <Xmark />
          </button>
        </header>

        <div className="agnt-project-body">
          <aside className="agnt-project-quick">
            <div className="agnt-row-tag">Quick</div>
            {quickLocations.length === 0 ? (
              <div className="agnt-settings-hint">No quick locations.</div>
            ) : (
              <ul className="agnt-project-quick-list">
                {quickLocations.map((location) => {
                  const active = location.path === currentPath;
                  return (
                    <li key={location.id}>
                      <button
                        type="button"
                        className={
                          "agnt-project-quick-item" +
                          (active ? " agnt-project-quick-item-active" : "") +
                          (hoveredQuickId === location.id ? " agnt-project-quick-item-hover" : "")
                        }
                        onPointerEnter={() => setHoveredQuickId(location.id)}
                        onPointerLeave={() => setHoveredQuickId(null)}
                        onClick={() => void navigate(rpc, location.path)}
                      >
                        <span>{location.label}</span>
                        <code>{location.path}</code>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          <section className="agnt-project-browse">
            <div className="agnt-project-toolbar">
              <button
                type="button"
                className="agnt-button-ghost"
                onClick={() => void ascend(rpc)}
                disabled={!parentPath || loading}
                title={parentPath ? `Up to ${parentPath}` : "No parent within allowed roots"}
              >
                ↑ Up
              </button>
              <code className="agnt-project-current-path">{currentPath ?? "—"}</code>
              <input
                type="search"
                placeholder="Search…"
                className="agnt-project-search"
                value={query}
                onChange={(event) => setQuery(rpc, event.target.value)}
              />
            </div>

            {error && <div className="agnt-project-error">{error}</div>}

            {loading && entries.length === 0 ? (
              <div className="agnt-settings-hint">Loading…</div>
            ) : entries.length === 0 ? (
              <div className="agnt-settings-hint">{query ? "No matches." : "Empty folder."}</div>
            ) : (
              <ul className="agnt-project-entries">
                {entries.map((entry) => {
                  const isSelected = entry.path === selectedPath;
                  return (
                    <li key={entry.path}>
                      <button
                        type="button"
                        className={"agnt-project-entry" + (isSelected ? " agnt-project-entry-selected" : "")}
                        onClick={() => select(entry.path)}
                        onDoubleClick={() => void navigate(rpc, entry.path)}
                        title={entry.path}
                      >
                        <span className="agnt-project-entry-glyph" aria-hidden>
                          📁
                        </span>
                        <span className="agnt-project-entry-name">{entry.name}</span>
                        {entry.isSymlink && <span className="agnt-row-tag">symlink</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <footer className="agnt-modal-footer">
          <button
            type="button"
            className="agnt-button-ghost"
            onClick={() => {
              hide();
              onCancel();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="agnt-button-primary"
            onClick={submit}
            disabled={!(selectedPath ?? currentPath)}
            title={selectedPath ? `Use ${selectedPath}` : currentPath ? `Use ${currentPath}` : "Pick a folder"}
          >
            Use {selectedPath ? "selected" : "this folder"}
          </button>
        </footer>
      </div>
    </Sheet>
  );
}
