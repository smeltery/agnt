import type { ConnectionStatus } from "../../protocol";

export function StatusPill({ status }: { status: ConnectionStatus }) {
  const { label, tone } = describe(status);
  return <span className={`agnt-status-pill agnt-status-${tone}`}>{label}</span>;
}

function describe(status: ConnectionStatus): { label: string; tone: "idle" | "info" | "ok" | "warn" | "error" } {
  switch (status.kind) {
    case "idle":
      return { label: "Idle", tone: "idle" };
    case "connecting":
      return { label: "Connecting…", tone: "info" };
    case "handshaking":
      return { label: "Securing…", tone: "info" };
    case "open":
      return { label: "Connected", tone: "ok" };
    case "closed":
      return { label: `Closed: ${status.reason}`, tone: "warn" };
    case "error":
      return { label: `Error: ${status.message}`, tone: "error" };
  }
}
