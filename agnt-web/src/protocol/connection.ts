// Top-level orchestration: relay socket ⇆ secure channel ⇆ JSON-RPC client.
// One Connection instance per active session; recreate on full re-pair.

import type { PhoneIdentity } from "../crypto";
import { makeLogger } from "../lib/log";
import { JsonRpcClient } from "./jsonrpc-client";
import { buildRelayUrl, RelaySocket } from "./relay-socket";
import { SecureChannel, SecureHandshakeError } from "./secure-channel";

const log = makeLogger("connection");

export type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "handshaking" }
  | { kind: "open" }
  | { kind: "closed"; reason: string }
  | { kind: "error"; message: string; code?: string };

export interface ConnectionInputs {
  relayUrl: string;
  sessionId: string;
  macDeviceId: string;
  expectedMacIdentityPublicKey: string;
  handshakeMode: "qr_bootstrap" | "trusted_reconnect";
  phoneIdentity: PhoneIdentity;
  lastAppliedBridgeOutboundSeq: number;
  onStatus: (status: ConnectionStatus) => void;
  onApplicationPayload?: (payloadText: string) => void;
  onBridgeOutboundSeq?: (seq: number) => void;
  onLatencySample?: (method: string, milliseconds: number) => void;
}

export class Connection {
  readonly rpc: JsonRpcClient;
  private readonly socket: RelaySocket;
  private readonly secure: SecureChannel;
  private status: ConnectionStatus = { kind: "idle" };

  constructor(private readonly inputs: ConnectionInputs) {
    this.secure = new SecureChannel({
      sessionId: inputs.sessionId,
      macDeviceId: inputs.macDeviceId,
      expectedMacIdentityPublicKey: inputs.expectedMacIdentityPublicKey,
      handshakeMode: inputs.handshakeMode,
      phoneIdentity: inputs.phoneIdentity,
      lastAppliedBridgeOutboundSeq: inputs.lastAppliedBridgeOutboundSeq,
      sendWireText: (text) => this.socket.send(text),
      onApplicationPayload: (text) => {
        inputs.onApplicationPayload?.(text);
        this.rpc.handleIncomingPayload(text);
      },
      onBridgeOutboundSeq: (seq) => inputs.onBridgeOutboundSeq?.(seq),
      onChannelClosed: (reason) => this.transitionStatus({ kind: "closed", reason }),
    });

    this.rpc = new JsonRpcClient(
      { send: (payloadText) => this.secure.sendApplicationPayload(payloadText) },
      { onLatencySample: inputs.onLatencySample }
    );

    this.socket = new RelaySocket(buildRelayUrl(inputs.relayUrl, inputs.sessionId), {
      onOpen: () => this.handleSocketOpen(),
      onMessage: (text) => this.secure.handleIncomingWireText(text),
      onClose: ({ code, reason }) => this.handleSocketClose(code, reason),
      onError: (error) => log.warn("socket error", error),
    });
  }

  connect(): void {
    if (this.status.kind === "connecting" || this.status.kind === "open" || this.status.kind === "handshaking") return;
    this.transitionStatus({ kind: "connecting" });
    this.socket.connect();
  }

  close(reason = "client_close"): void {
    this.secure.close(reason);
    this.socket.close(1000, reason);
    this.rpc.rejectAllPending(new Error(`connection closed: ${reason}`));
    this.transitionStatus({ kind: "closed", reason });
  }

  private async handleSocketOpen(): Promise<void> {
    this.transitionStatus({ kind: "handshaking" });
    try {
      await this.secure.runHandshake();
      this.transitionStatus({ kind: "open" });
    } catch (error) {
      const remote = error as SecureHandshakeError;
      this.transitionStatus({ kind: "error", message: remote.message, code: remote.code });
      this.socket.close(1000, "handshake_failed");
    }
  }

  private handleSocketClose(code: number, reason: string): void {
    if (this.status.kind === "closed" || this.status.kind === "error") return;
    this.rpc.rejectAllPending(new Error(`relay closed: ${reason || code}`));
    this.transitionStatus({ kind: "closed", reason: reason || `code_${code}` });
  }

  private transitionStatus(next: ConnectionStatus): void {
    this.status = next;
    this.inputs.onStatus(next);
  }
}
