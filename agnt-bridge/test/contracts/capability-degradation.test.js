// FILE: contracts/capability-degradation.test.js
// Purpose: Verifies that the no-op desktop refresher tolerates every hook the
//          live refresher exposes, and that the documented provider
//          capabilities (desktopRefresher, rolloutMirror) only resolve true
//          for Codex.
// Layer: Contract test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../../src/bridge, ../../src/providers
//
// The guardrail (CLAUDE.md): "When a capability is absent (e.g.
// `desktopRefresher`, `rolloutMirror`), gate the codepath on
// `provider.capabilities.<flag>` and degrade gracefully (no-op refresher,
// skip mirror watcher) instead of crashing." The bridge swaps in
// `createNoopDesktopRefresher()` when the active provider does not expose a
// refresher; that no-op must implement the same surface the live refresher
// does, or bridge call sites will throw.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createNoopDesktopRefresher } = require("../../src/bridge/bridge");
const { listProviders, getProvider } = require("../../src/providers/index");

test("createNoopDesktopRefresher implements every hook the bridge call sites invoke", () => {
  const noop = createNoopDesktopRefresher();
  // Method names mirror the bridge.js call sites
  // (handleTransportReset / handleOutbound / handleInbound / handleFollowerStateChanged).
  for (const method of ["handleInbound", "handleOutbound", "handleTransportReset", "handleFollowerStateChanged"]) {
    assert.equal(
      typeof noop[method],
      "function",
      `noop refresher must expose ${method} to match bridge expectations`,
    );
  }
});

test("createNoopDesktopRefresher returns undefined and never throws on any payload", () => {
  const noop = createNoopDesktopRefresher();
  // Bridge call sites pass raw relay payloads — strings, malformed JSON,
  // null, and unexpected types must all be tolerated silently.
  const payloads = [
    "",
    "{}",
    "{ not json",
    JSON.stringify({ method: "thread/start" }),
    null,
    undefined,
    42,
    { method: "thread/started" },
  ];
  for (const payload of payloads) {
    assert.equal(noop.handleInbound(payload), undefined);
    assert.equal(noop.handleOutbound(payload), undefined);
  }
  assert.equal(noop.handleTransportReset(), undefined);
  assert.equal(noop.handleFollowerStateChanged("thread-1", true), undefined);
});

test("only Codex declares rolloutMirror=true; every other registered provider opts out", () => {
  // Mirroring requires a vendor-specific rollout file format; the guardrail
  // ("rolloutMirror: true is a Codex-only capability") is enforced here so
  // future providers cannot quietly opt in without explicit review.
  for (const provider of listProviders()) {
    const expected = provider.id === "codex";
    assert.equal(
      Boolean(provider.capabilities?.rolloutMirror),
      expected,
      `provider ${provider.id} rolloutMirror must be ${expected}`,
    );
  }
});

test("only Codex declares desktopRefresher=true; every other registered provider opts out", () => {
  for (const provider of listProviders()) {
    const expected = provider.id === "codex";
    assert.equal(
      Boolean(provider.capabilities?.desktopRefresher),
      expected,
      `provider ${provider.id} desktopRefresher must be ${expected}`,
    );
  }
});

test("non-Codex providers do not export createDesktopRefresher", () => {
  // If a non-Codex provider exposes createDesktopRefresher, the bridge will
  // still call createNoopDesktopRefresher() because the capability flag is
  // false — but the leftover factory is a smell. Catch it.
  for (const id of ["claude", "opencode", "cursor"]) {
    const provider = getProvider(id);
    assert.equal(
      typeof provider.createDesktopRefresher,
      "undefined",
      `provider ${id} must not expose createDesktopRefresher when capability is off`,
    );
  }
});

test("provider capabilities expose exactly the documented set of boolean flags", () => {
  // providers/types.js documents the capability surface. New flags must be
  // declared on every provider (true or false) so consumers do not need to
  // branch on `capability?.foo` everywhere. Catch unintentional omissions.
  const { PROVIDER_CAPABILITY_KEYS } = require("../../src/providers/types");
  for (const provider of listProviders()) {
    const caps = provider.capabilities || {};
    for (const key of PROVIDER_CAPABILITY_KEYS) {
      assert.equal(
        typeof caps[key],
        "boolean",
        `provider ${provider.id} must declare capability "${key}" as a boolean`,
      );
    }
  }
});
