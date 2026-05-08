import { describe, expect, it } from "vitest";
import { validatePairingInput } from "../src/protocol/pairing";

const validPayload = {
  v: 2,
  relay: "wss://relay.example/relay",
  sessionId: "11111111-1111-1111-1111-111111111111",
  macDeviceId: "22222222-2222-2222-2222-222222222222",
  macIdentityPublicKey: "AAAA",
  expiresAt: Date.now() + 60_000,
};

describe("validatePairingInput", () => {
  it("accepts a fresh JSON payload", () => {
    const result = validatePairingInput(JSON.stringify(validPayload));
    expect(result.kind).toBe("payload");
  });

  it("rejects a payload with a wrong version as bridge-update-required", () => {
    const result = validatePairingInput(JSON.stringify({ ...validPayload, v: 1 }));
    expect(result.kind).toBe("bridgeUpdateRequired");
  });

  it("rejects an expired payload", () => {
    const result = validatePairingInput(JSON.stringify({ ...validPayload, expiresAt: Date.now() - 5 * 60_000 }));
    expect(result.kind).toBe("error");
  });

  it("decodes RMX1: tokens before parsing JSON", () => {
    const json = JSON.stringify(validPayload);
    const tokenBody = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const result = validatePairingInput(`RMX1:${tokenBody}`);
    expect(result.kind).toBe("payload");
  });

  it("classifies a short pairing code", () => {
    const result = validatePairingInput("ABCD2345");
    expect(result.kind).toBe("shortCode");
  });

  it("rejects gibberish", () => {
    expect(validatePairingInput("hello there").kind).toBe("error");
  });
});
