import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { DiagnosticsView } from "./DiagnosticsView";
import { LogsView } from "./LogsView";
import { NetworkView } from "./NetworkView";
import { SettingsView } from "./SettingsView";
import {
  ActionBtn,
  ModeBtn,
  StatusCard,
  ViewTab,
} from "./ui-components";

const STATE_LABELS: Record<string, string> = {
  stopped: "Stopped",
  starting: "Starting...",
  relay_running: "Relay Running",
  local_ready: "Local Ready",
  remote_placeholder_ready: "Remote Placeholder",
  waiting_for_pairing: "Waiting for Pairing",
  connected: "Connected",
  warning: "Warning",
  error: "Error",
};

const STATE_COLORS: Record<string, string> = {
  stopped: "#9AA4B2",
  starting: "#FFB020",
  relay_running: "#4F8CFF",
  local_ready: "#35C759",
  remote_placeholder_ready: "#FFB020",
  waiting_for_pairing: "#4F8CFF",
  connected: "#35C759",
  warning: "#FFB020",
  error: "#FF5C5C",
};

function App() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [appState, setAppState] = useState("stopped");
  const [status, setStatus] = useState<AppStatus>({
    state: "stopped",
    relay_mode: "local",
    relay: "stopped",
    bridge: "stopped",
    network: "--",
    relay_url: "",
    pairing_payload: null,
    pairing_code: null,
    phone_connected: false,
  });
  const [networks, setNetworks] = useState<NetworkInterface[]>([]);
  const [pairingPayload, setPairingPayload] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [starting, setStarting] = useState(false);
  const [tauriReady, setTauriReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [phoneConnected, setPhoneConnected] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const [firewallWarning, setFirewallWarning] = useState<{ ip: string; port: number; message: string } | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "installing">("idle");
  const [settings, setSettings] = useState<AppConfig>({
    relay_mode: "local",
    selected_ip: "",
    relay_port: 9000,
    remote_relay_url: "ws://127.0.0.1:9000",
    auto_start: false,
    auto_restart: false,
    start_minimized: false,
    launch_at_startup: false,
    setup_completed: false,
    requires_entitlement: true,
    free_message_limit: 5,
    relay_path: null,
    bridge_path: null,
    log_level: "info",
    provider_bridge: {
      bind_host: "127.0.0.1",
      port: 8787,
      provider: "deepseek",
      default_model: "deepseek-v4-pro",
    },
  });
  const [settingsPort, setSettingsPort] = useState("9000");
  const [portStatus, setPortStatus] = useState<"checking" | "available" | "taken">("available");
  const [providerBridgeStatus, setProviderBridgeStatus] = useState<ProviderBridgeStatus>({
    running: false,
    bind_host: "127.0.0.1",
    port: 8787,
    base_url: "http://127.0.0.1:8787",
    provider: "deepseek",
  });
  const [providerKeyStatus, setProviderKeyStatus] = useState<ProviderKeyStatus>({
    available: false,
    source: "missing",
    has_stored_key: false,
  });
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

  // Wait for Tauri to be ready before registering listeners
  useEffect(() => {
    if (!isTauri()) return;

    // Poll until Tauri internals are available
    const checkReady = () => {
      if ((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__) {
        setTauriReady(true);
      } else {
        setTimeout(checkReady, 50);
      }
    };
    checkReady();
  }, []);

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


  // Listen for log entries
  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;

    listen<LogEntry>("log-entry", (event) => {
      addLog(event.payload);
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      unlistenFn?.();
    };
  }, [tauriReady, addLog]);

  // Listen for status changes
  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;

    listen<AppStatus>("status-changed", (event) => {
      setStatus((prev) => ({ ...prev, ...event.payload }));
      if (event.payload.state) setAppState(event.payload.state);
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      unlistenFn?.();
    };
  }, [tauriReady]);

  // Listen for pairing ready
  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;

    listen<string>("pairing-ready", (event) => {
      setPairingPayload(event.payload);
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      unlistenFn?.();
    };
  }, [tauriReady]);

  useEffect(() => {
    if (!tauriReady) return;
    invoke<UpdateInfo | null>("check_for_update")
      .then(setUpdateInfo)
      .catch(() => {});
  }, [tauriReady]);

  // Listen for manual pairing code
  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;

    listen<string>("pairing-code-ready", (event) => {
      setPairingCode(event.payload);
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      unlistenFn?.();
    };
  }, [tauriReady]);

  // Listen for phone connection from relay logs
  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;

    listen<string>("phone-connected", () => {
      setPhoneConnected(true);
      setAppState("connected");
      invoke("notify", { title: "Agnt Host", body: "Phone connected!" }).catch(() => {});
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      unlistenFn?.();
    };
  }, [tauriReady]);

  // Listen for phone disconnection
  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;

    listen<string>("phone-disconnected", () => {
      setPhoneConnected(false);
      setAppState((prev) => (prev === "connected" ? "running" : prev));
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      unlistenFn?.();
    };
  }, [tauriReady]);

  // Listen for first-run
  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;

    listen("first-run", () => {
      setFirstRun(true);
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => { unlistenFn?.(); };
  }, [tauriReady]);

  // Listen for firewall warning
  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;

    listen<{ ip: string; port: number; message: string }>("firewall-warning", (event) => {
      setFirewallWarning(event.payload);
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => { unlistenFn?.(); };
  }, [tauriReady]);

  // Listen for process crashes
  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;

    listen<{ process: string; exit_code: number }>("process-crashed", (event) => {
      const { process, exit_code } = event.payload;
      addLog({
        timestamp: new Date().toLocaleTimeString(),
        source: "app",
        level: "error",
        message: `${process} crashed (exit code: ${exit_code})`,
      });
      setErrorMsg(`${process} crashed with exit code ${exit_code}`);
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      unlistenFn?.();
    };
  }, [tauriReady, addLog]);

  // Listen for show-qr event from tray
  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;

    listen("show-qr", async () => {
      const win = getCurrentWindow();
      await win.show().catch(() => {});
      await win.setFocus().catch(() => {});
      setView("dashboard");
      await refreshStatus();
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      unlistenFn?.();
    };
  }, [tauriReady, refreshStatus]);

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
  const viewBodyStyle = {
    flex: 1,
    minHeight: 0,
    overflowY: "auto" as const,
    overflowX: "hidden" as const,
    display: "flex",
    flexDirection: "column" as const,
    gap: "10px",
    paddingRight: "2px",
  };

  return (
    <div
      style={{
        background: "var(--bg-primary)",
        height: "100vh",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        padding: "12px 14px 10px",
        gap: "10px",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.3px" }}>
            Agnt Host
          </div>
          <div style={{ fontSize: "10px", color: "var(--text-secondary)", marginTop: "1px" }}>
            Local bridge manager
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "5px",
            background: "var(--bg-surface)",
            padding: "3px 8px",
            borderRadius: "5px",
            border: "1px solid var(--border-color)",
          }}
        >
          <div
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: STATE_COLORS[appState] || "#9AA4B2",
              animation: appState === "starting" ? "pulse 1s infinite" : "none",
            }}
          />
          <span style={{ fontSize: "10px", color: "var(--text-secondary)", fontWeight: 500 }}>
            {STATE_LABELS[appState] || appState}
          </span>
        </div>
      </div>

      {/* Error Banner */}
      {errorMsg && (
        <div
          style={{
            background: "#FF5C5C15",
            border: "1px solid #FF5C5C30",
            borderRadius: "6px",
            padding: "8px 10px",
            fontSize: "11px",
            color: "#FF5C5C",
            fontFamily: "monospace",
            wordBreak: "break-all",
          }}
        >
          {errorMsg}
        </div>
      )}

      {/* Firewall Warning */}
      {firewallWarning && (
        <div
          style={{
            background: "#FFB02015",
            border: "1px solid #FFB02030",
            borderRadius: "6px",
            padding: "8px 10px",
            fontSize: "11px",
            color: "#FFB020",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <span style={{ flex: 1 }}>{firewallWarning.message}</span>
          <button
            onClick={() => setFirewallWarning(null)}
            style={{
              background: "none",
              border: "none",
              color: "#FFB020",
              cursor: "pointer",
              fontSize: "14px",
              padding: "0 0 0 8px",
              lineHeight: 1,
            }}
          >
            x
          </button>
        </div>
      )}

      {updateInfo && (
        <div
          style={{
            background: "#4F8CFF15",
            border: "1px solid #4F8CFF35",
            borderRadius: "6px",
            padding: "8px 10px",
            fontSize: "11px",
            color: "var(--text-primary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
          }}
        >
          <span style={{ color: "var(--text-secondary)" }}>
            Agnt Host {updateInfo.version} is available.
          </span>
          <button
            onClick={handleInstallUpdate}
            disabled={updateStatus !== "idle"}
            style={{
              background: "var(--accent-blue)",
              border: "none",
              borderRadius: "4px",
              color: "#fff",
              cursor: updateStatus === "idle" ? "pointer" : "default",
              fontSize: "10px",
              fontWeight: 600,
              padding: "5px 8px",
              whiteSpace: "nowrap",
              opacity: updateStatus === "idle" ? 1 : 0.7,
            }}
          >
            {updateStatus === "installing" ? "Installing..." : "Install"}
          </button>
        </div>
      )}

      <div style={viewBodyStyle}>
      {/* Onboarding / First-run */}
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
                handleLoadNetworks();
              }}
            />
          </div>
        </div>
      )}

      {/* View: Dashboard, Network, Logs, Debug */}
      {view === "dashboard" && (
        <>
          {/* Relay Mode Selector */}
          <div
            style={{
              background: "var(--bg-surface)",
              borderRadius: "7px",
              border: "1px solid var(--border-color)",
              padding: "8px 12px",
              display: "flex",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
            <ModeBtn
              label="Local LAN"
              active={status.relay_mode === "local" || !status.relay_mode}
              desc="Free"
              onClick={async () => {
                if (status.relay_mode !== "local") {
                  await invoke("set_relay_mode", { mode: "local" });
                  setStatus((p) => ({ ...p, relay_mode: "local", relay: "stopped" }));
                }
              }}
            />
            <ModeBtn
              label="Custom Relay"
              active={status.relay_mode === "remote"}
              desc="wss://"
              onClick={async () => {
                if (status.relay_mode !== "remote") {
                  await invoke("set_relay_mode", { mode: "remote" });
                  setStatus((p) => ({ ...p, relay_mode: "remote", relay: "external" }));
                }
              }}
            />
          </div>

          {/* Remote placeholder banner */}
          {status.relay_mode === "remote" && (
            <div
              style={{
                background: "#FFB02015",
                border: "1px solid #FFB02030",
                borderRadius: "6px",
                padding: "6px 10px",
                fontSize: "10px",
                color: "#FFB020",
              }}
            >
              Use a relay URL you control. Public relays should use secure wss://.
            </div>
          )}

          {/* Status Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
            <StatusCard label="Relay" status={status.relay} />
            <StatusCard label="Bridge" status={status.bridge} />
            <StatusCard
              label="Network"
              status={status.network && status.network !== "--" ? "connected" : "unknown"}
              value={status.network || "--"}
              onClick={handleLoadNetworks}
            />
            <StatusCard
              label="Phone"
              status={phoneConnected ? "running" : "unknown"}
              value={phoneConnected ? "Connected" : "--"}
            />
          </div>

          {/* Connection Info */}
          {status.relay_url && (
            <div
              style={{
                background: "var(--bg-surface)",
                borderRadius: "7px",
                border: "1px solid var(--border-color)",
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              }}
            >
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)" }}>
                Connection
              </div>
              <div
                style={{
                  fontSize: "11px",
                  fontFamily: "ui-monospace, Consolas, monospace",
                  color: "var(--text-primary)",
                  background: "var(--bg-primary)",
                  padding: "5px 8px",
                  borderRadius: "4px",
                  wordBreak: "break-all",
                }}
              >
                {status.relay_url}
              </div>
              <button
                onClick={handleCopyUrl}
                style={{
                  fontSize: "10px",
                  color: "var(--accent-blue)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  alignSelf: "flex-start",
                  padding: 0,
                }}
              >
                Copy URL
              </button>
            </div>
          )}

          {/* QR Code — always visible */}
          <div
            style={{
              background: "var(--bg-surface)",
              borderRadius: "7px",
              border: "1px solid var(--border-color)",
              padding: "12px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "7px",
            }}
          >
            <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)" }}>
              Scan with Agnt mobile app
            </div>
            {pairingPayload ? (
              <div
                style={{
                  background: "#FFFFFF",
                  padding: "7px",
                  borderRadius: "6px",
                  lineHeight: 0,
                }}
              >
                <canvas
                  id="qr-canvas"
                  width="200"
                  height="200"
                  style={{ display: "block", width: "min(200px, 52vw)", height: "auto", maxWidth: "100%" }}
                ></canvas>
              </div>
            ) : (
              <div
                style={{
                  width: "min(200px, 52vw)",
                  aspectRatio: "1 / 1",
                  background: "var(--bg-primary)",
                  borderRadius: "6px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                  {status.relay === "running" && status.bridge === "running"
                    ? "Generating QR..."
                    : "Start relay to generate QR"}
                </span>
              </div>
            )}
            {pairingPayload && (
              <div
                style={{
                  fontSize: "10px",
                  color: "var(--text-secondary)",
                  fontFamily: "monospace",
                  textAlign: "center",
                  wordBreak: "break-all",
                  maxWidth: "100%",
                }}
              >
                {pairingPayload.slice(0, 80)}...
              </div>
            )}
            {pairingCode && (
              <div
                style={{
                  width: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "5px",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    fontFamily: "ui-monospace, Consolas, monospace",
                    letterSpacing: "0.08em",
                    color: "var(--text-primary)",
                    background: "var(--bg-primary)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "4px",
                    padding: "5px 8px",
                  }}
                >
                  {pairingCode}
                </div>
                <button
                  onClick={handleCopyPairingCode}
                  style={{
                    fontSize: "10px",
                    color: "var(--accent-blue)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  Copy pairing code
                </button>
              </div>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {isStopped ? (
              <ActionBtn label={starting ? "Starting..." : "Start All"} color="#35C759" onClick={handleStartAll} disabled={starting || !tauriReady} />
            ) : (
              <ActionBtn label="Stop All" color="#FF5C5C" onClick={handleStopAll} disabled={!tauriReady} />
            )}
            <ActionBtn label="Restart Bridge" color="#4F8CFF" onClick={handleRestartBridge} disabled={status.bridge !== "running" || !tauriReady} />
            <ActionBtn label="Restart Relay" color="#FFB020" onClick={handleRestartRelay} disabled={status.relay !== "running" || !tauriReady} />
          </div>
        </>
      )}

      {view === "network" && (
        <NetworkView
          networks={networks}
          status={status}
          setView={setView}
          onSelectNetwork={handleSelectNetwork}
        />
      )}

      {view === "logs" && (
        <LogsView
          logs={logs}
          logsEndRef={logsEndRef}
          setView={setView}
          onClearLogs={handleClearLogs}
        />
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
          onCheckPort={handleCheckPort}
          onCheckForUpdate={handleCheckForUpdate}
          onInstallUpdate={handleInstallUpdate}
          onToggleProviderBridge={handleToggleProviderBridge}
          onSaveProviderApiKey={handleSaveProviderApiKey}
          onClearProviderApiKey={handleClearProviderApiKey}
          onSaveSettings={handleSaveSettings}
        />
      )}

      {view === "diagnostics" && (
        <DiagnosticsView
          diagnostics={diagnostics}
          diagnosticsLoading={diagnosticsLoading}
          tauriReady={tauriReady}
          onRefresh={handleDiagnostics}
          onAction={handleDiagnosticAction}
        />
      )}

      </div>

      {/* Bottom tabs */}
      <div style={{ display: "flex", gap: "2px", background: "var(--bg-surface)", borderRadius: "6px", padding: "2px" }}>
        <ViewTab label="Dashboard" active={view === "dashboard"} onClick={() => setView("dashboard")} />
        <ViewTab label="Network" active={view === "network"} onClick={handleLoadNetworks} />
        <ViewTab label="Logs" active={view === "logs"} onClick={() => setView("logs")} />
        <ViewTab label="Settings" active={view === "settings"} onClick={() => {
          invoke<AppConfig>("get_config").then(setSettings).catch(() => {});
          setSettingsPort(String(settings.relay_port));
          setView("settings");
        }} />
        <ViewTab label="Diagnostics" active={view === "diagnostics"} onClick={handleDiagnostics} />
      </div>
    </div>
  );
}

export default App;
