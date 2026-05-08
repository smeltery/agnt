import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, lengthPrefixed, lengthPrefixedUtf8 } from "../src/crypto/encoding";

describe("length-prefixed encoding", () => {
  it("matches the bridge's 4-byte big-endian framing for an empty buffer", () => {
    expect(Array.from(lengthPrefixed(new Uint8Array(0)))).toEqual([0, 0, 0, 0]);
  });

  it("prefixes a UTF-8 string with its byte length", () => {
    const out = Array.from(lengthPrefixedUtf8("agnt-e2ee-v1"));
    expect(out.slice(0, 4)).toEqual([0, 0, 0, 12]);
    expect(out.slice(4)).toEqual([97, 103, 110, 116, 45, 101, 50, 101, 101, 45, 118, 49]);
  });
});

describe("base64 round-trips", () => {
  it("survives random bytes through bytesToBase64 -> base64ToBytes", () => {
    const random = crypto.getRandomValues(new Uint8Array(257));
    expect(Array.from(base64ToBytes(bytesToBase64(random)))).toEqual(Array.from(random));
  });
});
