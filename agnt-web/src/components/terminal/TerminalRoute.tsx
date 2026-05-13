// Full-route bridge-PTY terminal modal. Mirrors the iOS/Android
// TerminalScreen but is purely a remote shell — there is no SSH editor or key
// management here because the bridge spawns the shell on its own host.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccountStore } from "../../state/account-store";
import { useConnectionStore } from "../../state/connection-store";
import { useThemeStore } from "../../state/theme-store";
import { DEFAULT_TERMINAL_ID, useTerminalStore } from "../../state/terminal-store";
import {
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
  TerminalSurface,
  type TerminalTheme,
} from "./TerminalSurface";

interface TerminalRouteProps {
  onClose: () => void;
}

const FONT_SIZE_DEFAULT = 13;
const FONT_SIZE_MIN = 9;
const FONT_SIZE_MAX = 22;

export function TerminalRoute({ onClose }: TerminalRouteProps): JSX.Element {
  const connection = useConnectionStore((state) => state.connection);
  const themePreference = useThemeStore((state) => state.theme);
  const themeMode = useResolvedTheme(themePreference);
  const accountSnapshot = useAccountStore((state) => state.snapshot);
  const terminalEnabled = accountSnapshot?.hostCapabilities?.terminalLocal === true;

  const snapshot = useTerminalStore((state) => state.snapshots[DEFAULT_TERMINAL_ID]);
  const ensureSubscribed = useTerminalStore((state) => state.ensureSubscribed);
  const subscribeOutput = useTerminalStore((state) => state.subscribeOutput);
  const open = useTerminalStore((state) => state.open);
  const write = useTerminalStore((state) => state.write);
  const resize = useTerminalStore((state) => state.resize);
  const closeSession = useTerminalStore((state) => state.close);
  const clearBuffer = useTerminalStore((state) => state.clear);

  const [fontSize, setFontSize] = useState(FONT_SIZE_DEFAULT);
  const [actionError, setActionError] = useState<string | null>(null);
  const bootedRef = useRef(false);

  const theme = useMemo<TerminalTheme>(
    () => (themeMode === "light" ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK),
    [themeMode]
  );

  const subscribe = useCallback(
    (listener: (bytes: Uint8Array) => void) => {
      return subscribeOutput((id, bytes) => {
        if (id === DEFAULT_TERMINAL_ID) listener(bytes);
      });
    },
    [subscribeOutput]
  );

  const handleInput = useCallback(
    (bytes: Uint8Array) => {
      if (!connection) return;
      void write(connection.rpc, { bytes }).catch((err) => {
        setActionError(err instanceof Error ? err.message : String(err));
      });
    },
    [connection, write]
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (!connection) return;
      void resize(connection.rpc, { cols, rows }).catch((err) => {
        setActionError(err instanceof Error ? err.message : String(err));
      });
    },
    [connection, resize]
  );

  // Wire notification listener once and (when enabled) auto-open a session.
  useEffect(() => {
    if (!connection || !terminalEnabled) return;
    ensureSubscribed(connection.rpc);
  }, [connection, terminalEnabled, ensureSubscribed]);

  useEffect(() => {
    if (!connection || !terminalEnabled || bootedRef.current) return;
    if (snapshot?.status === "running" || snapshot?.status === "starting") {
      bootedRef.current = true;
      return;
    }
    bootedRef.current = true;
    void open(connection.rpc, { cols: 100, rows: 30 }).catch((err) => {
      setActionError(err instanceof Error ? err.message : String(err));
    });
  }, [connection, terminalEnabled, open, snapshot?.status]);

  const isRunning = snapshot?.status === "running" || snapshot?.status === "starting";

  const onReconnect = useCallback(() => {
    if (!connection) return;
    setActionError(null);
    bootedRef.current = true;
    void open(connection.rpc, { cols: snapshot?.cols ?? 100, rows: snapshot?.rows ?? 30 }).catch((err) => {
      setActionError(err instanceof Error ? err.message : String(err));
    });
  }, [connection, open, snapshot?.cols, snapshot?.rows]);

  const onDisconnect = useCallback(() => {
    if (!connection) return;
    void closeSession(connection.rpc, {}).catch((err) => {
      setActionError(err instanceof Error ? err.message : String(err));
    });
  }, [connection, closeSession]);

  const onClear = useCallback(() => {
    if (!connection) return;
    void clearBuffer(connection.rpc, {}).catch((err) => {
      setActionError(err instanceof Error ? err.message : String(err));
    });
  }, [connection, clearBuffer]);

  if (!connection) {
    return (
      <div className="agnt-terminal-route">
        <header className="agnt-terminal-header">
          <button className="agnt-button-ghost" onClick={onClose} aria-label="Close terminal">×</button>
          <h2>Terminal</h2>
        </header>
        <div className="agnt-terminal-empty">Connect to the bridge first.</div>
      </div>
    );
  }

  if (!terminalEnabled) {
    return (
      <div className="agnt-terminal-route">
        <header className="agnt-terminal-header">
          <button className="agnt-button-ghost" onClick={onClose} aria-label="Close terminal">×</button>
          <h2>Terminal</h2>
        </header>
        <div className="agnt-terminal-empty">
          <p>The web terminal is disabled.</p>
          <p>
            Enable <code>enableWebTerminal</code> in the bridge settings panel
            (or in the daemon config on your bridge host) to spawn a shell
            session here.
          </p>
        </div>
      </div>
    );
  }

  const status = snapshot?.status ?? "idle";
  const errorDetail = actionError ?? snapshot?.errorMessage ?? null;
  const terminalKey = `${DEFAULT_TERMINAL_ID}:${snapshot?.instanceId ?? "idle"}`;

  return (
    <div className="agnt-terminal-route" style={{ background: theme.background, color: theme.foreground }}>
      <header className="agnt-terminal-header">
        <button className="agnt-button-ghost" onClick={onClose} aria-label="Close terminal">×</button>
        <div className="agnt-terminal-title">
          <span>Terminal</span>
          <small>{snapshot?.cwd ? snapshot.cwd : "bridge host"}</small>
        </div>
        <div className="agnt-terminal-actions">
          <span className={"agnt-terminal-status agnt-terminal-status-" + status}>{statusLabel(status)}</span>
          <button
            className="agnt-button-ghost"
            onClick={() => setFontSize((value) => Math.max(FONT_SIZE_MIN, value - 1))}
            disabled={fontSize <= FONT_SIZE_MIN}
            aria-label="Decrease font size"
          >A-</button>
          <button
            className="agnt-button-ghost"
            onClick={() => setFontSize((value) => Math.min(FONT_SIZE_MAX, value + 1))}
            disabled={fontSize >= FONT_SIZE_MAX}
            aria-label="Increase font size"
          >A+</button>
          <button className="agnt-button-ghost" onClick={onClear} disabled={!snapshot?.historyBase64}>
            Clear
          </button>
          {isRunning ? (
            <button className="agnt-button-ghost" onClick={onDisconnect}>Disconnect</button>
          ) : (
            <button className="agnt-button-ghost" onClick={onReconnect}>Connect</button>
          )}
        </div>
      </header>
      {errorDetail && <div className="agnt-terminal-error">{errorDetail}</div>}
      <div className="agnt-terminal-body">
        <TerminalSurface
          terminalKey={terminalKey}
          initialHistoryBase64={snapshot?.historyBase64 ?? ""}
          fontSize={fontSize}
          theme={theme}
          subscribeOutput={subscribe}
          onInput={handleInput}
          onResize={handleResize}
        />
      </div>
    </div>
  );
}

function useResolvedTheme(pref: "auto" | "light" | "dark"): "light" | "dark" {
  const [systemDark, setSystemDark] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return true;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    if (pref !== "auto" || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [pref]);
  if (pref === "light") return "light";
  if (pref === "dark") return "dark";
  return systemDark ? "dark" : "light";
}

function statusLabel(status: string): string {
  switch (status) {
    case "running": return "Running";
    case "starting": return "Connecting";
    case "exited": return "Exited";
    case "closed": return "Closed";
    case "error": return "Error";
    default: return "Idle";
  }
}
