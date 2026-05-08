import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairingCodeResolveError, resolvePairingCode } from "../src/protocol/pairing-code";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
});

describe("resolvePairingCode", () => {
  it("normalizes the code (uppercase, strips spaces and dashes) and POSTs to /v1/pairing/code/resolve", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          ok: true,
          v: 2,
          relay: "wss://relay.example.com",
          sessionId: "session-id",
          macDeviceId: "mac-id",
          macIdentityPublicKey: "key",
          expiresAt: 9999999999999,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const payload = await resolvePairingCode({ relayUrl: "wss://relay.example.com", code: "ab12-cdef-34" });
    expect(payload.macDeviceId).toBe("mac-id");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("https://relay.example.com/v1/pairing/code/resolve");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init?.body as string) as { code: string };
    expect(body.code).toBe("AB12CDEF34");
  });

  it("falls through from /relay-prefixed path to /v1/...", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (input) => {
      calls += 1;
      const url = String(input);
      if (url.includes("/sub/v1/")) return new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({
          ok: true,
          v: 2,
          relay: "wss://relay.example.com/sub/relay",
          sessionId: "s",
          macDeviceId: "m",
          macIdentityPublicKey: "k",
          expiresAt: 9999999999999,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const payload = await resolvePairingCode({
      relayUrl: "wss://relay.example.com/sub/relay",
      code: "ABCDEFGH",
    });
    expect(payload.sessionId).toBe("s");
    expect(calls).toBe(2);
  });

  it("surfaces a friendly message for pairing_code_expired", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "pairing_code_expired" }), {
          status: 410,
          headers: { "content-type": "application/json" },
        })
    ) as unknown as typeof fetch;
    await expect(
      resolvePairingCode({ relayUrl: "wss://r.example.com", code: "ABCDEFGH" })
    ).rejects.toMatchObject({
      message: expect.stringContaining("expired"),
      code: "pairing_code_expired",
    });
  });

  it("rejects empty / malformed codes locally without hitting the network", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(resolvePairingCode({ relayUrl: "wss://r", code: "  " })).rejects.toBeInstanceOf(
      PairingCodeResolveError
    );
    expect(calls).toBe(0);
  });
});
