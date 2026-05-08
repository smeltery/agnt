// Drives the client side of the agnt secure handshake and en/decrypts JSON-RPC frames.
// Faithful TS port of CodexService+SecureTransport.swift (`performSecureHandshake`,
// `secureWireText`, `handleEncryptedEnvelopeText`).
//
// The class is intentionally transport-agnostic: it does NOT know about WebSockets.
// The caller wires it up by piping incoming text in via `handleIncomingWireText` and
// providing a `sendWireText` callback. That keeps the handshake pure and unit-testable.

import {
  buildClientAuthTranscript,
  buildHandshakeTranscript,
  bytesToBase64,
  deriveDirectionalKeys,
  deriveSharedSecret,
  EncryptedEnvelope,
  generateEphemeralKeyPair,
  HandshakeMode,
  openEnvelope,
  PhoneIdentity,
  SECURE_PROTOCOL_VERSION,
  sealEnvelope,
  signWithPhoneIdentity,
  utf8ToBytes,
  verifyMacSignature,
} from "../crypto";
import { createDeferred, withTimeout } from "../lib/deferred";
import { makeLogger } from "../lib/log";
import type { SecureErrorMessage, SecureReadyMessage, ServerHelloMessage } from "./types";

const log = makeLogger("secure");
const HANDSHAKE_TIMEOUT_MS = 12_000;

export class SecureHandshakeError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = "SecureHandshakeError";
  }
}

export interface SecureChannelInputs {
  sessionId: string;
  macDeviceId: string;
  expectedMacIdentityPublicKey: string; // from saved pairing or trusted-mac record
  handshakeMode: HandshakeMode;
  phoneIdentity: PhoneIdentity;
  lastAppliedBridgeOutboundSeq?: number;
  sendWireText: (text: string) => boolean;
  onApplicationPayload: (payloadText: string) => void;
  onBridgeOutboundSeq?: (seq: number) => void;
  onChannelClosed?: (reason: string) => void;
}

interface ActiveSession {
  sessionId: string;
  keyEpoch: number;
  phoneToMacKey: Uint8Array;
  macToPhoneKey: Uint8Array;
  lastInboundCounter: number;
  nextOutboundCounter: number;
  lastAppliedBridgeOutboundSeq: number;
}

export class SecureChannel {
  private active: ActiveSession | null = null;
  private serverHelloWaiter: ReturnType<typeof createDeferred<ServerHelloMessage>> | null = null;
  private secureReadyWaiter: ReturnType<typeof createDeferred<SecureReadyMessage>> | null = null;
  private state: "idle" | "handshaking" | "open" | "closed" = "idle";

  constructor(private readonly inputs: SecureChannelInputs) {}

  get isOpen(): boolean {
    return this.state === "open" && this.active !== null;
  }

