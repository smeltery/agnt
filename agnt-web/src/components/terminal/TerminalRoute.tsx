// Full-route bridge-PTY terminal modal. Mirrors the iOS/Android
// TerminalScreen but is purely a remote shell — there is no SSH editor or key
// management here because the bridge spawns the shell on its own host.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JsonRpcRemoteError } from "../../protocol/jsonrpc-client";
import { TERMINAL_FIRST_USE_ERROR_CODE } from "../../protocol/terminal";
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
import {
  closeTerminalTab,
  createTerminalTab,
  terminalTabSubtitle,
  type TerminalTab,
} from "./terminal-tabs";

interface TerminalRouteProps {
  onClose: () => void;
}

const FONT_SIZE_DEFAULT = 13;
const FONT_SIZE_MIN = 9;
const FONT_SIZE_MAX = 22;

export function TerminalRoute({ onClose }: TerminalRouteProps) {
  const connection = useConnectionStore((state) => state.connection);
  const themePreference = useThemeStore((state) => state.theme);
  const themeMode = useResolvedTheme(themePreference);
  const accountSnapshot = useAccountStore((state) => state.snapshot);
  const terminalEnabled = accountSnapshot?.hostCapabilities?.terminalLocal === true;

  const snapshots = useTerminalStore((state) => state.snapshots);
  const ensureSubscribed = useTerminalStore((state) => state.ensureSubscribed);
  const subscribeOutput = useTerminalStore((state) => state.subscribeOutput);
  const open = useTerminalStore((state) => state.open);
  const write = useTerminalStore((state) => state.write);
  const resize = useTerminalStore((state) => state.resize);
  const closeSession = useTerminalStore((state) => state.close);
  const clearBuffer = useTerminalStore((state) => state.clear);

  const [fontSize, setFontSize] = useState(FONT_SIZE_DEFAULT);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<TerminalTab[]>([{ id: DEFAULT_TERMINAL_ID, title: "Terminal 1" }]);
  const [activeTerminalId, setActiveTerminalId] = useState(DEFAULT_TERMINAL_ID);
  /** Pending open params we'll retry once the user accepts the first-use prompt. */
  const [pendingFirstUseOpen, setPendingFirstUseOpen] = useState<{ terminalId: string; cols: number; rows: number } | null>(null);
  const bootedTerminalIdsRef = useRef(new Set<string>());
  const snapshot = snapshots[activeTerminalId];

  const theme = useMemo<TerminalTheme>(
    () => (themeMode === "light" ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK),
    [themeMode]
  );

  const subscribe = useCallback(
    (listener: (bytes: Uint8Array) => void) => {
      return subscribeOutput((id, bytes) => {
        if (id === activeTerminalId) listener(bytes);
      });
    },
    [activeTerminalId, subscribeOutput]
  );

  const handleInput = useCallback(
    (bytes: Uint8Array) => {
      if (!connection) return;
      void write(connection.rpc, { terminalId: activeTerminalId, bytes }).catch((err) => {
        setActionError(err instanceof Error ? err.message : String(err));
      });
    },
    [activeTerminalId, connection, write]
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (!connection) return;
      void resize(connection.rpc, { terminalId: activeTerminalId, cols, rows }).catch((err) => {
        setActionError(err instanceof Error ? err.message : String(err));
      });
    },
    [activeTerminalId, connection, resize]
  );

  // Wire notification listener once and (when enabled) auto-open a session.
  useEffect(() => {
    if (!connection || !terminalEnabled) return;
    ensureSubscribed(connection.rpc);
  }, [connection, terminalEnabled, ensureSubscribed]);

  // Catches the bridge's first-use rejection and surfaces it as a confirm
  // prompt instead of an error message. The user can accept (we retry with
  // acknowledgeFirstUse: true) or close the route.
  const tryOpen = useCallback(
    (params: { terminalId: string; cols: number; rows: number; acknowledgeFirstUse?: boolean }) => {
      if (!connection) return;
      void open(connection.rpc, params).catch((err) => {
        if (
          err instanceof JsonRpcRemoteError &&
          (err.data as { errorCode?: string } | undefined)?.errorCode === TERMINAL_FIRST_USE_ERROR_CODE
        ) {
          setPendingFirstUseOpen({ terminalId: params.terminalId, cols: params.cols, rows: params.rows });
          return;
        }
        setActionError(err instanceof Error ? err.message : String(err));
      });
    },
    [connection, open]
  );

  useEffect(() => {
    if (!connection || !terminalEnabled || bootedTerminalIdsRef.current.has(activeTerminalId)) return;
    if (snapshot?.status === "running" || snapshot?.status === "starting") {
      bootedTerminalIdsRef.current.add(activeTerminalId);
      return;
    }
    bootedTerminalIdsRef.current.add(activeTerminalId);
    tryOpen({ terminalId: activeTerminalId, cols: 100, rows: 30 });
  }, [activeTerminalId, connection, terminalEnabled, tryOpen, snapshot?.status]);

  const isRunning = snapshot?.status === "running" || snapshot?.status === "starting";

  const onReconnect = useCallback(() => {
    if (!connection) return;
    setActionError(null);
    bootedTerminalIdsRef.current.add(activeTerminalId);
    tryOpen({ terminalId: activeTerminalId, cols: snapshot?.cols ?? 100, rows: snapshot?.rows ?? 30 });
  }, [activeTerminalId, connection, tryOpen, snapshot?.cols, snapshot?.rows]);

  const onDisconnect = useCallback(() => {
    if (!connection) return;
    void closeSession(connection.rpc, { terminalId: activeTerminalId }).catch((err) => {
      setActionError(err instanceof Error ? err.message : String(err));
    });
  }, [activeTerminalId, connection, closeSession]);

  const onClear = useCallback(() => {
    if (!connection) return;
    void clearBuffer(connection.rpc, { terminalId: activeTerminalId }).catch((err) => {
      setActionError(err instanceof Error ? err.message : String(err));
    });
  }, [activeTerminalId, connection, clearBuffer]);

  const onNewTerminal = useCallback(() => {
    setActionError(null);
    setTabs((current) => {
      const next = createTerminalTab(current);
      setActiveTerminalId(next.id);
      return [...current, next];
    });
  }, []);

  const onCloseTab = useCallback(
    (terminalId: string) => {
      if (tabs.length <= 1) return;
      if (connection) {
        void closeSession(connection.rpc, { terminalId }).catch((err) => {
          setActionError(err instanceof Error ? err.message : String(err));
        });
      }
      bootedTerminalIdsRef.current.delete(terminalId);
      const next = closeTerminalTab(tabs, activeTerminalId, terminalId);
      setTabs(next.tabs);
      setActiveTerminalId(next.activeId);
    },
    [activeTerminalId, closeSession, connection, tabs]
  );

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
  const terminalKey = `${activeTerminalId}:${snapshot?.instanceId ?? "idle"}`;

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
      <div className="agnt-terminal-tabbar" role="tablist" aria-label="Terminal sessions">
        {tabs.map((tab) => {
          const tabSnapshot = snapshots[tab.id];
          const tabStatus = tabSnapshot?.status ?? "idle";
          const selected = tab.id === activeTerminalId;
          return (
            <div
              key={tab.id}
              className={"agnt-terminal-tab" + (selected ? " agnt-terminal-tab-active" : "")}
            >
              <button
                type="button"
                className="agnt-terminal-tab-main"
                role="tab"
                aria-selected={selected}
                onClick={() => { setActionError(null); setActiveTerminalId(tab.id); }}
              >
                <span className="agnt-terminal-tab-title">{tab.title}</span>
                <span className="agnt-terminal-tab-meta">
                  <span className={"agnt-terminal-dot agnt-terminal-dot-" + tabStatus} />
                  {terminalTabSubtitle(tabSnapshot)}
                </span>
              </button>
              {tabs.length > 1 && (
                <button
                  type="button"
                  className="agnt-terminal-tab-close"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => onCloseTab(tab.id)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        <button className="agnt-terminal-tab-add" type="button" onClick={onNewTerminal} aria-label="Open new terminal">
          +
        </button>
      </div>
      {errorDetail && <div className="agnt-terminal-error">{errorDetail}</div>}
      {pendingFirstUseOpen && (
        <div className="agnt-terminal-confirm" role="alertdialog" aria-modal="true" aria-label="Confirm shell access">
          <div className="agnt-terminal-confirm-card">
            <h3>Open a shell on the bridge host?</h3>
            <p>
              This is the first terminal session since the bridge started.
              Anything you type runs as the user that started <code>agnt up</code>.
              Continue?
            </p>
            <div className="agnt-terminal-confirm-actions">
              <button className="agnt-button-ghost" onClick={() => { setPendingFirstUseOpen(null); onClose(); }}>
                Cancel
              </button>
              <button
                className="agnt-button-primary"
                onClick={() => {
                  const params = pendingFirstUseOpen;
                  setPendingFirstUseOpen(null);
                  if (params) tryOpen({ ...params, acknowledgeFirstUse: true });
                }}
              >
                Open shell
              </button>
            </div>
          </div>
        </div>
      )}
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
