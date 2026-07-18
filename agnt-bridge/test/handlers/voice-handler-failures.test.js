// FILE: voice-handler-failures.test.js
// Purpose: Verifies voice transcription provider failures and duration validation.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, voice-handler, voice-handler-test-helpers

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

test("voice/transcribe returns a typed timeout when provider upload stalls", async () => {
  const responses = [];
  const handler = createVoiceHandler({
    transcriptionTimeoutMs: 1,
    sendCodexRequest: async () => ({
      authMethod: "chatgpt",
      authToken: "chatgpt-token",
      requiresOpenaiAuth: false,
    }),
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason));
    }),
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-provider-timeout",
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

  await waitUntil(() => responses.length === 1);

  assert.equal(responses[0].error?.data?.errorCode, "transcription_timeout");
  assert.match(responses[0].error?.message || "", /timed out/);
});

test("voice/transcribe returns a typed network error when provider upload fails", async () => {
  const responses = [];
  const handler = createVoiceHandler({
    sendCodexRequest: async () => ({
      authMethod: "chatgpt",
      authToken: "chatgpt-token",
      requiresOpenaiAuth: false,
    }),
    fetchImpl: async () => {
      throw new Error("socket closed");
    },
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-provider-network-error",
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

  assert.equal(responses[0].error?.data?.errorCode, "transcription_network_error");
  assert.match(responses[0].error?.message || "", /could not reach/);
});

test("voice/transcribe rejects audio whose actual duration exceeds the request", async () => {
  const responses = [];
  let authRequests = 0;
  let fetchCalls = 0;
  const handler = createVoiceHandler({
    sendCodexRequest: async () => {
      authRequests += 1;
      throw new Error("auth should not be requested for duration mismatch");
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run for duration mismatch");
    },
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-duration-mismatch",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/wav",
      audioBase64: makeTestWavBase64({ durationSeconds: 4 }),
      sampleRateHz: 24_000,
      durationMs: 1_000,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await tick();

  assert.equal(authRequests, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(responses[0].error?.data?.errorCode, "duration_mismatch");
});

test("voice/transcribe rejects M4A whose actual duration exceeds the limit", async () => {
  const responses = [];
  let authRequests = 0;
  let fetchCalls = 0;
  const handler = createVoiceHandler({
    sendCodexRequest: async () => {
      authRequests += 1;
      throw new Error("auth should not be requested for overlong m4a");
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run for overlong m4a");
    },
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-m4a-too-long",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/mp4",
      audioBase64: makeTestM4ABase64({ durationSeconds: 151 }),
      sampleRateHz: 24_000,
      durationMs: 150_000,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await tick();

  assert.equal(authRequests, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(responses[0].error?.data?.errorCode, "duration_too_long");
});

test("voice/transcribe rejects clips longer than 150 seconds before contacting the provider", async () => {
  const responses = [];
  let authRequests = 0;
  let fetchCalls = 0;
  const handler = createVoiceHandler({
    sendCodexRequest: async () => {
      authRequests += 1;
      throw new Error("auth should not be requested for overlong audio");
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run for overlong audio");
    },
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-too-long",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/wav",
      audioBase64: makeTestWavBase64(),
      sampleRateHz: 24_000,
      durationMs: 150_100,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await tick();

  assert.equal(authRequests, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(responses[0].error?.data?.errorCode, "duration_too_long");
  assert.match(responses[0].error?.message || "", /150 seconds/);
});

// ─── resolveVoiceAuth tests ─────────────────────────────────
