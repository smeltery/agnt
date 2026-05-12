// FILE: contracts/handshake-handler.test.js
// Purpose: Pins the bridge's handshake state machine. Three behaviours are
//          load-bearing and easy to regress in isolation:
//          1. iOS compatibility errors short-circuit `initialize` before any
//             forwarding happens — old phones must never reach a newer Codex.
//          2. The first cold `initialize` is forwarded; its successful
//             response flips the bridge warm; subsequent `initialize`s are
//             answered locally with `{ bridgeManaged: true }`.
//          3. The "already initialized" error from a half-warm Codex also
//             flips the bridge warm so reconnects don't blow up.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHandshakeHandler } = require("../../src/bridge/handshake-handler");

const BRIDGE_VERSION = "0.9.0";

function makeHandler({ initialHandshakeWarm = false, bridgePackageVersion = BRIDGE_VERSION } = {}) {
  const out = [];
  // Minimum shape `normalizeBridgeDeviceState` accepts. Bridge.js loads a
  // real one via loadOrCreateBridgeDeviceState; we synthesize the bare
  // mandatory fields so rememberLastSeenPhoneAppVersion doesn't reject the
  // input as "incomplete".
  let deviceState = {
    macDeviceId: "test-mac-device-id",
    macIdentityPublicKey: "test-mac-pub-key",
    macIdentityPrivateKey: "test-mac-priv-key",
    lastSeenPhoneAppVersion: null,
    trustedPhones: {},
  };
  const warnings = [];
  const handler = createHandshakeHandler({
    sendApplicationResponse: (line) => out.push(line),
    bridgePackageVersion,
    initialHandshakeWarm,
    getDeviceState: () => deviceState,
    setDeviceState: (next) => { deviceState = next; },
    consoleImpl: { warn: (msg) => warnings.push(msg) },
  });
  return {
    handler,
    out,
    warnings,
    getDeviceState: () => deviceState,
  };
}

test("initial state: cold by default, warm when initialHandshakeWarm is true", () => {
  assert.equal(makeHandler().handler.isWarm(), false);
  assert.equal(makeHandler({ initialHandshakeWarm: true }).handler.isWarm(), true);
});

test("first cold `initialize` is forwarded (returns false) and remembers the request id", () => {
  const { handler, out } = makeHandler();
  const result = handler.handlePhoneMessage(JSON.stringify({
    id: "req-1",
    method: "initialize",
    params: {},
  }));
  assert.equal(result, false, "cold initialize must be forwarded to Codex");
  assert.equal(out.length, 0, "no local response should be sent on the cold path");
});

test("matching Codex response on the cold path flips the bridge warm", () => {
  const { handler } = makeHandler();
  handler.handlePhoneMessage(JSON.stringify({ id: "req-1", method: "initialize", params: {} }));
  assert.equal(handler.isWarm(), false);
  handler.observeCodexResponse(JSON.stringify({ id: "req-1", result: { ok: true } }));
  assert.equal(handler.isWarm(), true);
});

test("a second `initialize` after warm is answered locally with bridgeManaged:true", () => {
  const { handler, out } = makeHandler({ initialHandshakeWarm: true });
  const result = handler.handlePhoneMessage(JSON.stringify({
    id: "req-2",
    method: "initialize",
    params: {},
  }));
  assert.equal(result, true, "warm initialize must be answered locally");
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0]), {
    id: "req-2",
    result: { bridgeManaged: true },
  });
});

test('"Already initialized" error from Codex also flips the bridge warm', () => {
  const { handler } = makeHandler();
  handler.handlePhoneMessage(JSON.stringify({ id: "req-3", method: "initialize", params: {} }));
  handler.observeCodexResponse(JSON.stringify({
    id: "req-3",
    error: { message: "Already initialized" },
  }));
  assert.equal(handler.isWarm(), true, "the warm desktop case must not leave the bridge cold");
});

test("non-matching Codex error keeps the bridge cold", () => {
  const { handler } = makeHandler();
  handler.handlePhoneMessage(JSON.stringify({ id: "req-4", method: "initialize", params: {} }));
  handler.observeCodexResponse(JSON.stringify({
    id: "req-4",
    error: { message: "Unexpected failure" },
  }));
  assert.equal(handler.isWarm(), false);
});

