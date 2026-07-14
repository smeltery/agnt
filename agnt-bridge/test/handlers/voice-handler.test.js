// FILE: voice-handler.test.js
// Purpose: Verifies bridge-owned voice transcription auth, validation, and retry behavior.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/voice-handler

const test = require("node:test");
const assert = require("node:assert/strict");

const { createVoiceHandler } = require("../../src/handlers/voice-handler");
const {
  makeJWT,
  makeTestM4ABase64,
  makeTestWavBase64,
  tick,
  waitUntil,
} = require("./voice-handler-test-helpers");

test("voice/transcribe returns transcribed text without exposing auth tokens", async () => {
  const responses = [];
  const fetchCalls = [];
  const handler = createVoiceHandler({
    sendCodexRequest: async (method, params) => {
      assert.equal(method, "getAuthStatus");
      assert.deepEqual(params, {
        includeToken: true,
        refreshToken: true,
      });
      return {
        authMethod: "chatgpt",
        authToken: makeJWT({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct-123",
          },
        }),
        requiresOpenaiAuth: false,
      };
    },
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return { text: "hello world" };
        },
      };
    },
  });

  const handled = handler.handleVoiceRequest(JSON.stringify({
    id: "voice-1",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/wav",
      audioBase64: makeTestWavBase64(),
      sampleRateHz: 24_000,
      durationMs: 1_200,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  assert.equal(handled, true);
  await tick();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://chatgpt.com/backend-api/transcribe");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[0].options.headers.Authorization.startsWith("Bearer "), true);
  assert.match(fetchCalls[0].options.headers["User-Agent"], /Safari/);
  assert.equal(fetchCalls[0].options.headers["ChatGPT-Account-Id"], undefined);
  assert.deepEqual(responses, [{
    id: "voice-1",
    result: {
      text: "hello world",
    },
  }]);
});

test("voice/transcribe retries once after a 401 response", async () => {
  const responses = [];
  let authRequestCount = 0;
  let fetchCount = 0;
  const handler = createVoiceHandler({
    sendCodexRequest: async () => {
      authRequestCount += 1;
      return {
        authMethod: "chatgpt",
        authToken: makeJWT({
          "https://api.openai.com/auth": {
            chatgpt_account_id: `acct-${authRequestCount}`,
          },
        }),
        requiresOpenaiAuth: false,
      };
    },
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return {
          ok: false,
          status: 401,
          async json() {
            return { error: { message: "expired" } };
          },
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return { text: "second try works" };
        },
      };
    },
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-2",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/wav",
      audioBase64: makeTestWavBase64(),
      sampleRateHz: 24_000,
      durationMs: 800,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await tick();

  assert.equal(authRequestCount, 2);
  assert.equal(fetchCount, 2);
  assert.equal(responses[0].result?.text, "second try works");
});

test("voice/transcribe rejects API-key auth because voice remains ChatGPT-only", async () => {
  const responses = [];
  let fetchCalled = false;
  const handler = createVoiceHandler({
    sendCodexRequest: async () => ({
      authMethod: "apiKey",
      authToken: "sk-test",
      requiresOpenaiAuth: false,
    }),
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("fetch should not run for API-key auth");
    },
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-4",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/wav",
      audioBase64: makeTestWavBase64(),
      sampleRateHz: 24_000,
      durationMs: 300,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await tick();

  assert.equal(fetchCalled, false);
  assert.equal(responses[0].error?.data?.errorCode, "not_chatgpt");
  assert.match(responses[0].error?.message || "", /requires a ChatGPT account/);
});

test("voice/transcribe accepts snake-case ChatGPT auth methods", async () => {
  const responses = [];
  let fetchCalls = 0;
  const handler = createVoiceHandler({
    sendCodexRequest: async () => ({
      authMethod: "chatgpt_auth_tokens",
      authToken: "chatgpt-token",
      requiresOpenaiAuth: true,
    }),
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { text: "snake case transcript" };
        },
      };
    },
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-snake-chatgpt",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/wav",
      audioBase64: makeTestWavBase64(),
      sampleRateHz: 24_000,
      durationMs: 300,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await tick();

  assert.equal(fetchCalls, 1);
  assert.equal(responses[0].result?.text, "snake case transcript");
});

test("voice/transcribe returns a user-facing auth error when Mac auth is missing", async () => {
  const responses = [];
  const handler = createVoiceHandler({
    sendCodexRequest: async () => ({
      authMethod: null,
      authToken: null,
      requiresOpenaiAuth: true,
    }),
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-3",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/wav",
      audioBase64: makeTestWavBase64(),
      sampleRateHz: 24_000,
      durationMs: 300,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await tick();

  assert.equal(responses[0].error?.data?.errorCode, "not_authenticated");
  assert.match(responses[0].error?.message || "", /Sign in with ChatGPT/);
});

test("voice/transcribe rejects malformed or non-WAV audio before contacting the provider", async () => {
  const cases = [
    {
      name: "malformed base64",
      audioBase64: "%%%not-base64%%%",
      message: /could not be decoded/,
    },
    {
      name: "non-WAV payload",
      audioBase64: Buffer.from("hello from agnt").toString("base64"),
      message: /not a valid WAV file/,
    },
  ];

  for (const testCase of cases) {
    const responses = [];
    let authRequests = 0;
    let fetchCalls = 0;
    const handler = createVoiceHandler({
      sendCodexRequest: async () => {
        authRequests += 1;
        throw new Error("auth should not be requested for invalid audio");
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch should not run for invalid audio");
      },
    });

    handler.handleVoiceRequest(JSON.stringify({
      id: `voice-invalid-${testCase.name}`,
      method: "voice/transcribe",
      params: {
        mimeType: "audio/wav",
        audioBase64: testCase.audioBase64,
        sampleRateHz: 24_000,
        durationMs: 300,
      },
    }), (response) => {
      responses.push(JSON.parse(response));
    });

    await tick();

    assert.equal(authRequests, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(responses[0].error?.data?.errorCode, "invalid_audio");
    assert.match(responses[0].error?.message || "", testCase.message);
  }
});

test("voice/transcribe accepts large clips without overflowing base64 validation", async () => {
  const responses = [];
  let fetchCalls = 0;
  const handler = createVoiceHandler({
    sendCodexRequest: async () => ({
      authMethod: "chatgpt",
      authToken: "chatgpt-token",
      requiresOpenaiAuth: false,
    }),
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { text: "long clip transcript" };
        },
      };
    },
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-large-valid",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/wav",
      audioBase64: makeTestWavBase64({ durationSeconds: 150 }),
      sampleRateHz: 24_000,
      durationMs: 150_000,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await tick();

  assert.equal(fetchCalls, 1);
  assert.equal(responses[0].result?.text, "long clip transcript");
});
