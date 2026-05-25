// Phone identity: long-lived Ed25519 keypair plus a UUID device id.
// Generated once per browser profile, reused across reconnects.
// Mirrors codexPhoneIdentityState in CodexSecureTransportModels.swift.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { base64ToBytes, bytesToBase64 } from "./encoding";

export interface PhoneIdentity {
  phoneDeviceId: string;
  phoneIdentityPrivateKey: string; // base64 raw 32-byte seed
  phoneIdentityPublicKey: string; // base64 raw 32-byte public key
}

export function generatePhoneIdentity(): PhoneIdentity {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    phoneDeviceId: crypto.randomUUID(),
    phoneIdentityPrivateKey: bytesToBase64(privateKey),
    phoneIdentityPublicKey: bytesToBase64(publicKey),
  };
}

export function signWithPhoneIdentity(identity: PhoneIdentity, message: Uint8Array): string {
  const privateKey = base64ToBytes(identity.phoneIdentityPrivateKey);
  const signature = ed25519.sign(message, privateKey);
  return bytesToBase64(signature);
}

export function verifyMacSignature(
  macIdentityPublicKey: string,
  message: Uint8Array,
  signatureBase64: string
): boolean {
  try {
    return ed25519.verify(base64ToBytes(signatureBase64), message, base64ToBytes(macIdentityPublicKey));
  } catch {
    return false;
  }
}

// Ephemeral X25519 keypair for the per-handshake ECDH exchange.
// One pair per handshake; never reused.
export interface EphemeralKeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function deriveSharedSecret(
  ephemeralPrivateKey: Uint8Array,
  macEphemeralPublicKeyBase64: string
): Uint8Array {
  return x25519.getSharedSecret(ephemeralPrivateKey, base64ToBytes(macEphemeralPublicKeyBase64));
}
