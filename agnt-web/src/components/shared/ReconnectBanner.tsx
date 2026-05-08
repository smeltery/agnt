// Sticky workspace banner shown while the connection is mid-reconnect, OR
// while it's stuck closed/error after we'd already paired. The pairing
// screen owns the very first connect attempt, so we deliberately render
// nothing during initial `idle`/`connecting`/`handshaking` — only AFTER a
// `saved` pairing exists.

import { useConnectionStore } from "../../state/connection-store";

export function ReconnectBanner() {
  const status = useConnectionStore((state) => state.status);
  const saved = useConnectionStore((state) => state.saved);
  const reconnect = useConnectionStore((state) => state.reconnect);

  if (!saved) return null;
  if (status.kind === "open" || status.kind === "idle") return null;

  return (
    <div className={"agnt-reconnect-banner agnt-reconnect-banner-" + status.kind} role="status" aria-live="polite">
      <span className="agnt-reconnect-banner-spinner" aria-hidden />
      <span className="agnt-reconnect-banner-text">{messageFor(status)}</span>
      {(status.kind === "closed" || status.kind === "error") && (
        <button type="button" className="agnt-button-ghost" onClick={() => void reconnect()}>
          Retry
        </button>
      )}
    </div>
  );
}

function messageFor(status: { kind: string; reason?: string; message?: string }): string {
  switch (status.kind) {
    case "connecting":
      return "Reconnecting to the bridge…";
    case "handshaking":
      return "Re-establishing the secure session…";
    case "closed":
      return `Connection closed${status.reason ? ` — ${status.reason}` : ""}.`;
    case "error":
      return `Connection error${status.message ? ` — ${status.message}` : ""}.`;
    default:
      return "";
  }
}
