import { useEffect, useRef, useState } from "react";
import {
  buildDiagnosticReport,
  defaultDiagnosticFilename,
  downloadDiagnostic,
} from "../../lib/diagnostic-report";
import {
  applyStateBackup,
  buildStateBackup,
  defaultBackupFilename,
  downloadBackup,
} from "../../lib/state-backup";
import { useCustomSlashCommandsStore } from "../../state/custom-slash-commands-store";
import { prefsStore, type CustomSlashCommand, type TurnWebhookPreference } from "../../storage/prefs-store";

export function CustomSlashCommandsSection() {
  const commands = useCustomSlashCommandsStore((state) => state.commands);
  const addCommand = useCustomSlashCommandsStore((state) => state.addCommand);
  const updateCommand = useCustomSlashCommandsStore((state) => state.updateCommand);
  const removeCommand = useCustomSlashCommandsStore((state) => state.removeCommand);
  const [editing, setEditing] = useState<{ originalName: string | null; name: string; body: string }>({
    originalName: null,
    name: "",
    body: "",
  });
  const [error, setError] = useState<string | null>(null);

  function startNew() {
    setEditing({ originalName: null, name: "", body: "" });
    setError(null);
  }
  function startEdit(command: CustomSlashCommand) {
    setEditing({ originalName: command.name, name: command.name, body: command.body });
    setError(null);
  }
  function save() {
    const trimmed = { name: editing.name.trim(), body: editing.body };
    const result = editing.originalName
      ? updateCommand(editing.originalName, trimmed)
      : addCommand(trimmed);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setEditing({ originalName: null, name: "", body: "" });
    setError(null);
  }
  function cancel() {
    setEditing({ originalName: null, name: "", body: "" });
    setError(null);
  }

  return (
    <section className="agnt-settings-section">
      <h3>Custom slash commands ({commands.length})</h3>
      <p className="agnt-settings-hint">
        Type <code>/your-name</code> in the composer to drop the body in as a draft. Built-in commands always win on a name collision.
        Tokens expanded at run time: <code>{"{cwd}"}</code>, <code>{"{thread}"}</code>, <code>{"{selection}"}</code>, <code>{"{date}"}</code>, <code>{"{datetime}"}</code>, <code>{"{time}"}</code>.
      </p>
      {commands.length > 0 && (
        <ul className="agnt-settings-slash-list">
          {commands.map((command) => (
            <li key={command.name} className="agnt-settings-slash-row">
              <div className="agnt-settings-slash-meta">
                <code>/{command.name}</code>
                <span className="agnt-settings-slash-preview">{command.body}</span>
              </div>
              <div className="agnt-settings-slash-actions">
                <button type="button" className="agnt-button-ghost" onClick={() => startEdit(command)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="agnt-button-ghost agnt-button-danger"
                  onClick={() => removeCommand(command.name)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing.originalName !== null || editing.name || editing.body ? (
        <div className="agnt-settings-slash-edit">
          <label className="agnt-settings-slash-field">
            <span>Name</span>
            <input
              type="text"
              value={editing.name}
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              placeholder="debug-this"
              spellCheck={false}
            />
          </label>
          <label className="agnt-settings-slash-field">
            <span>Body</span>
            <textarea
              value={editing.body}
              onChange={(event) => setEditing({ ...editing, body: event.target.value })}
              placeholder="Walk the failing test and pinpoint the assertion that breaks…"
              rows={4}
            />
          </label>
          {error && <p className="agnt-settings-error">{error}</p>}
          <div className="agnt-settings-slash-actions">
            <button type="button" className="agnt-button-primary" onClick={save}>
              {editing.originalName ? "Update" : "Add"}
            </button>
            <button type="button" className="agnt-button-ghost" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="agnt-button-ghost" onClick={startNew}>
          + Add command
        </button>
      )}
    </section>
  );
}

export function BackupRestoreSection() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleExport() {
    setBusy(true);
    setFeedback(null);
    try {
      const backup = await buildStateBackup();
      const count = Object.keys(backup.kv).length;
      downloadBackup(backup, defaultBackupFilename());
      setFeedback({ kind: "ok", message: `Exported ${count} key${count === 1 ? "" : "s"}.` });
    } catch (error) {
      setFeedback({ kind: "error", message: (error as Error)?.message ?? "Export failed." });
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(file: File) {
    setBusy(true);
    setFeedback(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const result = await applyStateBackup(parsed);
      if (!result.ok) {
        setFeedback({ kind: "error", message: result.reason ?? "Import failed." });
        return;
      }
      setFeedback({
        kind: "ok",
        message: `Imported ${result.appliedCount} key${result.appliedCount === 1 ? "" : "s"}. Reload the page to see the restored state.`,
      });
    } catch (error) {
      setFeedback({ kind: "error", message: (error as Error)?.message ?? "Import failed." });
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <section className="agnt-settings-section">
      <h3>Backup &amp; restore</h3>
      <p className="agnt-settings-hint">
        Export preferences (theme, sidebar layout, pinned threads, bookmarks, custom slash commands, thread colors) and the
        local thread message cache as a JSON file. Identity keys and pairing state are intentionally <strong>not</strong> included —
        re-pair the bridge in a fresh browser instead. Importing overwrites matching keys; reload the page to see the restored UI.
      </p>
      <div className="agnt-settings-backup-actions">
        <button type="button" className="agnt-button-ghost" onClick={() => void handleExport()} disabled={busy}>
          Export backup
        </button>
        <button
          type="button"
          className="agnt-button-ghost"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
        >
          Import backup…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleImport(file);
          }}
        />
      </div>
      {feedback && (
        <p className={feedback.kind === "ok" ? "agnt-settings-hint" : "agnt-settings-error"}>{feedback.message}</p>
      )}
    </section>
  );
}

export function TurnWebhookSection() {
  const [pref, setPref] = useState<TurnWebhookPreference>({ url: "", enabled: false });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void prefsStore.loadTurnWebhook().then(setPref);
  }, []);

  async function patch(next: TurnWebhookPreference) {
    setPref(next);
    await prefsStore.saveTurnWebhook(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  }

  const urlInvalid = pref.url.trim().length > 0 && !/^https?:\/\//i.test(pref.url.trim());

  return (
    <section className="agnt-settings-section">
      <h3>Turn-completion webhook</h3>
      <p className="agnt-settings-hint">
        POST a JSON payload to this URL whenever a turn lands (`completed` or `failed`). Useful for Slack pings,
        local automation, or ad-hoc logging. The payload includes the outcome, threadId, turnId, and timestamp —
        but <strong>no message text</strong>, since sending model output to a third-party URL would be a data leak.
      </p>
      <div className="agnt-settings-row">
        <label className="agnt-settings-row-label" htmlFor="agnt-webhook-url">URL</label>
        <input
          id="agnt-webhook-url"
          type="url"
          inputMode="url"
          spellCheck={false}
          value={pref.url}
          placeholder="https://hooks.example/agnt"
          className={"agnt-settings-input" + (urlInvalid ? " agnt-settings-input-error" : "")}
          onChange={(event) => void patch({ ...pref, url: event.target.value })}
        />
      </div>
      <div className="agnt-settings-row">
        <label className="agnt-settings-row-label" htmlFor="agnt-webhook-enabled">Enabled</label>
        <input
          id="agnt-webhook-enabled"
          type="checkbox"
          checked={pref.enabled}
          disabled={!pref.url.trim() || urlInvalid}
          onChange={(event) => void patch({ ...pref, enabled: event.target.checked })}
        />
      </div>
      {urlInvalid && <p className="agnt-settings-error">URL must start with http:// or https://.</p>}
      {saved && <p className="agnt-settings-hint">Saved.</p>}
    </section>
  );
}

export function DiagnosticSection() {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function exportReport() {
    setBusy(true);
    setFeedback(null);
    try {
      const report = await buildDiagnosticReport();
      downloadDiagnostic(report, defaultDiagnosticFilename());
      setFeedback(`Exported ${report.storage.totalKeys} key${report.storage.totalKeys === 1 ? "" : "s"} of context.`);
    } catch (error) {
      setFeedback((error as Error)?.message ?? "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="agnt-settings-section">
      <h3>Diagnostic report</h3>
      <p className="agnt-settings-hint">
        Download a JSON snapshot of the session: connection state, latency stats, recent notice titles, IndexedDB
        key counts, and browser info. Pairing identifiers are hashed; thread contents and identity keys are
        excluded. Attach the file when filing a bug report.
      </p>
      <div className="agnt-settings-backup-actions">
        <button type="button" className="agnt-button-ghost" onClick={() => void exportReport()} disabled={busy}>
          Export diagnostic
        </button>
      </div>
      {feedback && <p className="agnt-settings-hint">{feedback}</p>}
    </section>
  );
}
