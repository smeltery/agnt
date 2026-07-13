import { invoke } from "@tauri-apps/api/core";
import type { AppStatus } from "./host-types";
import {
  ActionBtn,
  ModeBtn,
  StatusCard,
} from "./ui-components";

export function DashboardView({
  status,
  pairingPayload,
  pairingCode,
  phoneConnected,
  isStopped,
  starting,
  tauriReady,
  setStatus,
  onLoadNetworks,
  onCopyUrl,
  onCopyPairingCode,
  onStartAll,
  onStopAll,
  onRestartBridge,
  onRestartRelay,
}: {
  status: AppStatus;
  pairingPayload: string | null;
  pairingCode: string | null;
  phoneConnected: boolean;
  isStopped: boolean;
  starting: boolean;
  tauriReady: boolean;
  setStatus: (updater: (status: AppStatus) => AppStatus) => void;
  onLoadNetworks: () => void;
  onCopyUrl: () => void;
  onCopyPairingCode: () => void;
  onStartAll: () => void;
  onStopAll: () => void;
  onRestartBridge: () => void;
  onRestartRelay: () => void;
}) {
  return (
    <>
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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
        <StatusCard label="Relay" status={status.relay} />
        <StatusCard label="Bridge" status={status.bridge} />
        <StatusCard
          label="Network"
          status={status.network && status.network !== "--" ? "connected" : "unknown"}
          value={status.network || "--"}
          onClick={onLoadNetworks}
        />
        <StatusCard
          label="Phone"
          status={phoneConnected ? "running" : "unknown"}
          value={phoneConnected ? "Connected" : "--"}
        />
      </div>

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
            onClick={onCopyUrl}
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
              onClick={onCopyPairingCode}
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

      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
        {isStopped ? (
          <ActionBtn label={starting ? "Starting..." : "Start All"} color="#35C759" onClick={onStartAll} disabled={starting || !tauriReady} />
        ) : (
          <ActionBtn label="Stop All" color="#FF5C5C" onClick={onStopAll} disabled={!tauriReady} />
        )}
        <ActionBtn label="Restart Bridge" color="#4F8CFF" onClick={onRestartBridge} disabled={status.bridge !== "running" || !tauriReady} />
        <ActionBtn label="Restart Relay" color="#FFB020" onClick={onRestartRelay} disabled={status.relay !== "running" || !tauriReady} />
      </div>
    </>
  );
}
