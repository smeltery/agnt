// Thin WebSocket wrapper. Browser WebSocket cannot set custom headers, so the role
// is sent as a query-string parameter (?role=iphone). The relay is patched to honor
// that fallback while still preferring the existing x-role header for iOS clients.
//
// Resilience knobs (heartbeat, exponential reconnect) live in the orchestrator above
// this module; this layer only exposes open/close/send/onmessage.

import { makeLogger } from "../lib/log";

const log = makeLogger("relay-socket");

export interface RelaySocketHandlers {
  onOpen: () => void;
  onMessage: (text: string) => void;
  onClose: (event: { code: number; reason: string }) => void;
  onError: (error: unknown) => void;
}

export class RelaySocket {
  private socket: WebSocket | null = null;
  private closedByUs = false;

  constructor(private readonly url: string, private readonly handlers: RelaySocketHandlers) {}

  connect(): void {
    if (this.socket) return;
    log.debug("connecting", redactUrl(this.url));
    const socket = new WebSocket(this.url);
    socket.addEventListener("open", () => this.handlers.onOpen());
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.handlers.onMessage(event.data);
    });
    socket.addEventListener("close", (event) => {
      this.socket = null;
      if (this.closedByUs) return;
      this.handlers.onClose({ code: event.code, reason: event.reason });
    });
    socket.addEventListener("error", (event) => this.handlers.onError(event));
    this.socket = socket;
  }

  send(text: string): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(text);
    return true;
  }

  close(code = 1000, reason = "client closing"): void {
    this.closedByUs = true;
    this.socket?.close(code, reason);
    this.socket = null;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}

// Builds the relay URL, normalizing scheme (http(s) → ws(s)) and tacking on ?role=iphone.
// Mirrors iOS connection logic in CodexService+Connection.swift.
export function buildRelayUrl(relayBase: string, sessionId: string): string {
  const normalized = relayBase.trim().replace(/\/+$/, "");
  const wsBase = normalized.replace(/^http(s?):\/\//i, (_, secure) => `ws${secure}://`);
  const sep = wsBase.includes("?") ? "&" : "?";
  return `${wsBase}/relay/${encodeURIComponent(sessionId)}${sep}role=iphone`;
}

function redactUrl(url: string): string {
  return url.replace(/relay\/[^/?]+/, "relay/[session]");
}
