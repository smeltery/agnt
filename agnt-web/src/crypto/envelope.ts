// Encrypted envelope crypto: AES-256-GCM with a 12-byte direction-tagged nonce.
// Mirrors agnt-bridge/src/secure-transport.js encryptEnvelopePayload / decryptEnvelopeBuffer
// and CodexService+SecureTransport.swift secureWireText / handleEncryptedEnvelopeText.

import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { base64ToBytes, bytesToBase64, utf8ToBytes } from "./encoding";
import { HANDSHAKE_TAG, SECURE_PROTOCOL_VERSION } from "./transcript";

export type EnvelopeSender = "mac" | "iphone";

export interface EncryptedEnvelope {
  kind: "encryptedEnvelope";
  v: number;
  sessionId: string;
  keyEpoch: number;
  sender: EnvelopeSender;
  counter: number;
  ciphertext: string;
  tag: string;
}

// 12-byte nonce: byte[0] = direction (1=mac, 2=iphone), bytes[1..11] = big-endian counter.
// Matches bridge nonceForDirection and iOS codexSecureNonce.
export function nonceForDirection(sender: EnvelopeSender, counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce[0] = sender === "mac" ? 1 : 2;
  let value = BigInt(counter);
  for (let index = 11; index >= 1; index -= 1) {
    nonce[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return nonce;
}

export interface DirectionalKeys {
  phoneToMacKey: Uint8Array; // 32 bytes — phone encrypts outbound with this
  macToPhoneKey: Uint8Array; // 32 bytes — phone decrypts inbound with this
}

export interface KeyDerivationInput {
  sharedSecret: Uint8Array;
  transcript: Uint8Array;
  sessionId: string;
  macDeviceId: string;
  phoneDeviceId: string;
  keyEpoch: number;
}

// HKDF-SHA256 with salt = SHA256(transcript) and info per direction.
// Bridge: deriveAesKey(sharedSecret, sha256(transcript), `${infoPrefix}|{phoneToMac|macToPhone}`)
export function deriveDirectionalKeys(input: KeyDerivationInput): DirectionalKeys {
  const salt = sha256(input.transcript);
  const infoPrefix = [HANDSHAKE_TAG, input.sessionId, input.macDeviceId, input.phoneDeviceId, String(input.keyEpoch)].join("|");
  return {
    phoneToMacKey: hkdf(sha256, input.sharedSecret, salt, utf8ToBytes(`${infoPrefix}|phoneToMac`), 32),
    macToPhoneKey: hkdf(sha256, input.sharedSecret, salt, utf8ToBytes(`${infoPrefix}|macToPhone`), 32),
  };
}

// AES-256-GCM seal. The Noble GCM implementation appends the 16-byte auth tag to the
// ciphertext output, but the wire format keeps them in separate base64 fields.
export function sealEnvelope(
  payload: object,
  key: Uint8Array,
  sender: EnvelopeSender,
  counter: number,
  sessionId: string,
  keyEpoch: number
): EncryptedEnvelope {
  const nonce = nonceForDirection(sender, counter);
  const plaintext = utf8ToBytes(JSON.stringify(payload));
  const sealed = gcm(key, nonce).encrypt(plaintext);
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  return {
    kind: "encryptedEnvelope",
    v: SECURE_PROTOCOL_VERSION,
    sessionId,
    keyEpoch,
    sender,
    counter,
    ciphertext: bytesToBase64(ciphertext),
    tag: bytesToBase64(tag),
  };
}

export function openEnvelope(envelope: EncryptedEnvelope, key: Uint8Array): Uint8Array {
  const nonce = nonceForDirection(envelope.sender, envelope.counter);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const tag = base64ToBytes(envelope.tag);
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext, 0);
  sealed.set(tag, ciphertext.length);
  return gcm(key, nonce).decrypt(sealed);
}
