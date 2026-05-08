// Settings + Trusted-Mac management. Read-only surface for the connection state
// today; the only mutation is "forget this Mac", which mirrors what the iOS
// app exposes under Settings > Paired computers. Account login is read-only
// for the same reason as iOS — full OAuth handoff happens out-of-band.

import { useEffect, useRef, useState } from "react";
import { permissionLabel, requestPermission } from "../../lib/notifications";
import {
  applyStateBackup,
  buildStateBackup,
  defaultBackupFilename,
  downloadBackup,
} from "../../lib/state-backup";
import { useAccountStore } from "../../state/account-store";
import { useConnectionStore } from "../../state/connection-store";
import { useCustomSlashCommandsStore } from "../../state/custom-slash-commands-store";
import { useThemeStore } from "../../state/theme-store";
import {
  pairingStore,
  type TrustedMacRecord,
  type TrustedMacRegistry,
} from "../../storage/pairing-store";
import {
  prefsStore,
  type CustomSlashCommand,
  type NotificationsPreference,
  type ThemePreference,
} from "../../storage/prefs-store";

export function SettingsModal({ onClose }: { onClose(): void }) {
  const status = useConnectionStore((state) => state.status);
  const saved = useConnectionStore((state) => state.saved);
  const forgetCurrent = useConnectionStore((state) => state.forget);
  const account = useAccountStore((state) => state.snapshot);
  const refreshAccount = useAccountStore((state) => state.refresh);
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const [registry, setRegistry] = useState<TrustedMacRegistry | null>(null);

  useEffect(() => {
    void pairingStore.loadRegistry().then(setRegistry);
  }, []);

  useEffect(() => {
    if (status.kind === "open") void refreshAccount();
  }, [status.kind, refreshAccount]);

  const macs = registry ? Object.values(registry.records).sort((a, b) => b.lastUsedAt - a.lastUsedAt) : [];
  const currentMacDeviceId = saved?.macDeviceId;

  const [notificationsPref, setNotificationsPref] = useState<NotificationsPreference>("auto");
  const [permission, setPermission] = useState(permissionLabel());
  useEffect(() => {
    void prefsStore.loadNotifications().then(setNotificationsPref);
  }, []);
  async function pickNotifications(next: NotificationsPreference) {
    setNotificationsPref(next);
    await prefsStore.saveNotifications(next);
    // Asking for permission only when the user explicitly opts in keeps the
    // app from triggering the browser's "site wants to notify you" prompt
    // unsolicited at first load.
    if (next === "on" && permission === "default") {
      const result = await requestPermission();
      setPermission(result);
    }
  }

  async function forgetMac(record: TrustedMacRecord) {
    const next = await pairingStore.forgetTrustedMac(record.macDeviceId);
    setRegistry(next);
    if (record.macDeviceId === currentMacDeviceId) await forgetCurrent();
  }

  return (
    <div className="agnt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="agnt-modal agnt-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agnt-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="agnt-modal-header agnt-settings-header">
          <h2 id="agnt-settings-title">Settings</h2>
          <button type="button" className="agnt-button-ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <section className="agnt-settings-section">
          <h3>Appearance</h3>
          <div className="agnt-settings-row">
            <span>Theme</span>
            <div className="agnt-settings-segments" role="radiogroup" aria-label="Theme">
              {(["auto", "light", "dark"] as ThemePreference[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={theme === value}
                  className={"agnt-settings-segment" + (theme === value ? " agnt-settings-segment-active" : "")}
                  onClick={() => void setTheme(value)}
                >
                  {value === "auto" ? "Auto" : value === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="agnt-settings-section">
          <h3>Notifications</h3>
          <div className="agnt-settings-row">
            <span>Desktop alerts on turn completion</span>
            <div className="agnt-settings-segments" role="radiogroup" aria-label="Desktop notifications">
              {(["auto", "on", "off"] as NotificationsPreference[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={notificationsPref === value}
                  className={"agnt-settings-segment" + (notificationsPref === value ? " agnt-settings-segment-active" : "")}
                  onClick={() => void pickNotifications(value)}
                >
                  {value === "auto" ? "Auto" : value === "on" ? "On" : "Off"}
                </button>
              ))}
            </div>
          </div>
          <p className="agnt-settings-hint">
            {permission === "unsupported"
              ? "This browser doesn't support desktop notifications. The tab title will still flash."
              : permission === "denied"
                ? "You blocked notifications for this site in your browser. Re-enable them in site settings to allow desktop alerts."
                : permission === "granted"
                  ? "Permission granted. Notifications fire only while the agnt tab is hidden so you don't get duplicate signals."
                  : "Pick On to grant notification permission. Auto stays quiet until you opt in."}
          </p>
        </section>

        <section className="agnt-settings-section">
          <h3>Connection</h3>
          <dl className="agnt-settings-kv">
            <dt>Status</dt>
            <dd>{status.kind}</dd>
            {saved && (
              <>
                <dt>Relay</dt>
                <dd><code>{saved.relayUrl}</code></dd>
                <dt>Session</dt>
                <dd><code>{shortenId(saved.sessionId)}</code></dd>
                <dt>Mac</dt>
                <dd><code>{shortenId(saved.macDeviceId)}</code></dd>
              </>
            )}
          </dl>
        </section>

        <section className="agnt-settings-section">
          <h3>Account</h3>
          {!account ? (
            <p className="agnt-settings-hint">Connect to read account status.</p>
          ) : (
            <dl className="agnt-settings-kv">
              <dt>Provider</dt>
              <dd>{account.providerId ?? "unknown"}</dd>
              <dt>Logged in</dt>
              <dd>{account.loggedIn ? "yes" : "no"}</dd>
              {account.authMethod && (<><dt>Method</dt><dd>{account.authMethod}</dd></>)}
              {account.message && (<><dt>Note</dt><dd>{account.message}</dd></>)}
            </dl>
          )}
          {account?.loginUrl && (
            <a className="agnt-button-ghost" href={account.loginUrl} target="_blank" rel="noreferrer">
              Open login page
            </a>
          )}
        </section>

        <CustomSlashCommandsSection />

        <BackupRestoreSection />

        <section className="agnt-settings-section">
          <h3>Trusted Macs ({macs.length})</h3>
          {macs.length === 0 ? (
            <p className="agnt-settings-hint">Pair with a bridge to remember it here.</p>
          ) : (
            <ul className="agnt-settings-macs">
              {macs.map((mac) => (
                <li key={mac.macDeviceId} className="agnt-settings-mac">
                  <div className="agnt-settings-mac-meta">
                    <strong>{mac.displayName ?? "Mac"}{mac.macDeviceId === currentMacDeviceId ? " · current" : ""}</strong>
                    <span className="agnt-settings-mac-detail">
                      <code>{shortenId(mac.macDeviceId)}</code> @ <code>{mac.relayUrl}</code>
                    </span>
                    <span className="agnt-settings-mac-detail">
                      paired {formatRelative(mac.lastPairedAt)} · last used {formatRelative(mac.lastUsedAt)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="agnt-button-ghost agnt-button-danger"
                    onClick={() => void forgetMac(mac)}
                  >
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function CustomSlashCommandsSection() {
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

function BackupRestoreSection() {
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
      // Restored prefs only take effect on the next page load — zustand stores
      // hydrate from IndexedDB at boot. Tell the user explicitly so the UI
      // appearing unchanged isn't surprising.
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

function shortenId(value: string): string {
  return value.length > 16 ? value.slice(0, 8) + "…" + value.slice(-4) : value;
}

function formatRelative(timestamp: number): string {
  if (!timestamp) return "—";
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
