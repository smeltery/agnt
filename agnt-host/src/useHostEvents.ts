import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppStatus, LogEntry, View } from "./host-types";

type HostEventsArgs = {
  tauriReady: boolean;
  addLog(entry: LogEntry): void;
  refreshStatus(): Promise<void>;
  setAppState(value: string | ((prev: string) => string)): void;
  setErrorMsg(value: string | null): void;
  setFirewallWarning(value: { ip: string; port: number; message: string } | null): void;
  setFirstRun(value: boolean): void;
  setPairingCode(value: string | null): void;
  setPairingPayload(value: string | null): void;
  setPhoneConnected(value: boolean): void;
  setStatus(value: AppStatus | ((prev: AppStatus) => AppStatus)): void;
  setView(value: View): void;
};

export function useHostEvents({
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
}: HostEventsArgs) {
  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;
    listen<LogEntry>("log-entry", (event) => addLog(event.payload)).then((fn) => {
      unlistenFn = fn;
    });
    return () => {
      unlistenFn?.();
    };
  }, [tauriReady, addLog]);

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
  }, [tauriReady, setAppState, setStatus]);

  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;
    listen<string>("pairing-ready", (event) => setPairingPayload(event.payload)).then((fn) => {
      unlistenFn = fn;
    });
    return () => {
      unlistenFn?.();
    };
  }, [tauriReady, setPairingPayload]);

  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;
    listen<string>("pairing-code-ready", (event) => setPairingCode(event.payload)).then((fn) => {
      unlistenFn = fn;
    });
    return () => {
      unlistenFn?.();
    };
  }, [tauriReady, setPairingCode]);

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
  }, [tauriReady, setAppState, setPhoneConnected]);

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
  }, [tauriReady, setAppState, setPhoneConnected]);

  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;
    listen("first-run", () => setFirstRun(true)).then((fn) => {
      unlistenFn = fn;
    });
    return () => {
      unlistenFn?.();
    };
  }, [tauriReady, setFirstRun]);

  useEffect(() => {
    if (!tauriReady) return;
    let unlistenFn: (() => void) | null = null;
    listen<{ ip: string; port: number; message: string }>("firewall-warning", (event) => {
      setFirewallWarning(event.payload);
    }).then((fn) => {
      unlistenFn = fn;
    });
    return () => {
      unlistenFn?.();
    };
  }, [tauriReady, setFirewallWarning]);

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
  }, [tauriReady, addLog, setErrorMsg]);

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
  }, [tauriReady, refreshStatus, setView]);
}
