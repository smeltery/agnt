import { useEffect, useState } from "react";
import type { ConnectionStatus } from "../../protocol";
import {
  classifyLatency,
  selectMedianLatency,
  useLatencyStore,
} from "../../state/latency-store";

export function StatusPill({ status }: { status: ConnectionStatus }) {
  const { label, tone } = describe(status);
  const latency = useLiveLatency();
  // Latency tier only applies while the connection is open — a "Closed:
  // network error" pill should keep its warn tone, not switch to "ok"
  // because we have stale samples.
  const tier = status.kind === "open" ? classifyLatency(latency) : "idle";
  const tooltip = latency !== null
    ? `${label} · ~${latency} ms round-trip (median of recent RPCs)`
    : label;
  return (
    <span className={`agnt-status-pill agnt-status-${tone} agnt-status-rtt-${tier}`} title={tooltip}>
      {label}
      {status.kind === "open" && latency !== null && (
        <span className="agnt-status-rtt"> · {latency}ms</span>
      )}
    </span>
  );
}

function useLiveLatency(): number | null {
  // The latency store updates on every RPC response. We don't subscribe to
  // every sample (would re-render on each RPC); instead we recompute the
  // median on a 1 s tick, which is plenty for a status pill.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return selectMedianLatency(useLatencyStore.getState());
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
