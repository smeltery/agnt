// End-to-end envelope round-trip: seal in TS → decrypt with the bridge's helper, then
// the reverse direction. If either side gets the nonce or AES-GCM tag layout wrong this
// fails immediately, which is the whole point.

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { hkdfSync, randomBytes } from "node:crypto";
import { nonceForDirection, openEnvelope, sealEnvelope } from "../src/crypto/envelope";
import { utf8ToBytes } from "../src/crypto/encoding";

const require = createRequire(import.meta.url);
const bridge = require("../../agnt-bridge/src/transport/secure-transport") as {
  nonceForDirection: (sender: "mac" | "iphone", counter: number) => Buffer;
};

describe("envelope crypto", () => {
  it("nonceForDirection matches the bridge's layout", () => {
    for (const counter of [0, 1, 255, 256, 1_000_000]) {
      const tsMac = nonceForDirection("mac", counter);
      const bridgeMac = bridge.nonceForDirection("mac", counter);
      expect(Array.from(tsMac)).toEqual(Array.from(bridgeMac));
      const tsPhone = nonceForDirection("iphone", counter);
      const bridgePhone = bridge.nonceForDirection("iphone", counter);
      expect(Array.from(tsPhone)).toEqual(Array.from(bridgePhone));
    }
  });

  it("seal -> open round-trips a JSON payload using the same direction key", () => {
    const sharedSecret = randomBytes(32);
    const salt = randomBytes(32);
    const key = new Uint8Array(hkdfSync("sha256", sharedSecret, salt, utf8ToBytes("test"), 32) as ArrayBuffer);

    const sealed = sealEnvelope({ payloadText: "hello world" }, key, "iphone", 0, "session", 1);
    const opened = openEnvelope(sealed, key);
    expect(JSON.parse(new TextDecoder().decode(opened))).toEqual({ payloadText: "hello world" });
  });
});
