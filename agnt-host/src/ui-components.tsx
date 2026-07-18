import type { DiagnosticAction } from "./host-types";
import { STATUS_COLORS } from "./host-colors";

export function DiagnosticRow({
  title,
  status,
  detail,
  action,
  onAction,
}: {
  title: string;
  status: string;
  detail: string;
  action: DiagnosticAction | null;
  onAction: (action: DiagnosticAction | null) => void;
}) {
  const color = status === "pass" ? "#35C759" : status === "fail" ? "#FF5C5C" : "#FFB020";
  const label = status === "pass" ? "OK" : status === "fail" ? "Fix" : "Check";
  return (
    <div
      style={{
        background: "var(--bg-primary)",
        border: `1px solid ${color}35`,
        borderRadius: "6px",
        padding: "8px",
        display: "grid",
        gridTemplateColumns: action ? "1fr auto" : "1fr",
        gap: "8px",
        alignItems: "center",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "3px" }}>
          <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: color, flexShrink: 0 }} />
          <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-primary)" }}>{title}</span>
          <span style={{ fontSize: "9px", color, fontWeight: 700, textTransform: "uppercase" }}>{label}</span>
        </div>
        <div style={{ color: "var(--text-secondary)", fontSize: "10px", wordBreak: "break-word" }}>{detail}</div>
      </div>
      {action && (
        <button
          onClick={() => onAction(action)}
          style={{
            border: "none",
            borderRadius: "4px",
            background: color,
            color: "#fff",
            cursor: "pointer",
            fontSize: "10px",
            fontWeight: 700,
            padding: "5px 7px",
            whiteSpace: "nowrap",
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export function DiagnosticFact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: "8px", minWidth: 0 }}>
      <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{label}</span>
      <span style={{ color: "var(--text-secondary)", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

export function StatusCard({
  label,
  status,
  value,
  onClick,
}: {
  label: string;
  status: string;
  value?: string;
  onClick?: () => void;
}) {
  const color = STATUS_COLORS[status] || "#9AA4B2";
  return (
    <div
      onClick={onClick}
      style={{
        background: "var(--bg-surface)",
        borderRadius: "7px",
        border: "1px solid var(--border-color)",
        padding: "9px 11px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: onClick ? "pointer" : "default",
        transition: "border-color 0.15s",
      }}
    >
      <span style={{ fontSize: "11px", color: "var(--text-secondary)", fontWeight: 500 }}>{label}</span>
      {value !== undefined ? (
        <span style={{ fontSize: "11px", fontFamily: "monospace", color: "var(--text-primary)" }}>{value}</span>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: color }} />
          <span style={{ fontSize: "11px", color: color === "#9AA4B2" ? "var(--text-secondary)" : color, fontWeight: 500, textTransform: "capitalize" }}>
            {status}
          </span>
        </div>
      )}
    </div>
  );
}

export function ActionBtn({
  label,
  color,
  onClick,
  disabled,
  compact,
}: {
  label: string;
  color: string;
  onClick: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: compact ? "none" : 1,
        padding: compact ? "4px 8px" : "7px",
        fontSize: compact ? "10px" : "11px",
        fontWeight: 500,
        color: disabled ? "var(--text-secondary)" : color,
        background: disabled ? "var(--bg-surface)" : `${color}15`,
        border: `1px solid ${disabled ? "var(--border-color)" : `${color}30`}`,
        borderRadius: "5px",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "all 0.1s",
      }}
    >
      {label}
    </button>
  );
}

export function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "6px",
        fontSize: "10px",
        fontWeight: 500,
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        background: active ? "var(--bg-elevated)" : "transparent",
        border: "none",
        borderRadius: "4px",
        cursor: "pointer",
        transition: "all 0.1s",
      }}
    >
      {label}
    </button>
  );
}

export function ModeBtn({
  label,
  desc,
  active,
  onClick,
}: {
  label: string;
  desc: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "6px 8px",
        fontSize: "11px",
        fontWeight: 500,
        color: active ? "var(--accent-blue)" : "var(--text-secondary)",
        background: active ? "var(--accent-blue)15" : "transparent",
        border: `1px solid ${active ? "var(--accent-blue)" : "var(--border-color)"}`,
        borderRadius: "5px",
        cursor: "pointer",
        textAlign: "left",
        transition: "all 0.1s",
      }}
    >
      <div style={{ fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: "9px", opacity: 0.7 }}>{desc}</div>
    </button>
  );
}
