// Faithful TS port of the agnt secure-transport handshake transcript.
// Mirrors agnt-bridge/src/secure-transport.js:633-664 and
// CodexService+SecureTransportTranscript.swift's codexSecureTranscriptBytes.

import { base64ToBytes, concatBytes, lengthPrefixed, lengthPrefixedUtf8 } from "./encoding";

export const HANDSHAKE_TAG = "agnt-e2ee-v1";
export const SECURE_PROTOCOL_VERSION = 1;
export const PAIRING_QR_VERSION = 2;
export const TRUSTED_SESSION_RESOLVE_TAG = "agnt-trusted-session-resolve-v1";

export type HandshakeMode = "qr_bootstrap" | "trusted_reconnect";

export interface TranscriptInput {
  sessionId: string;
  protocolVersion: number;
  handshakeMode: HandshakeMode;
  keyEpoch: number;
  macDeviceId: string;
  phoneDeviceId: string;
  macIdentityPublicKey: string;
  phoneIdentityPublicKey: string;
  macEphemeralPublicKey: string;
  phoneEphemeralPublicKey: string;
  clientNonce: Uint8Array;
  serverNonce: Uint8Array;
  expiresAtForTranscript: number;
}

export function buildHandshakeTranscript(input: TranscriptInput): Uint8Array {
  return concatBytes(
    lengthPrefixedUtf8(HANDSHAKE_TAG),
    lengthPrefixedUtf8(input.sessionId),
    lengthPrefixedUtf8(String(input.protocolVersion)),
    lengthPrefixedUtf8(input.handshakeMode),
    lengthPrefixedUtf8(String(input.keyEpoch)),
    lengthPrefixedUtf8(input.macDeviceId),
    lengthPrefixedUtf8(input.phoneDeviceId),
    lengthPrefixed(base64ToBytes(input.macIdentityPublicKey)),
    lengthPrefixed(base64ToBytes(input.phoneIdentityPublicKey)),
    lengthPrefixed(base64ToBytes(input.macEphemeralPublicKey)),
    lengthPrefixed(base64ToBytes(input.phoneEphemeralPublicKey)),
    lengthPrefixed(input.clientNonce),
    lengthPrefixed(input.serverNonce),
    lengthPrefixedUtf8(String(input.expiresAtForTranscript))
  );
}

// `client-auth` proof: original transcript + length-prefixed UTF-8 "client-auth" tag.
// Mirrors codexClientAuthTranscript and bridge handleClientAuth.
export function buildClientAuthTranscript(transcript: Uint8Array): Uint8Array {
  return concatBytes(transcript, lengthPrefixedUtf8("client-auth"));
}

export interface TrustedSessionResolveInput {
  macDeviceId: string;
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
  nonce: string;
  timestamp: number;
}

// Mirrors relay.js buildTrustedSessionResolveBytes.
export function buildTrustedSessionResolveTranscript(input: TrustedSessionResolveInput): Uint8Array {
  return concatBytes(
    lengthPrefixedUtf8(TRUSTED_SESSION_RESOLVE_TAG),
    lengthPrefixedUtf8(input.macDeviceId),
    lengthPrefixedUtf8(input.phoneDeviceId),
    lengthPrefixed(base64ToBytes(input.phoneIdentityPublicKey)),
    lengthPrefixedUtf8(input.nonce),
    lengthPrefixedUtf8(String(input.timestamp))
  );
}
