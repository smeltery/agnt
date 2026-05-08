// Byte/text encoding helpers shared by the TS port of the agnt secure transport.
// Every helper here mirrors the bridge's secure-transport.js so transcripts hash identically.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8ToBytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Length-prefixed buffer: 4-byte big-endian length followed by the bytes.
// Bridge equivalent: encodeLengthPrefixedBuffer / encodeLengthPrefixedUTF8.
export function lengthPrefixed(value: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + value.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, value.length, false);
  out.set(value, 4);
  return out;
}

export function lengthPrefixedUtf8(value: string): Uint8Array {
  return lengthPrefixed(utf8ToBytes(value));
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Build a binary string in chunks to avoid blowing the call stack on large inputs.
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(normalizeBase64(value));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// Accepts both standard and URL-safe base64; tolerates missing padding.
function normalizeBase64(value: string): string {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padding = (4 - (normalized.length % 4 || 4)) % 4;
  if (padding) normalized += "=".repeat(padding);
  return normalized;
}
