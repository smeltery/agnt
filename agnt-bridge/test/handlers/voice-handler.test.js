// FILE: voice-handler.test.js
// Purpose: Verifies bridge-owned voice transcription auth, validation, and retry behavior.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/voice-handler

const test = require("node:test");
const assert = require("node:assert/strict");

const { createVoiceHandler } = require("../../src/handlers/voice-handler");

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

const { resolveVoiceAuth } = require("../../src/handlers/voice-handler");

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

function makeJWT(payload) {
  const header = base64UrlEncode({ alg: "none", typ: "JWT" });
  const body = base64UrlEncode(payload);
  return `${header}.${body}.signature`;
}

function makeTestWavBase64({ sampleRateHz = 24_000, durationSeconds = null } = {}) {
  const dataByteCount = durationSeconds == null
    ? 2
    : Math.max(2, Math.floor(durationSeconds * sampleRateHz * 2));
  const wav = Buffer.alloc(44 + dataByteCount);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataByteCount, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRateHz, 24);
  wav.writeUInt32LE(sampleRateHz * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataByteCount, 40);
  return wav.toString("base64");
}

function makeTestM4ABase64({
  durationSeconds = 1,
  mediaDurationSeconds = durationSeconds,
  brand = "M4A ",
  compatibleBrand = "M4A ",
  channelCount = 1,
  sampleRateHz = 24_000,
} = {}) {
  const mvhdPayload = Buffer.alloc(100);
  mvhdPayload.writeUInt8(0, 0);
  mvhdPayload.writeUInt32BE(1_000, 12);
  mvhdPayload.writeUInt32BE(Math.max(1, Math.round(durationSeconds * 1_000)), 16);

  const mdhdPayload = Buffer.alloc(20);
  mdhdPayload.writeUInt8(0, 0);
  mdhdPayload.writeUInt32BE(sampleRateHz, 12);
  mdhdPayload.writeUInt32BE(Math.max(1, Math.round(mediaDurationSeconds * sampleRateHz)), 16);

  const hdlrPayload = Buffer.alloc(24);
  hdlrPayload.write("soun", 8, "ascii");

  const mp4aPayload = Buffer.alloc(28);
  mp4aPayload.writeUInt16BE(1, 6);
  mp4aPayload.writeUInt16BE(channelCount, 16);
  mp4aPayload.writeUInt16BE(16, 18);
  mp4aPayload.writeUInt32BE(sampleRateHz << 16, 24);

  const stsdPayload = Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
    mp4Box("mp4a", mp4aPayload),
  ]);
  const stbl = mp4Box("stbl", mp4Box("stsd", stsdPayload));
  const minf = mp4Box("minf", stbl);
  const mdia = mp4Box("mdia", Buffer.concat([
    mp4Box("mdhd", mdhdPayload),
    mp4Box("hdlr", hdlrPayload),
    minf,
  ]));
  const trak = mp4Box("trak", mdia);
  const moov = mp4Box("moov", Buffer.concat([
    mp4Box("mvhd", mvhdPayload),
    trak,
  ]));

  return Buffer.concat([
    mp4Box("ftyp", Buffer.from(`${brand}\0\0\0\0${compatibleBrand}mp42isom`, "ascii")),
    moov,
    mp4Box("mdat", Buffer.from([0, 1, 2, 3])),
  ]).toString("base64");
}

function mp4Box(type, payload) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

function base64UrlEncode(value) {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}
