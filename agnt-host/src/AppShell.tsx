import type { ReactNode } from "react";
import type { UpdateInfo, View } from "./host-types";
import { ViewTab } from "./ui-components";
import { STATE_COLORS, STATE_LABELS } from "./host-defaults";

export function AppShell({
  appState,
  errorMsg,
  firewallWarning,
  updateInfo,
  updateStatus,
  view,
  children,
  onDismissFirewall,
  onInstallUpdate,
  onDashboard,
  onLoadNetworks,
  onLogs,
  onSettings,
  onDiagnostics,
}: {
  appState: string;
  errorMsg: string | null;
  firewallWarning: { ip: string; port: number; message: string } | null;
  updateInfo: UpdateInfo | null;
  updateStatus: "idle" | "checking" | "installing";
  view: View;
  children: ReactNode;
  onDismissFirewall(): void;
  onInstallUpdate(): void;
  onDashboard(): void;
  onLoadNetworks(): void;
  onLogs(): void;
  onSettings(): void;
  onDiagnostics(): void;
}) {
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
            onClick={onDismissFirewall}
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
            onClick={onInstallUpdate}
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

      <div style={viewBodyStyle}>{children}</div>

      <div style={{ display: "flex", gap: "2px", background: "var(--bg-surface)", borderRadius: "6px", padding: "2px" }}>
        <ViewTab label="Dashboard" active={view === "dashboard"} onClick={onDashboard} />
        <ViewTab label="Network" active={view === "network"} onClick={onLoadNetworks} />
        <ViewTab label="Logs" active={view === "logs"} onClick={onLogs} />
        <ViewTab label="Settings" active={view === "settings"} onClick={onSettings} />
        <ViewTab label="Diagnostics" active={view === "diagnostics"} onClick={onDiagnostics} />
      </div>
    </div>
  );
}

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
