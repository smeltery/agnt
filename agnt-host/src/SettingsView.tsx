import type {
  AppConfig,
  ProviderBridgeStatus,
  ProviderKeyStatus,
  UpdateInfo,
  View,
} from "./host-types";
import { ActionBtn } from "./ui-components";

export function SettingsView({
  settings,
  setSettings,
  settingsPort,
  portStatus,
  tauriReady,
  updateInfo,
  updateStatus,
  providerBridgeStatus,
  providerKeyStatus,
  providerApiKeyInput,
  providerBridgeBusy,
  setProviderApiKeyInput,
  setView,
  onCheckPort,
  onCheckForUpdate,
  onInstallUpdate,
  onToggleProviderBridge,
  onSaveProviderApiKey,
  onClearProviderApiKey,
  onSaveSettings,
}: {
  settings: AppConfig;
  setSettings: (settings: AppConfig) => void;
  settingsPort: string;
  portStatus: "checking" | "available" | "taken";
  tauriReady: boolean;
  updateInfo: UpdateInfo | null;
  updateStatus: "idle" | "checking" | "installing";
  providerBridgeStatus: ProviderBridgeStatus;
  providerKeyStatus: ProviderKeyStatus;
  providerApiKeyInput: string;
  providerBridgeBusy: boolean;
  setProviderApiKeyInput: (value: string) => void;
  setView: (view: View) => void;
  onCheckPort: (port: string) => void;
  onCheckForUpdate: () => void;
  onInstallUpdate: () => void;
  onToggleProviderBridge: () => void;
  onSaveProviderApiKey: () => void;
  onClearProviderApiKey: () => void;
  onSaveSettings: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        background: "var(--bg-surface)",
        borderRadius: "7px",
        border: "1px solid var(--border-color)",
        padding: "12px",
        overflow: "auto",
      }}
    >
      <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "12px" }}>
        Settings
      </div>

      <div style={{ marginBottom: "12px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>
          Relay Port
        </label>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <input
            type="number"
            value={settingsPort}
            onChange={(e) => onCheckPort(e.target.value)}
            style={{
              flex: 1,
              padding: "6px 8px",
              fontSize: "11px",
              fontFamily: "monospace",
              background: "var(--bg-primary)",
              border: `1px solid ${portStatus === "taken" ? "#FF5C5C" : "var(--border-color)"}`,
              borderRadius: "4px",
              color: "var(--text-primary)",
              outline: "none",
            }}
          />
          <span style={{
            fontSize: "10px",
            color: portStatus === "checking" ? "var(--warning-amber)"
              : portStatus === "available" ? "var(--success-green)"
              : "#FF5C5C",
            minWidth: "60px",
          }}>
            {portStatus === "checking" ? "..." : portStatus === "available" ? "free" : "taken"}
          </span>
        </div>
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "12px",
          cursor: "pointer",
          fontSize: "11px",
          color: "var(--text-secondary)",
        }}
      >
        <input
          type="checkbox"
          checked={settings.auto_restart}
          onChange={(e) => setSettings({ ...settings, auto_restart: e.target.checked })}
          style={{ accentColor: "var(--accent-blue)" }}
        />
        Auto-restart crashed processes
      </label>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "12px",
          cursor: "pointer",
          fontSize: "11px",
          color: "var(--text-secondary)",
        }}
      >
        <input
          type="checkbox"
          checked={settings.start_minimized}
          onChange={(e) => setSettings({ ...settings, start_minimized: e.target.checked })}
          style={{ accentColor: "var(--accent-blue)" }}
        />
        Start minimized to tray
      </label>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "12px",
          cursor: "pointer",
          fontSize: "11px",
          color: "var(--text-secondary)",
        }}
      >
        <input
          type="checkbox"
          checked={settings.launch_at_startup}
          onChange={(e) => setSettings({ ...settings, launch_at_startup: e.target.checked })}
          style={{ accentColor: "var(--accent-blue)" }}
        />
        Launch at Windows startup
      </label>

      <div style={{ marginBottom: "10px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>
          Custom Relay URL
        </label>
        <input
          type="text"
          value={settings.remote_relay_url || ""}
          onChange={(e) => setSettings({ ...settings, remote_relay_url: e.target.value })}
          placeholder="ws://127.0.0.1:9000"
          style={{
            width: "100%",
            padding: "6px 8px",
            fontSize: "10px",
            fontFamily: "monospace",
            background: "var(--bg-primary)",
            border: "1px solid var(--border-color)",
            borderRadius: "4px",
            color: "var(--text-primary)",
            outline: "none",
          }}
        />
      </div>

      <div style={{ marginBottom: "10px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>
          Relay path (custom)
        </label>
        <input
          type="text"
          value={settings.relay_path || ""}
          onChange={(e) => setSettings({ ...settings, relay_path: e.target.value || null })}
          placeholder="default (auto-detect)"
          style={{
            width: "100%",
            padding: "6px 8px",
            fontSize: "10px",
            fontFamily: "monospace",
            background: "var(--bg-primary)",
            border: "1px solid var(--border-color)",
            borderRadius: "4px",
            color: "var(--text-primary)",
            outline: "none",
          }}
        />
      </div>

      <div style={{ marginBottom: "12px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>
          Bridge path (custom)
        </label>
        <input
          type="text"
          value={settings.bridge_path || ""}
          onChange={(e) => setSettings({ ...settings, bridge_path: e.target.value || null })}
          placeholder="default (auto-detect)"
          style={{
            width: "100%",
            padding: "6px 8px",
            fontSize: "10px",
            fontFamily: "monospace",
            background: "var(--bg-primary)",
            border: "1px solid var(--border-color)",
            borderRadius: "4px",
            color: "var(--text-primary)",
            outline: "none",
          }}
        />
      </div>

      <div
        style={{
          marginBottom: "12px",
          padding: "10px",
          background: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          borderRadius: "6px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <div>
            <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-primary)" }}>
              Updates
            </div>
            <div style={{ fontSize: "10px", color: "var(--text-secondary)", marginTop: "3px" }}>
              {updateInfo
                ? `Version ${updateInfo.version} available`
                : updateStatus === "checking"
                  ? "Checking..."
                  : "No pending update"}
            </div>
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            <ActionBtn
              label={updateStatus === "checking" ? "Checking..." : "Check"}
              color="#4F8CFF"
              onClick={onCheckForUpdate}
              disabled={!tauriReady || updateStatus !== "idle"}
            />
            <ActionBtn
              label={updateStatus === "installing" ? "Installing..." : "Install"}
              color="#35C759"
              onClick={onInstallUpdate}
              disabled={!updateInfo || !tauriReady || updateStatus !== "idle"}
            />
          </div>
        </div>
      </div>

      <div
        style={{
          marginBottom: "12px",
          padding: "10px",
          background: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          borderRadius: "6px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <div>
            <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-primary)" }}>
              Provider bridge
            </div>
            <div style={{ fontSize: "10px", color: "var(--text-secondary)", marginTop: "3px" }}>
              {providerBridgeStatus.running
                ? `Running · ${providerBridgeStatus.base_url}`
                : "Stopped"}
              {" · "}
              {providerBridgeStatus.provider}
            </div>
          </div>
          <ActionBtn
            label={providerBridgeBusy ? "..." : providerBridgeStatus.running ? "Stop" : "Start"}
            color={providerBridgeStatus.running ? "#FF5C5C" : "#35C759"}
            onClick={onToggleProviderBridge}
            disabled={
              !tauriReady ||
              providerBridgeBusy ||
              (!providerKeyStatus.available && !providerBridgeStatus.running)
            }
          />
        </div>
        <div style={{ marginTop: "8px" }}>
          <label style={{ fontSize: "11px", color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}>
            API key ({providerKeyStatus.source})
          </label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input
              type="password"
              value={providerApiKeyInput}
              onChange={(e) => setProviderApiKeyInput(e.target.value)}
              placeholder={providerKeyStatus.has_stored_key ? "•••• stored" : "paste API key"}
              style={{
                flex: 1,
                padding: "6px 8px",
                fontSize: "10px",
                fontFamily: "monospace",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-color)",
                borderRadius: "4px",
                color: "var(--text-primary)",
                outline: "none",
              }}
            />
            <ActionBtn
              label="Save"
              color="#4F8CFF"
              onClick={onSaveProviderApiKey}
              disabled={!tauriReady || !providerApiKeyInput.trim()}
            />
            <ActionBtn
              label="Clear"
              color="#9AA4B2"
              onClick={onClearProviderApiKey}
              disabled={!tauriReady || !providerKeyStatus.has_stored_key}
            />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "6px" }}>
        <ActionBtn label="Save" color="#35C759" onClick={onSaveSettings} />
        <ActionBtn label="Cancel" color="#9AA4B2" onClick={() => setView("dashboard")} />
      </div>
    </div>
  );
}