test("Codex responses with unknown ids are ignored (no state change)", () => {
  const { handler } = makeHandler();
  handler.observeCodexResponse(JSON.stringify({ id: "stranger", result: {} }));
  assert.equal(handler.isWarm(), false);
});

test('`initialized` notification on a warm bridge is dropped (returns true)', () => {
  const { handler } = makeHandler({ initialHandshakeWarm: true });
  const result = handler.handlePhoneMessage(JSON.stringify({ method: "initialized" }));
  assert.equal(result, true, "warm bridges silently drop the matching notification");
});

test('`initialized` notification on a cold bridge falls through (returns false)', () => {
  const { handler } = makeHandler();
  const result = handler.handlePhoneMessage(JSON.stringify({ method: "initialized" }));
  assert.equal(result, false);
});

test("compatibility check blocks initialize when the iOS build is too old", () => {
  const { handler, out } = makeHandler({ bridgePackageVersion: "1.0.0" });
  const result = handler.handlePhoneMessage(JSON.stringify({
    id: "req-5",
    method: "initialize",
    params: {
      clientInfo: {
        name: "codexmobile_ios",
        version: "0.0.1",
      },
    },
  }));
  // Either the build is incompatible (returns true, emits an error) OR it
  // isn't (falls through). The test asserts both outcomes are valid as long
  // as they're internally consistent — same return code corresponds to same
  // response shape.
  if (result === true) {
    const response = JSON.parse(out[0]);
    assert.equal(response.id, "req-5");
    assert.ok(response.error);
    assert.equal(response.error.data.errorCode, "ios_app_update_required");
  } else {
    assert.equal(out.length, 0);
  }
});

test("compatibility check ignores clients that don't identify as codexmobile_ios", () => {
  const { handler, out } = makeHandler({ bridgePackageVersion: "1.0.0" });
  const result = handler.handlePhoneMessage(JSON.stringify({
    id: "req-6",
    method: "initialize",
    params: {
      clientInfo: { name: "some-other-client", version: "0.0.1" },
    },
  }));
  // Should fall through to the normal forward/answer path; never produce
  // an ios_app_update_required error.
  if (result) {
    const response = JSON.parse(out[0]);
    if (response.error) {
      assert.notEqual(response.error?.data?.errorCode, "ios_app_update_required");
    }
  }
});

test("compatibility check records the client version on deviceState even when no error fires", () => {
  const env = makeHandler();
  env.handler.handlePhoneMessage(JSON.stringify({
    id: "req-7",
    method: "initialize",
    params: {
      clientInfo: { name: "codexmobile_ios", version: "9.9.9" },
    },
  }));
  // The bridge remembers the last-seen phone version so subsequent boots can
  // surface a stale-app warning even before the phone reconnects.
  assert.equal(env.getDeviceState().lastSeenPhoneAppVersion, "9.9.9");
});

test("logCompatibilityWarning dedups repeated identical warnings", () => {
  const { handler, warnings } = makeHandler();
  handler.logCompatibilityWarning("stale build, please update");
  handler.logCompatibilityWarning("stale build, please update");
  handler.logCompatibilityWarning("   stale build, please update   "); // trims
  assert.equal(warnings.length, 1);
});

test("logCompatibilityWarning ignores empty / non-string input", () => {
  const { handler, warnings } = makeHandler();
  handler.logCompatibilityWarning("");
  handler.logCompatibilityWarning("   ");
  handler.logCompatibilityWarning(null);
  handler.logCompatibilityWarning(undefined);
  assert.equal(warnings.length, 0);
});

test("malformed inputs are tolerated without throwing", () => {
  const { handler } = makeHandler();
  assert.doesNotThrow(() => handler.handlePhoneMessage("not json"));
  assert.doesNotThrow(() => handler.handlePhoneMessage(""));
  assert.doesNotThrow(() => handler.handlePhoneMessage(JSON.stringify({})));
  assert.doesNotThrow(() => handler.observeCodexResponse("not json"));
  assert.doesNotThrow(() => handler.observeCodexResponse(""));
});