  /**
   * Drive the entire client handshake to completion: clientHello → serverHello →
   * verify → clientAuth → secureReady → resumeState. Throws SecureHandshakeError
   * on any failure; caller should drop the WebSocket.
   */
  async runHandshake(): Promise<void> {
    if (this.state !== "idle") throw new SecureHandshakeError("handshake already started", "already_started");
    this.state = "handshaking";

    const ephemeral = generateEphemeralKeyPair();
    const clientNonce = crypto.getRandomValues(new Uint8Array(32));
    const clientNonceBase64 = bytesToBase64(clientNonce);

    this.serverHelloWaiter = createDeferred<ServerHelloMessage>();
    this.send({
      kind: "clientHello",
      protocolVersion: SECURE_PROTOCOL_VERSION,
      sessionId: this.inputs.sessionId,
      handshakeMode: this.inputs.handshakeMode,
      phoneDeviceId: this.inputs.phoneIdentity.phoneDeviceId,
      phoneIdentityPublicKey: this.inputs.phoneIdentity.phoneIdentityPublicKey,
      phoneEphemeralPublicKey: bytesToBase64(ephemeral.publicKey),
      clientNonce: clientNonceBase64,
    });

    const serverHello = await this.awaitMatchingServerHello(clientNonceBase64);
    this.assertServerHelloShape(serverHello);

    const serverNonce = base64Or32ZeroBytes(serverHello.serverNonce);
    const transcript = buildHandshakeTranscript({
      sessionId: this.inputs.sessionId,
      protocolVersion: serverHello.protocolVersion,
      handshakeMode: serverHello.handshakeMode,
      keyEpoch: serverHello.keyEpoch,
      macDeviceId: serverHello.macDeviceId,
      phoneDeviceId: this.inputs.phoneIdentity.phoneDeviceId,
      macIdentityPublicKey: serverHello.macIdentityPublicKey,
      phoneIdentityPublicKey: this.inputs.phoneIdentity.phoneIdentityPublicKey,
      macEphemeralPublicKey: serverHello.macEphemeralPublicKey,
      phoneEphemeralPublicKey: bytesToBase64(ephemeral.publicKey),
      clientNonce,
      serverNonce,
      expiresAtForTranscript: serverHello.expiresAtForTranscript,
    });

    if (!verifyMacSignature(serverHello.macIdentityPublicKey, transcript, serverHello.macSignature)) {
      throw new SecureHandshakeError("Mac signature could not be verified.", "invalid_mac_signature");
    }

    const clientAuthTranscript = buildClientAuthTranscript(transcript);
    const phoneSignature = signWithPhoneIdentity(this.inputs.phoneIdentity, clientAuthTranscript);

    this.secureReadyWaiter = createDeferred<SecureReadyMessage>();
    this.send({
      kind: "clientAuth",
      sessionId: this.inputs.sessionId,
      phoneDeviceId: this.inputs.phoneIdentity.phoneDeviceId,
      keyEpoch: serverHello.keyEpoch,
      phoneSignature,
    });

    await this.awaitMatchingSecureReady(serverHello.keyEpoch);

    const sharedSecret = deriveSharedSecret(ephemeral.privateKey, serverHello.macEphemeralPublicKey);
    const keys = deriveDirectionalKeys({
      sharedSecret,
      transcript,
      sessionId: this.inputs.sessionId,
      macDeviceId: serverHello.macDeviceId,
      phoneDeviceId: this.inputs.phoneIdentity.phoneDeviceId,
      keyEpoch: serverHello.keyEpoch,
    });

    this.active = {
      sessionId: serverHello.sessionId,
      keyEpoch: serverHello.keyEpoch,
      phoneToMacKey: keys.phoneToMacKey,
      macToPhoneKey: keys.macToPhoneKey,
      lastInboundCounter: -1,
      nextOutboundCounter: 0,
      lastAppliedBridgeOutboundSeq: this.inputs.lastAppliedBridgeOutboundSeq ?? 0,
    };

    this.send({
      kind: "resumeState",
      sessionId: this.inputs.sessionId,
      keyEpoch: serverHello.keyEpoch,
      lastAppliedBridgeOutboundSeq: this.active.lastAppliedBridgeOutboundSeq,
    });

    this.state = "open";
    log.debug("handshake complete keyEpoch=", serverHello.keyEpoch);
  }

  /** Encrypt and send a JSON-RPC payload over the secured channel. */
  sendApplicationPayload(payloadText: string): void {
    if (!this.active) throw new SecureHandshakeError("Secure channel is not open.", "channel_not_open");
    const envelope = sealEnvelope(
      { payloadText },
      this.active.phoneToMacKey,
      "iphone",
      this.active.nextOutboundCounter,
      this.active.sessionId,
      this.active.keyEpoch
    );
    this.active.nextOutboundCounter += 1;
    this.send(envelope);
  }

