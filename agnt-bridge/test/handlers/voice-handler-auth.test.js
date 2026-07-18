// FILE: voice-handler-auth.test.js
// Purpose: Verifies voice auth resolution for ChatGPT-backed sessions.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, voice-handler, voice-handler-test-helpers

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveVoiceAuth } = require("../../src/handlers/voice-handler");
const { makeJWT } = require("./voice-handler-test-helpers");

test("resolveVoiceAuth returns token for ChatGPT sessions", async () => {
  const result = await resolveVoiceAuth(async (method, params) => {
    assert.equal(method, "getAuthStatus");
    assert.deepEqual(params, { includeToken: true, refreshToken: true });
    return {
      authMethod: "chatgpt",
      authToken: "chatgpt-token-abc",
      requiresOpenaiAuth: false,
    };
  });

  assert.deepEqual(result, { token: "chatgpt-token-abc" });
});

test("resolveVoiceAuth accepts snake-case ChatGPT auth methods", async () => {
  const result = await resolveVoiceAuth(async () => ({
    authMethod: "chatgpt_auth_tokens",
    authToken: "chatgpt-token-abc",
    requiresOpenaiAuth: true,
  }));

  assert.deepEqual(result, { token: "chatgpt-token-abc" });
});

test("resolveVoiceAuth rejects when no token is available regardless of requiresOpenaiAuth", async () => {
  await assert.rejects(
    () => resolveVoiceAuth(async () => ({
      authMethod: null,
      authToken: null,
      requiresOpenaiAuth: true,
    })),
    (error) => {
      assert.equal(error.errorCode, "token_missing");
      return true;
    }
  );
});

test("resolveVoiceAuth rejects when Mac has no token", async () => {
  await assert.rejects(
    () => resolveVoiceAuth(async () => ({
      authMethod: "chatgpt",
      authToken: null,
      requiresOpenaiAuth: false,
    })),
    (error) => {
      assert.match(error.message, /No ChatGPT session token/);
      assert.equal(error.errorCode, "token_missing");
      return true;
    }
  );
});
