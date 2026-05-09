// Modal that previews + applies a per-turn checkpoint restore. Walks the user
// through the bridge's safety checks: affected files, staged-files warning,
// untracked-files warning, then a destructive confirm that calls
// workspace/checkpointRestoreApply with confirmDestructiveRestore=true.
//
// Mounted from Workspace; opened by AssistantRow's per-turn revert button.

import { useConnectionStore } from "../../state/connection-store";
import { useCheckpointsStore } from "../../state/checkpoints-store";
import { useNoticesStore } from "../../state/notices-store";
import { Sheet } from "../shared/Sheet";

export function RevertSheet() {
  const open = useCheckpointsStore((state) => state.open);
  const preview = useCheckpointsStore((state) => state.preview);
  const loading = useCheckpointsStore((state) => state.loading);
  const applying = useCheckpointsStore((state) => state.applying);
  const error = useCheckpointsStore((state) => state.error);
  const target = useCheckpointsStore((state) => state.target);
  const apply = useCheckpointsStore((state) => state.apply);
  const hide = useCheckpointsStore((state) => state.hide);
  const connection = useConnectionStore((state) => state.connection);
  const enqueueNotice = useNoticesStore((state) => state.enqueue);

  if (!open || !target) return null;
  const rpc = connection?.rpc;
  if (!rpc) return null;

  const stagedBlocking = (preview?.stagedFiles?.length ?? 0) > 0;

  async function onApply() {
    if (!rpc) return;
    const success = await apply(rpc);
    if (success) {
      enqueueNotice({
        severity: "info",
        title: "Workspace restored",
        message: `${preview?.affectedFiles.length ?? 0} file(s) reverted to the checkpoint.`,
      });
    }
  }

  return (
    <Sheet
      open
      // The Cancel button is the user-visible escape; this onClose only fires
      // from Esc since closable=false disables drag + backdrop dismissal.
      // Esc-to-cancel is intentional — destructive operations should always
      // honor a baseline keyboard escape.
      onClose={() => { if (!applying) hide(); }}
      ariaLabel="Revert workspace"
      presentation="alert"
      closable={false}
      maxWidth={620}
    >
      <div className="agnt-revert-modal">
        <header className="agnt-modal-header">
          <span className="agnt-row-tag">Revert turn</span>
          <h2 id="agnt-revert-title">Roll the workspace back to before this turn?</h2>
        </header>

        <section className="agnt-modal-body">
          {loading && <p className="agnt-settings-hint">Loading checkpoint preview…</p>}
          {error && <div className="agnt-revert-error">{error}</div>}
          {preview && !error && (
            <>
              <p className="agnt-settings-hint">
                Restoring will overwrite the working tree with the checkpoint at <code>{shortCommit(preview.commit)}</code>.
                The bridge captures a backup checkpoint before applying so you can undo it later.
              </p>

              {preview.affectedFiles.length === 0 ? (
                <p className="agnt-settings-hint">No files differ from the checkpoint — nothing to revert.</p>
              ) : (
                <div className="agnt-revert-section">
                  <strong>Affected files ({preview.affectedFiles.length})</strong>
                  <ul className="agnt-revert-files">
                    {preview.affectedFiles.map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {stagedBlocking && (
                <div className="agnt-revert-warn">
                  <strong>Staged changes will be discarded.</strong>
                  <ul className="agnt-revert-files">
                    {preview.stagedFiles.map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.untrackedFiles.length > 0 && (
                <div className="agnt-revert-warn">
                  <strong>Untracked files will be removed.</strong>
                  <ul className="agnt-revert-files">
                    {preview.untrackedFiles.map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>

        <footer className="agnt-modal-footer">
          <button type="button" className="agnt-button-ghost" onClick={hide} disabled={applying}>
            Cancel
          </button>
          <button
            type="button"
            className="agnt-button-primary agnt-button-danger"
            onClick={onApply}
            disabled={
              applying || loading || !preview?.canRestore || preview.affectedFiles.length === 0
            }
            title={
              !preview?.canRestore
                ? "Bridge can't restore this checkpoint"
                : preview.affectedFiles.length === 0
                  ? "Nothing to revert"
                  : applying
                    ? "Restoring…"
                    : "Restore the workspace"
            }
          >
            {applying ? "Restoring…" : "Restore workspace"}
          </button>
        </footer>
      </div>
    </Sheet>
  );
}

function shortCommit(commit: string): string {
  return commit.length > 12 ? commit.slice(0, 8) : commit;
}
