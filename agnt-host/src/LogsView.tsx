import type { RefObject } from "react";
import type { LogEntry, View } from "./host-types";
import { LOG_LEVEL_COLORS, SOURCE_COLORS } from "./host-colors";
import { ActionBtn } from "./ui-components";

export function LogsView({
  logs,
  logsEndRef,
  setView,
  onClearLogs,
}: {
  logs: LogEntry[];
  logsEndRef: RefObject<HTMLDivElement | null>;
  setView: (view: View) => void;
  onClearLogs: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        background: "var(--bg-surface)",
        borderRadius: "7px",
        border: "1px solid var(--border-color)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 10px",
          borderBottom: "1px solid var(--border-color)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)" }}>
          Logs ({logs.length} lines)
        </span>
        <div style={{ display: "flex", gap: "4px" }}>
          <ActionBtn
            label="Back"
            color="#9AA4B2"
            onClick={() => setView("dashboard")}
            compact
          />
          <ActionBtn
            label="Copy All"
            color="#4F8CFF"
            onClick={() => {
              const text = logs.map((l) => `${l.timestamp} [${l.source}] ${l.level}: ${l.message}`).join("\n");
              navigator.clipboard.writeText(text);
            }}
            compact
          />
          <ActionBtn
            label="Clear"
            color="#FF5C5C"
            onClick={onClearLogs}
            compact
          />
        </div>
      </div>
      <div
        className="logs-area"
        style={{
          flex: 1,
          overflow: "auto",
          minHeight: 0,
        }}
      >
        {logs.length === 0 ? (
          <div style={{ padding: "20px", textAlign: "center", color: "var(--text-secondary)", fontSize: "11px" }}>
            No logs yet.
          </div>
        ) : (
          logs.map((log, i) => (
            <div
              key={i}
              onClick={() => {
                const line = `${log.timestamp} [${log.source}] ${log.level}: ${log.message}`;
                navigator.clipboard.writeText(line);
              }}
              title="Click to copy"
              style={{
                fontSize: "10px",
                fontFamily: "ui-monospace, Consolas, monospace",
                padding: "1px 8px",
                lineHeight: "1.6",
                cursor: "pointer",
                borderRadius: "2px",
                transition: "background 0.08s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "var(--bg-elevated)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "transparent";
              }}
            >
              <span style={{ color: "var(--text-secondary)", marginRight: "6px" }}>
                {log.timestamp}
              </span>
              <span
                style={{
                  color: SOURCE_COLORS[log.source] || "#9AA4B2",
                  fontWeight: 600,
                  marginRight: "6px",
                }}
              >
                {log.source}
              </span>
              <span style={{ color: LOG_LEVEL_COLORS[log.level] || "#F4F7FA" }}>
                {log.message}
              </span>
            </div>
          ))
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
