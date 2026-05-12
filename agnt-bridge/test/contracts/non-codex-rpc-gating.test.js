// FILE: contracts/non-codex-rpc-gating.test.js
// Purpose: Verifies that Codex-only RPCs (account/*, voice/*, getAuthStatus)
//          produce the documented "managed externally" responses for non-Codex
//          providers, so the iOS auth UI never hangs on a never-coming reply.
// Layer: Contract test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../../src/account-handler, ../../src/providers
//
// This is a contract test — it asserts the *shape* of the response the bridge
// emits on behalf of providers that don't implement ChatGPT-style account
// flows. The guardrail lives in CLAUDE.md ("Codex-only RPCs ... are gated on
// activeProvider.id === 'codex' in bridge.js"). Without these tests the bridge
// could silently start forwarding ChatGPT-token-bearing calls to a non-Codex
// provider.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildNonCodexAccountResponse,
  buildNonCodexVoiceTranscribeError,
} = require("../../src/account-handler");
const { getProvider } = require("../../src/providers");

const NON_CODEX_PROVIDER_IDS = ["claude", "opencode", "cursor"];

const READ_LIKE_METHODS = ["account/status/read", "getAuthStatus"];
const SIGNIN_LIKE_METHODS = [
  "account/login/start",
  "account/login/cancel",
  "account/login/openOnMac",
  "account/logout",
];

for (const providerId of NON_CODEX_PROVIDER_IDS) {
  const provider = getProvider(providerId);

  test(`buildNonCodexAccountResponse [${providerId}] reports loggedIn=false + managed-externally for read methods`, () => {
    for (const method of READ_LIKE_METHODS) {
      const out = buildNonCodexAccountResponse(method, provider);
      assert.ok(out.value, `${method} should produce a value`);
      assert.equal(out.error, undefined, `${method} should not produce an error`);
      assert.equal(out.value.loggedIn, false);
      assert.equal(out.value.supportsLogin, false);
      assert.equal(out.value.provider, provider.id);
      assert.equal(out.value.providerName, provider.displayName);
      assert.equal(out.value.authMethod, "external");
      assert.match(
        out.value.message,
        new RegExp(`^${escapeForRegex(provider.displayName)} manages authentication`),
        `${method} message should name the provider`,
      );
    }
  });

  test(`buildNonCodexAccountResponse [${providerId}] returns voice/resolveAuth with unsupported empty token`, () => {
    const out = buildNonCodexAccountResponse("voice/resolveAuth", provider);
    assert.deepEqual(out, { value: { token: "", supported: false } });
  });

  test(`buildNonCodexAccountResponse [${providerId}] returns a tagged not_supported error for sign-in methods`, () => {
    for (const method of SIGNIN_LIKE_METHODS) {
      const out = buildNonCodexAccountResponse(method, provider);
      assert.equal(out.value, undefined, `${method} should not return a value`);
      assert.ok(out.error instanceof Error, `${method} should produce an Error`);
      assert.equal(out.error.errorCode, "not_supported");
      assert.match(
        out.error.message,
        new RegExp(`^${escapeForRegex(provider.displayName)} does not support`),
      );
    }
  });

  test(`buildNonCodexAccountResponse [${providerId}] returns {value:null} for unknown methods`, () => {
    assert.deepEqual(
      buildNonCodexAccountResponse("account/something/new", provider),
      { value: null },
    );
  });

  test(`buildNonCodexVoiceTranscribeError [${providerId}] returns -32601 with provider-tagged data`, () => {
    const out = buildNonCodexVoiceTranscribeError(provider);
    assert.equal(out.error.code, -32601);
    assert.equal(out.error.data.errorCode, "not_supported");
    assert.equal(out.error.data.provider, provider.id);
    assert.match(
      out.error.message,
      new RegExp(`^Voice transcription is not supported with ${escapeForRegex(provider.displayName)}`),
    );
  });
}

test("every non-Codex provider in the registry is covered by the contract", () => {
  // Guard against silently adding a new provider that escapes these checks:
  // if a new entry is registered without being added to NON_CODEX_PROVIDER_IDS,
  // this test fails loudly instead of leaving the gating untested.
  const { listProviders } = require("../../src/providers");
  const registered = listProviders()
    .map((p) => p.id)
    .filter((id) => id !== "codex")
    .sort();
  assert.deepEqual(registered, [...NON_CODEX_PROVIDER_IDS].sort());
});

function escapeForRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
