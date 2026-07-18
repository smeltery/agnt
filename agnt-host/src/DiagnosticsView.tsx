import type { DiagnosticAction, DiagnosticsSnapshot } from "./host-types";
import { ActionBtn, DiagnosticFact, DiagnosticRow } from "./ui-components";

export function DiagnosticsView({
  diagnostics,
  diagnosticsLoading,
  tauriReady,
  onRefresh,
  onAction,
}: {
  diagnostics: DiagnosticsSnapshot | null;
  diagnosticsLoading: boolean;
  tauriReady: boolean;
  onRefresh: () => void;
  onAction: (action: DiagnosticAction | null) => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        background: "var(--bg-surface)",
        borderRadius: "7px",
        border: "1px solid var(--border-color)",
        padding: "12px",
        overflow: "auto",
        fontSize: "11px",
        lineHeight: "1.45",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", gap: "8px" }}>
        <div>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>
            Diagnostics
          </div>
          <div style={{ fontSize: "10px", color: "var(--text-secondary)", marginTop: "2px" }}>
            {diagnostics?.summary || (diagnosticsLoading ? "Checking setup..." : "Run checks to inspect local setup.")}
          </div>
        </div>
        <ActionBtn
          label={diagnosticsLoading ? "Checking..." : "Refresh"}
          color="#4F8CFF"
          onClick={onRefresh}
          disabled={diagnosticsLoading || !tauriReady}
          compact
        />
      </div>

      {diagnostics && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "6px", marginBottom: "10px" }}>
            {diagnostics.presets.map((preset) => (
              <DiagnosticRow
                key={preset.id}
                title={preset.title}
                status={preset.status}
                detail={preset.detail}
                action={preset.action}
                onAction={onAction}
              />
            ))}
          </div>

          <div style={{ fontSize: "10px", fontWeight: 700, color: "var(--text-secondary)", margin: "10px 0 6px" }}>
            Setup checks
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "5px" }}>
            {diagnostics.checks.map((check) => (
              <DiagnosticRow
                key={check.id}
                title={check.title}
                status={check.status}
                detail={check.detail}
                action={check.action}
                onAction={onAction}
              />
            ))}
          </div>

          <div style={{ fontSize: "10px", fontWeight: 700, color: "var(--text-secondary)", margin: "12px 0 6px" }}>
            Bundle status
          </div>
          <div style={{ background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "6px", padding: "8px", display: "grid", gap: "4px" }}>
            <DiagnosticFact label="Runtime" value={diagnostics.runtime.runtime_current ? "current" : diagnostics.runtime.refresh_deferred ? "restart needed" : "refresh available"} />
            <DiagnosticFact label="Bridge bundle" value={`${diagnostics.runtime.bundled_manifest?.bridge.package?.version || "unknown"} / ${(diagnostics.runtime.bundled_manifest?.bridge.hash || "").slice(0, 12) || "no hash"}`} />
            <DiagnosticFact label="Bridge runtime" value={`${diagnostics.runtime.runtime_manifest?.bridge.package?.version || "missing"} / ${(diagnostics.runtime.runtime_manifest?.bridge.hash || "").slice(0, 12) || "no hash"}`} />
            <DiagnosticFact label="Relay bundle" value={(diagnostics.runtime.bundled_manifest?.relay.hash || "").slice(0, 12) || "no hash"} />
            <DiagnosticFact label="Relay runtime" value={(diagnostics.runtime.runtime_manifest?.relay.hash || "").slice(0, 12) || "no hash"} />
          </div>

          <details style={{ marginTop: "10px" }}>
            <summary style={{ cursor: "pointer", color: "var(--text-secondary)", fontSize: "10px", fontWeight: 700 }}>
              Advanced details
            </summary>
            <div style={{ marginTop: "6px", fontFamily: "ui-monospace, Consolas, monospace", fontSize: "10px", color: "var(--text-secondary)", display: "grid", gap: "3px" }}>
              <DiagnosticFact label="CWD" value={diagnostics.debug.cwd} />
              <DiagnosticFact label="Repo root" value={diagnostics.debug.repo_root} />
              <DiagnosticFact label="Node.js" value={diagnostics.debug.node_version} />
              <DiagnosticFact label="Relay dir" value={diagnostics.debug.relay_dir} />
              <DiagnosticFact label="Bridge dir" value={diagnostics.debug.bridge_dir} />
              <DiagnosticFact label="Config" value={diagnostics.debug.config_path} />
              <DiagnosticFact label="Generated" value={diagnostics.generated_at} />
            </div>
          </details>
        </>
      )}
    </div>
  );
}
