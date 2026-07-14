// FILE: voice-handler-m4a.test.js
// Purpose: Verifies voice transcription M4A validation and auth reuse behavior.
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

test("voice/prewarm preconnects to the provider and preloads auth", async () => {
  const responses = [];
  const fetchCalls = [];
  let authRequestCount = 0;
  const handler = createVoiceHandler({
    sendCodexRequest: async (method, params) => {
      authRequestCount += 1;
      assert.equal(method, "getAuthStatus");
      assert.deepEqual(params, {
        includeToken: true,
        refreshToken: false,
      });
      return {
        authMethod: "chatgpt",
        authToken: "chatgpt-token",
        requiresOpenaiAuth: false,
      };
    },
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, status: 200, async json() { return {}; } };
    },
  });

  const handled = handler.handleVoiceRequest(JSON.stringify({
    id: "voice-prewarm",
    method: "voice/prewarm",
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  assert.equal(handled, true);
  await tick();

  assert.deepEqual(responses, [{
    id: "voice-prewarm",
    result: {
      ok: true,
      formats: ["wav", "m4a"],
    },
  }]);
  assert.equal(authRequestCount, 1);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://chatgpt.com/");
  assert.equal(fetchCalls[0].options.method, "HEAD");
  assert.match(fetchCalls[0].options.headers["User-Agent"], /Safari/);
});

test("voice/transcribe accepts M4A clips and uploads them as audio/mp4", async () => {
  const responses = [];
  const formAppends = [];
  const handler = createVoiceHandler({
    sendCodexRequest: async () => ({
      authMethod: "chatgpt",
      authToken: "chatgpt-token",
      requiresOpenaiAuth: false,
    }),
    FormDataImpl: class FakeFormData {
      append(...args) {
        formAppends.push(args);
      }
    },
    BlobImpl: class FakeBlob {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options.type;
      }
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { text: "m4a transcript" };
      },
    }),
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-m4a",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/mp4",
      audioBase64: makeTestM4ABase64({ durationSeconds: 1 }),
      sampleRateHz: 24_000,
      durationMs: 1_000,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await tick();

  assert.equal(responses[0].result?.text, "m4a transcript");
  assert.equal(formAppends.length, 1);
  assert.equal(formAppends[0][0], "file");
  assert.equal(formAppends[0][1].type, "audio/mp4");
  assert.equal(formAppends[0][2], "voice.m4a");
});

test("voice/transcribe accepts CoreAudio M4A clips that report two channels", async () => {
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
          return { text: "coreaudio m4a transcript" };
        },
      };
    },
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-m4a-coreaudio",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/mp4",
      audioBase64: makeTestM4ABase64({ durationSeconds: 1, channelCount: 2 }),
      sampleRateHz: 24_000,
      durationMs: 1_000,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await tick();

  assert.equal(fetchCalls, 1);
  assert.equal(responses[0].result?.text, "coreaudio m4a transcript");
});

test("voice/transcribe rejects malformed M4A before contacting auth", async () => {
  const responses = [];
  let authRequests = 0;
  let fetchCalls = 0;
  const handler = createVoiceHandler({
    sendCodexRequest: async () => {
      authRequests += 1;
      throw new Error("auth should not be requested for invalid m4a");
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run for invalid m4a");
    },
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-invalid-m4a",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/mp4",
      audioBase64: Buffer.from("not an mp4 container").toString("base64"),
      sampleRateHz: 24_000,
      durationMs: 1_000,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await tick();

  assert.equal(authRequests, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(responses[0].error?.data?.errorCode, "invalid_audio");
  assert.match(responses[0].error?.message || "", /M4A/);
});

test("voice/transcribe rejects forged M4A containers before contacting auth", async () => {
  const responses = [];
  let authRequests = 0;
  let fetchCalls = 0;
  const handler = createVoiceHandler({
    sendCodexRequest: async () => {
      authRequests += 1;
      throw new Error("auth should not be requested for invalid m4a");
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run for invalid m4a");
    },
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-forged-m4a",
    method: "voice/transcribe",
    params: {
      mimeType: "audio/mp4",
      audioBase64: makeTestM4ABase64({ brand: "mp42", compatibleBrand: "mp42" }),
      sampleRateHz: 24_000,
      durationMs: 1_000,
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await tick();

  assert.equal(authRequests, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(responses[0].error?.data?.errorCode, "invalid_audio");
  assert.match(responses[0].error?.message || "", /M4A/);
});

test("voice/transcribe reuses auth loaded by voice/prewarm", async () => {
  const responses = [];
  let authRequestCount = 0;
  const handler = createVoiceHandler({
    sendCodexRequest: async () => {
      authRequestCount += 1;
      return {
        authMethod: "chatgpt",
        authToken: "chatgpt-token",
        requiresOpenaiAuth: false,
      };
    },
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      async json() {
        return options.method === "HEAD" ? {} : { text: "prewarmed transcript" };
      },
    }),
  });

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-prewarm-reuse",
    method: "voice/prewarm",
  }), () => {});
  await tick();

  handler.handleVoiceRequest(JSON.stringify({
    id: "voice-prewarmed-transcribe",
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

  assert.equal(authRequestCount, 1);
  assert.equal(responses[0].result?.text, "prewarmed transcript");
});