  /** Demux raw relay text into control messages and decrypted application payloads. */
  handleIncomingWireText(text: string): void {
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed !== "object") return;
    const kind = (parsed as { kind?: unknown }).kind;
    switch (kind) {
      case "serverHello":
        this.serverHelloWaiter?.resolve(parsed as ServerHelloMessage);
        return;
      case "secureReady":
        this.secureReadyWaiter?.resolve(parsed as SecureReadyMessage);
        return;
      case "secureError":
        this.failPending(parsed as SecureErrorMessage);
        return;
      case "encryptedEnvelope":
        this.handleEncryptedEnvelope(parsed as EncryptedEnvelope);
        return;
      default:
        return;
    }
  }

  close(reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.active = null;
    this.serverHelloWaiter?.reject(new SecureHandshakeError(reason, "channel_closed"));
    this.secureReadyWaiter?.reject(new SecureHandshakeError(reason, "channel_closed"));
    this.inputs.onChannelClosed?.(reason);
  }

  private send(message: object): void {
    const json = JSON.stringify(message);
    if (!this.inputs.sendWireText(json)) {
      throw new SecureHandshakeError("Relay socket is not open.", "socket_not_open");
    }
  }

  private async awaitMatchingServerHello(expectedClientNonce: string): Promise<ServerHelloMessage> {
    while (true) {
      const waiter = this.serverHelloWaiter ?? createDeferred<ServerHelloMessage>();
      this.serverHelloWaiter = waiter;
      const hello = await withTimeout(waiter.promise, HANDSHAKE_TIMEOUT_MS, "Timed out waiting for serverHello.");
      this.serverHelloWaiter = null;
      // Stale relays may flush previous handshake's serverHello. Match on echoed nonce.
      if (hello.clientNonce && hello.clientNonce !== expectedClientNonce) {
        log.warn("discarding stale serverHello (clientNonce mismatch)");
        continue;
      }
      return hello;
    }
  }

  private async awaitMatchingSecureReady(expectedKeyEpoch: number): Promise<void> {
    while (true) {
      const waiter = this.secureReadyWaiter ?? createDeferred<SecureReadyMessage>();
      this.secureReadyWaiter = waiter;
      const ready = await withTimeout(waiter.promise, HANDSHAKE_TIMEOUT_MS, "Timed out waiting for secureReady.");
      this.secureReadyWaiter = null;
      if (ready.sessionId !== this.inputs.sessionId || ready.keyEpoch !== expectedKeyEpoch) {
        log.warn("discarding stale secureReady");
        continue;
      }
      return;
    }
  }

  private assertServerHelloShape(hello: ServerHelloMessage): void {
    if (hello.protocolVersion !== SECURE_PROTOCOL_VERSION) {
      throw new SecureHandshakeError("Bridge uses an incompatible secure transport version.", "incompatible_version");
    }
    if (hello.sessionId !== this.inputs.sessionId) {
      throw new SecureHandshakeError("Bridge session ID did not match the saved pairing.", "session_mismatch");
    }
    if (hello.macDeviceId !== this.inputs.macDeviceId) {
      throw new SecureHandshakeError("Bridge reported a different Mac identity for this session.", "mac_mismatch");
    }
    if (hello.macIdentityPublicKey !== this.inputs.expectedMacIdentityPublicKey) {
      throw new SecureHandshakeError("Mac identity key did not match the paired device.", "mac_key_mismatch");
    }
  }

  private handleEncryptedEnvelope(envelope: EncryptedEnvelope): void {
    if (!this.active) return;
    if (
      envelope.sessionId !== this.active.sessionId ||
      envelope.keyEpoch !== this.active.keyEpoch ||
      envelope.sender !== "mac" ||
      envelope.counter <= this.active.lastInboundCounter
    ) {
      log.warn("rejecting invalid envelope", envelope.counter, this.active.lastInboundCounter);
      return;
    }
    let plaintext: Uint8Array;
    try {
      plaintext = openEnvelope(envelope, this.active.macToPhoneKey);
    } catch (error) {
      log.error("decrypt failed", error);
      this.close("decrypt_failed");
      return;
    }
    this.active.lastInboundCounter = envelope.counter;
    const payload = safeJsonParse(new TextDecoder().decode(plaintext));
    if (!payload || typeof payload !== "object") return;
    const text = (payload as { payloadText?: unknown }).payloadText;
    if (typeof text !== "string" || !text) return;

    const seq = (payload as { bridgeOutboundSeq?: unknown }).bridgeOutboundSeq;
    if (typeof seq === "number" && Number.isFinite(seq)) {
      if (seq <= this.active.lastAppliedBridgeOutboundSeq) return;
      this.active.lastAppliedBridgeOutboundSeq = seq;
      this.inputs.onBridgeOutboundSeq?.(seq);
    }
    this.inputs.onApplicationPayload(text);
  }

  private failPending(error: SecureErrorMessage): void {
    const handshakeError = new SecureHandshakeError(error.message || "secure error", error.code);
    this.serverHelloWaiter?.reject(handshakeError);
    this.secureReadyWaiter?.reject(handshakeError);
    this.serverHelloWaiter = null;
    this.secureReadyWaiter = null;
    this.close(error.code || "secure_error");
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function base64Or32ZeroBytes(value: string | undefined): Uint8Array {
  if (!value) return new Uint8Array(32);
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(32);
  }
}

// Re-exported for callers that want to derive a fresh transcript without re-reading the
// crypto module. Keeps the protocol layer the single import surface for higher layers.
export { utf8ToBytes };
