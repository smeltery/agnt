// Wire types shared across the protocol layer. These match what the bridge sends
// over the secure channel; per-method param/result shapes are typed at the call site.

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result: R;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

export type WireKind =
  | "clientHello"
  | "serverHello"
  | "clientAuth"
  | "secureReady"
  | "secureError"
  | "resumeState"
  | "encryptedEnvelope";

export interface SecureErrorMessage {
  kind: "secureError";
  code: string;
  message: string;
}

export interface ServerHelloMessage {
  kind: "serverHello";
  protocolVersion: number;
  sessionId: string;
  handshakeMode: "qr_bootstrap" | "trusted_reconnect";
  macDeviceId: string;
  macIdentityPublicKey: string;
  macEphemeralPublicKey: string;
  serverNonce: string;
  keyEpoch: number;
  expiresAtForTranscript: number;
  macSignature: string;
  clientNonce?: string;
}

export interface SecureReadyMessage {
  kind: "secureReady";
  sessionId: string;
  keyEpoch: number;
  macDeviceId: string;
}
