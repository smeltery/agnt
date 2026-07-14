import { invoke } from "@tauri-apps/api/core";
import type { RefObject } from "react";
import type {
  AppConfig,
  AppStatus,
  DiagnosticAction,
  DiagnosticsSnapshot,
  LogEntry,
  NetworkInterface,
  ProviderBridgeStatus,
  ProviderKeyStatus,
  UpdateInfo,
  View,
} from "./host-types";
import { DashboardView } from "./DashboardView";
import { DiagnosticsView } from "./DiagnosticsView";
import { LogsView } from "./LogsView";
import { NetworkView } from "./NetworkView";
import { SettingsView } from "./SettingsView";
import { ActionBtn } from "./ui-components";

export function AppViews({
  view,
  firstRun,
  status,
  pairingPayload,
  pairingCode,
  phoneConnected,
  isStopped,
  starting,
  tauriReady,
  networks,
  logs,
  logsEndRef,
  settings,
  settingsPort,
  portStatus,
  updateInfo,
  updateStatus,
  providerBridgeStatus,
  providerKeyStatus,
  providerApiKeyInput,
  providerBridgeBusy,
  diagnostics,
  diagnosticsLoading,
  setStatus,
  setFirstRun,
  setSettings,
  setProviderApiKeyInput,
  setView,
  onLoadNetworks,
  onCopyUrl,
  onCopyPairingCode,
  onStartAll,
  onStopAll,
  onRestartBridge,
  onRestartRelay,
  onSelectNetwork,
  onClearLogs,
  onCheckPort,
  onCheckForUpdate,
  onInstallUpdate,
  onToggleProviderBridge,
  onSaveProviderApiKey,
  onClearProviderApiKey,
  onSaveSettings,
  onDiagnostics,
  onDiagnosticAction,
}: {
  view: View;
  firstRun: boolean;
  status: AppStatus;
  pairingPayload: string | null;
  pairingCode: string | null;
  phoneConnected: boolean;
  isStopped: boolean;
  starting: boolean;
  tauriReady: boolean;
  networks: NetworkInterface[];
  logs: LogEntry[];
  logsEndRef: RefObject<HTMLDivElement | null>;
  settings: AppConfig;
  settingsPort: string;
  portStatus: "checking" | "available" | "taken";
  updateInfo: UpdateInfo | null;
  updateStatus: "idle" | "checking" | "installing";
  providerBridgeStatus: ProviderBridgeStatus;
  providerKeyStatus: ProviderKeyStatus;
  providerApiKeyInput: string;
  providerBridgeBusy: boolean;
  diagnostics: DiagnosticsSnapshot | null;
  diagnosticsLoading: boolean;
  setStatus(value: AppStatus | ((prev: AppStatus) => AppStatus)): void;
  setFirstRun(value: boolean): void;
  setSettings(value: AppConfig | ((prev: AppConfig) => AppConfig)): void;
  setProviderApiKeyInput(value: string): void;
  setView(value: View): void;
  onLoadNetworks(): void;
  onCopyUrl(): void;
  onCopyPairingCode(): void;
  onStartAll(): void;
  onStopAll(): void;
  onRestartBridge(): void;
  onRestartRelay(): void;
  onSelectNetwork(ip: string): void;
  onClearLogs(): void;
  onCheckPort(port: string): void;
  onCheckForUpdate(): void;
  onInstallUpdate(): void;
  onToggleProviderBridge(): void;
  onSaveProviderApiKey(): void;
  onClearProviderApiKey(): void;
  onSaveSettings(): void;
  onDiagnostics(): void;
  onDiagnosticAction(action: DiagnosticAction | null): void;
}) {
  return (
    <>
      {firstRun && (
        <div
          style={{
            flex: 1,
            background: "var(--bg-surface)",
            borderRadius: "7px",
            border: "1px solid var(--border-color)",
            padding: "16px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            gap: "16px",
          }}
        >
          <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-primary)" }}>
            Welcome to Agnt Host
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", maxWidth: "300px" }}>
            This app lets you pair your phone with your PC to use Agnt without terminals.
            Let's get your local relay and bridge running.
          </div>
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <ActionBtn
              label="Let's Go"
              color="#35C759"
              onClick={async () => {
                setFirstRun(false);
                await invoke("complete_setup");
                onLoadNetworks();
              }}
            />
          </div>
        </div>
      )}

      {view === "dashboard" && (
        <DashboardView
          status={status}
          pairingPayload={pairingPayload}
          pairingCode={pairingCode}
          phoneConnected={phoneConnected}
          isStopped={isStopped}
          starting={starting}
          tauriReady={tauriReady}
          setStatus={setStatus}
          onLoadNetworks={onLoadNetworks}
          onCopyUrl={onCopyUrl}
          onCopyPairingCode={onCopyPairingCode}
          onStartAll={onStartAll}
          onStopAll={onStopAll}
          onRestartBridge={onRestartBridge}
          onRestartRelay={onRestartRelay}
        />
      )}

      {view === "network" && (
        <NetworkView networks={networks} status={status} setView={setView} onSelectNetwork={onSelectNetwork} />
      )}

      {view === "logs" && (
        <LogsView logs={logs} logsEndRef={logsEndRef} setView={setView} onClearLogs={onClearLogs} />
      )}

      {view === "settings" && (
        <SettingsView
          settings={settings}
          setSettings={setSettings}
          settingsPort={settingsPort}
          portStatus={portStatus}
          tauriReady={tauriReady}
          updateInfo={updateInfo}
          updateStatus={updateStatus}
          providerBridgeStatus={providerBridgeStatus}
          providerKeyStatus={providerKeyStatus}
          providerApiKeyInput={providerApiKeyInput}
          providerBridgeBusy={providerBridgeBusy}
          setProviderApiKeyInput={setProviderApiKeyInput}
          setView={setView}
          onCheckPort={onCheckPort}
          onCheckForUpdate={onCheckForUpdate}
          onInstallUpdate={onInstallUpdate}
          onToggleProviderBridge={onToggleProviderBridge}
          onSaveProviderApiKey={onSaveProviderApiKey}
          onClearProviderApiKey={onClearProviderApiKey}
          onSaveSettings={onSaveSettings}
        />
      )}

      {view === "diagnostics" && (
        <DiagnosticsView
          diagnostics={diagnostics}
          diagnosticsLoading={diagnosticsLoading}
          tauriReady={tauriReady}
          onRefresh={onDiagnostics}
          onAction={onDiagnosticAction}
        />
      )}
    </>
  );
}
