import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import QRCode from "qrcode";
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
import {
  DEFAULT_CONFIG,
  DEFAULT_PROVIDER_BRIDGE_STATUS,
  DEFAULT_PROVIDER_KEY_STATUS,
  DEFAULT_STATUS,
} from "./host-defaults";
import { AppShell } from "./AppShell";
import { AppViews } from "./AppViews";
import { useHostEvents } from "./useHostEvents";
import { useTauriReady } from "./useTauriReady";

function App() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [appState, setAppState] = useState("stopped");
  const [status, setStatus] = useState<AppStatus>(DEFAULT_STATUS);
  const [networks, setNetworks] = useState<NetworkInterface[]>([]);
  const [pairingPayload, setPairingPayload] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [starting, setStarting] = useState(false);
  const tauriReady = useTauriReady();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [phoneConnected, setPhoneConnected] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const [firewallWarning, setFirewallWarning] = useState<{ ip: string; port: number; message: string } | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "installing">("idle");
  const [settings, setSettings] = useState<AppConfig>(DEFAULT_CONFIG);
  const [settingsPort, setSettingsPort] = useState("9000");
  const [portStatus, setPortStatus] = useState<"checking" | "available" | "taken">("available");
  const [providerBridgeStatus, setProviderBridgeStatus] = useState<ProviderBridgeStatus>(DEFAULT_PROVIDER_BRIDGE_STATUS);
  const [providerKeyStatus, setProviderKeyStatus] = useState<ProviderKeyStatus>(DEFAULT_PROVIDER_KEY_STATUS);
  const [providerApiKeyInput, setProviderApiKeyInput] = useState("");
  const [providerBridgeBusy, setProviderBridgeBusy] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const logError = useCallback((msg: string) => {
    console.error("[AgntHost]", msg);
    setErrorMsg(msg);
    setTimeout(() => setErrorMsg(null), 10000);
  }, []);

  const addLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev.slice(-499), entry]);
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!tauriReady) return;
    try {
      const s = await invoke<AppStatus>("get_status");
      setStatus(s);
      setAppState(s.state);
      setPhoneConnected(s.phone_connected);
      if (s.pairing_payload) {
        setPairingPayload(s.pairing_payload);
      }
      if (s.pairing_code) {
        setPairingCode(s.pairing_code);
      }
    } catch {
      return;
    }
  }, [tauriReady]);

  const refreshProviderBridgeStatus = useCallback(async () => {
    if (!tauriReady) return;
    try {
      const [bridge, key] = await Promise.all([
        invoke<ProviderBridgeStatus>("get_provider_bridge_status"),
        invoke<ProviderKeyStatus>("get_provider_bridge_key_status"),
      ]);
      setProviderBridgeStatus(bridge);
      setProviderKeyStatus(key);
    } catch {
      return;
    }
  }, [tauriReady]);

  const handleToggleProviderBridge = useCallback(async () => {
    if (!tauriReady || providerBridgeBusy) return;
    setProviderBridgeBusy(true);
    try {
      const next = providerBridgeStatus.running
        ? await invoke<ProviderBridgeStatus>("stop_provider_bridge")
        : await invoke<ProviderBridgeStatus>("start_provider_bridge");
      setProviderBridgeStatus(next);
      await refreshProviderBridgeStatus();
    } catch (e) {
      logError(`Provider bridge ${providerBridgeStatus.running ? "stop" : "start"} failed: ${e}`);
    } finally {
      setProviderBridgeBusy(false);
    }
  }, [tauriReady, providerBridgeBusy, providerBridgeStatus.running, refreshProviderBridgeStatus, logError]);

  const handleSaveProviderApiKey = useCallback(async () => {
    if (!tauriReady) return;
    try {
      const next = await invoke<ProviderKeyStatus>("set_provider_bridge_api_key", {
        key: providerApiKeyInput,
      });
      setProviderKeyStatus(next);
      setProviderApiKeyInput("");
    } catch (e) {
      logError(`Provider bridge key save failed: ${e}`);
    }
  }, [tauriReady, providerApiKeyInput, logError]);

  const handleClearProviderApiKey = useCallback(async () => {
    if (!tauriReady) return;
    try {
      const next = await invoke<ProviderKeyStatus>("set_provider_bridge_api_key", {
        key: null,
      });
      setProviderKeyStatus(next);
      setProviderApiKeyInput("");
    } catch (e) {
      logError(`Provider bridge key clear failed: ${e}`);
    }
  }, [tauriReady, logError]);

  // Load settings when Tauri is ready
  useEffect(() => {
    if (!tauriReady) return;
    invoke<AppConfig>("get_config").then((cfg) => {
      setSettings(cfg);
      setSettingsPort(String(cfg.relay_port));
      if (!cfg.setup_completed) {
        setFirstRun(true);
      }
    }).catch(() => {});
  }, [tauriReady]);

  // Refresh provider-bridge state once Tauri is ready
  useEffect(() => {
    if (!tauriReady) return;
    const id = window.setTimeout(() => {
      refreshProviderBridgeStatus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [tauriReady, refreshProviderBridgeStatus]);
  useHostEvents({
    tauriReady,
    addLog,
    refreshStatus,
    setAppState,
    setErrorMsg,
    setFirewallWarning,
    setFirstRun,
    setPairingCode,
    setPairingPayload,
    setPhoneConnected,
    setStatus,
    setView,
  });

  // Scroll logs to bottom
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    if (!pairingPayload) return;
    const canvas = document.getElementById("qr-canvas") as HTMLCanvasElement | null;
    if (!canvas) return;
    QRCode.toCanvas(canvas, pairingPayload, { width: 200, margin: 1 }).catch(() => {});
  }, [pairingPayload, view]);

  // Poll status periodically
  useEffect(() => {
    if (!tauriReady) return;

    const initialRefresh = window.setTimeout(() => {
      refreshStatus();
    }, 0);
    const interval = setInterval(refreshStatus, 3000);
    return () => {
      window.clearTimeout(initialRefresh);
      clearInterval(interval);
    };
  }, [tauriReady, refreshStatus]);

  const handleStartAll = async () => {
    if (!tauriReady) return;
    setStarting(true);
    setAppState("starting");
    try {
      await invoke<string>("start_all");
    } catch (e) {
      logError(`Start failed: ${e}`);
      addLog({
        timestamp: new Date().toLocaleTimeString(),
        source: "app",
        level: "error",
        message: `Start failed: ${e}`,
      });
      setAppState("error");
    }
    setStarting(false);
  };

  const handleStopAll = async () => {
    if (!tauriReady) return;
    try {
      await invoke<string>("stop_bridge");
      if (status.relay_mode !== "remote") {
        await invoke<string>("stop_relay");
      }
      setAppState("stopped");
      setPairingPayload(null);
      setPhoneConnected(false);
    } catch (e) {
      addLog({
        timestamp: new Date().toLocaleTimeString(),
        source: "app",
        level: "error",
        message: `Stop failed: ${e}`,
      });
    }
  };

  const handleRestartBridge = async () => {
    if (!tauriReady) return;
    try {
      await invoke("stop_bridge");
      await new Promise((r) => setTimeout(r, 500));
      await invoke<string>("start_bridge");
    } catch (e) {
      addLog({
        timestamp: new Date().toLocaleTimeString(),
        source: "app",
        level: "error",
        message: `Restart bridge failed: ${e}`,
      });
    }
  };

  const handleRestartRelay = async () => {
    if (!tauriReady) return;
    try {
      await invoke("stop_relay");
      await new Promise((r) => setTimeout(r, 500));
      await invoke<string>("start_relay");
    } catch (e) {
      addLog({
        timestamp: new Date().toLocaleTimeString(),
        source: "app",
        level: "error",
        message: `Restart relay failed: ${e}`,
      });
    }
  };

  const handleLoadNetworks = async () => {
    if (!tauriReady) return;
    try {
      const nics = await invoke<NetworkInterface[]>("detect_networks");
      setNetworks(nics);
      setView("network");
    } catch (e) {
      addLog({
        timestamp: new Date().toLocaleTimeString(),
        source: "app",
        level: "error",
        message: `Network detection failed: ${e}`,
      });
    }
  };

  const handleSelectNetwork = async (ip: string) => {
    if (!tauriReady) return;
    try {
      await invoke("select_network", { ip });
      setStatus((prev) => ({ ...prev, network: ip }));
      addLog({
        timestamp: new Date().toLocaleTimeString(),
        source: "app",
        level: "info",
        message: `Selected network: ${ip}`,
      });
      setView("dashboard");
    } catch (e) {
      addLog({
        timestamp: new Date().toLocaleTimeString(),
        source: "app",
        level: "error",
        message: `Select network failed: ${e}`,
      });
    }
  };

  const handleClearLogs = async () => {
    if (!tauriReady) return;
    try {
      await invoke("clear_logs");
      setLogs([]);
    } catch {
      return;
    }
  };

  const handleDiagnostics = async () => {
    if (!tauriReady) return;
    setDiagnosticsLoading(true);
    try {
      const snapshot = await invoke<DiagnosticsSnapshot>("get_diagnostics");
      console.log("[AgntHost] Diagnostics:", snapshot);
      setDiagnostics(snapshot);
      setView("diagnostics");
    } catch (e) {
      logError(`Diagnostics failed: ${e}`);
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  const reloadDiagnostics = async () => {
    if (!tauriReady) return;
    try {
      const snapshot = await invoke<DiagnosticsSnapshot>("get_diagnostics");
      setDiagnostics(snapshot);
    } catch (e) {
      logError(`Diagnostics refresh failed: ${e}`);
    }
  };

  const handleDiagnosticAction = async (action: DiagnosticAction | null) => {
    if (!action || !tauriReady) return;
    try {
      if (action.kind === "refreshRuntime") {
        await invoke("refresh_bundled_runtime");
      } else if (action.kind === "selectNetwork" && action.value) {
        await invoke("select_network", { ip: action.value });
        setStatus((p) => ({ ...p, network: action.value || "" }));
        setSettings((p) => ({ ...p, selected_ip: action.value || "" }));
      } else if (action.kind === "applyPort" && action.value) {
        const port = parseInt(action.value) || 9000;
        const next = { ...settings, relay_port: port };
        await invoke("save_config_cmd", { config: next });
        setSettings(next);
        setSettingsPort(String(port));
      } else if (action.kind === "checkUpdate") {
        await handleCheckForUpdate();
      } else if (action.kind === "openSettings") {
        invoke<AppConfig>("get_config").then(setSettings).catch(() => {});
        setSettingsPort(String(settings.relay_port));
        setView("settings");
        return;
      }
      await reloadDiagnostics();
    } catch (e) {
      logError(`Action failed: ${e}`);
    }
  };

  const handleSaveSettings = async () => {
    if (!tauriReady) return;
    const newConfig: AppConfig = {
      ...settings,
      relay_port: parseInt(settingsPort) || 9000,
    };
    try {
      await invoke("save_config_cmd", { config: newConfig });
      setSettings(newConfig);
      addLog({
        timestamp: new Date().toLocaleTimeString(),
        source: "app",
        level: "info",
        message: "Settings saved.",
      });
    } catch (e) {
      logError(`Save failed: ${e}`);
    }
  };

  const handleCheckPort = async (port: string) => {
    setSettingsPort(port);
    const portNum = parseInt(port) || 0;
    if (portNum < 1 || portNum > 65535) return;
    setPortStatus("checking");
    try {
      const result = await invoke<{ available: boolean; suggested: number | null }>("check_port", { port: portNum });
      setPortStatus(result.available ? "available" : "taken");
      if (!result.available && result.suggested) {
        setSettingsPort(String(result.suggested));
      }
    } catch {
      setPortStatus("available");
    }
  };

  const handleCopyUrl = async () => {
    if (status.relay_url) {
      await navigator.clipboard.writeText(status.relay_url);
    }
  };

  const handleCheckForUpdate = async () => {
    if (!tauriReady || updateStatus !== "idle") return;
    setUpdateStatus("checking");
    try {
      const update = await invoke<UpdateInfo | null>("check_for_update");
      setUpdateInfo(update);
      addLog({
        timestamp: new Date().toLocaleTimeString(),
        source: "app",
        level: "info",
        message: update ? `Update available: ${update.version}` : "No update available.",
      });
    } catch (e) {
      logError(`Update check failed: ${e}`);
    } finally {
      setUpdateStatus("idle");
    }
  };

  const handleInstallUpdate = async () => {
    if (!tauriReady || updateStatus !== "idle") return;
    setUpdateStatus("installing");
    try {
      await invoke("install_update");
    } catch (e) {
      setUpdateStatus("idle");
      logError(`Update install failed: ${e}`);
    }
  };

  const handleCopyPairingCode = async () => {
    if (pairingCode) {
      await navigator.clipboard.writeText(pairingCode);
    }
  };

  const isStopped = appState === "stopped" || appState === "error";

  return (
    <AppShell
      appState={appState}
      errorMsg={errorMsg}
      firewallWarning={firewallWarning}
      updateInfo={updateInfo}
      updateStatus={updateStatus}
      view={view}
      onDismissFirewall={() => setFirewallWarning(null)}
      onInstallUpdate={handleInstallUpdate}
      onDashboard={() => setView("dashboard")}
      onLoadNetworks={handleLoadNetworks}
      onLogs={() => setView("logs")}
      onSettings={() => {
        invoke<AppConfig>("get_config").then(setSettings).catch(() => {});
        setSettingsPort(String(settings.relay_port));
        setView("settings");
      }}
      onDiagnostics={handleDiagnostics}
    >
      <AppViews
        view={view} firstRun={firstRun} status={status}
        pairingPayload={pairingPayload} pairingCode={pairingCode}
        phoneConnected={phoneConnected} isStopped={isStopped}
        starting={starting} tauriReady={tauriReady}
        networks={networks} logs={logs} logsEndRef={logsEndRef}
        settings={settings} settingsPort={settingsPort} portStatus={portStatus}
        updateInfo={updateInfo} updateStatus={updateStatus}
        providerBridgeStatus={providerBridgeStatus} providerKeyStatus={providerKeyStatus}
        providerApiKeyInput={providerApiKeyInput} providerBridgeBusy={providerBridgeBusy}
        diagnostics={diagnostics} diagnosticsLoading={diagnosticsLoading}
        setStatus={setStatus} setFirstRun={setFirstRun} setSettings={setSettings}
        setProviderApiKeyInput={setProviderApiKeyInput} setView={setView}
        onLoadNetworks={handleLoadNetworks} onCopyUrl={handleCopyUrl}
        onCopyPairingCode={handleCopyPairingCode} onStartAll={handleStartAll}
        onStopAll={handleStopAll} onRestartBridge={handleRestartBridge}
        onRestartRelay={handleRestartRelay} onSelectNetwork={handleSelectNetwork}
        onClearLogs={handleClearLogs} onCheckPort={handleCheckPort}
        onCheckForUpdate={handleCheckForUpdate} onInstallUpdate={handleInstallUpdate}
        onToggleProviderBridge={handleToggleProviderBridge}
        onSaveProviderApiKey={handleSaveProviderApiKey}
        onClearProviderApiKey={handleClearProviderApiKey} onSaveSettings={handleSaveSettings}
        onDiagnostics={handleDiagnostics} onDiagnosticAction={handleDiagnosticAction}
      />
    </AppShell>
  );
}

export default App;
