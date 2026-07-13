// FILE: voice-handler.js
// Purpose: Handles bridge-owned voice transcription requests without exposing auth tokens to iPhone.
// Layer: Bridge handler
// Exports: createVoiceHandler
// Depends on: global fetch/FormData/Blob, local codex app-server auth via sendCodexRequest

const { isChatGPTAuthMethod } = require("./account-status");
const { createJsonRpcRequestHandler } = require("./handler-utils");

const CHATGPT_TRANSCRIPTIONS_URL = "https://chatgpt.com/backend-api/transcribe";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_DURATION_SECONDS = 150;
const MAX_DURATION_MS = MAX_DURATION_SECONDS * 1_000;
const AUTH_CACHE_TTL_MS = 60_000;
const PRECONNECT_MIN_INTERVAL_MS = 2_000;
const PRECONNECT_TIMEOUT_MS = 10_000;
const SUPPORTED_AUDIO_FORMATS = ["wav", "m4a"];
const WAV_MIME_TYPE = "audio/wav";
const M4A_MIME_TYPE = "audio/mp4";

function createVoiceHandler({
  sendCodexRequest,
  fetchImpl = globalThis.fetch,
  FormDataImpl = globalThis.FormData,
  BlobImpl = globalThis.Blob,
  logPrefix = "[agnt]",
} = {}) {
  const warmState = {
    authPromise: null,
    authLoadedAt: 0,
    lastPreconnectAt: 0,
  };

  const cacheAuthPromise = (promise) => {
    warmState.authPromise = promise;
    warmState.authLoadedAt = Date.now();
    promise.catch(() => {
      if (warmState.authPromise === promise) {
        warmState.authPromise = null;
      }
    });
    return promise;
  };
  const loadAuth = ({ refreshToken = true } = {}) => {
    if (warmState.authPromise && Date.now() - warmState.authLoadedAt < AUTH_CACHE_TTL_MS) {
      return warmState.authPromise;
    }
    return cacheAuthPromise(loadAuthContext(sendCodexRequest, { refreshToken }));
  };
  const refreshAuth = () => cacheAuthPromise(loadAuthContext(sendCodexRequest, { refreshToken: true }));

  const handleVoiceRequest = createJsonRpcRequestHandler({
    match: (method) => method === "voice/transcribe" || method === "voice/prewarm",
    dispatch: (_method, params) => transcribeVoice(params, {
      sendCodexRequest,
      fetchImpl,
      FormDataImpl,
      BlobImpl,
      loadAuth,
      refreshAuth,
    }),
    defaultErrorCode: "voice_transcription_failed",
    defaultErrorMessage: "Voice transcription failed.",
    onError: (error) => {
      console.error(`${logPrefix} voice transcription failed: ${error?.message || error}`);
    },
  });

  return {
    handleVoiceRequest(rawMessage, sendResponse, parsedMessage = null) {
      const parsed = parsedMessage || parseJsonMessage(rawMessage);
      if (!parsed || parsed.method !== "voice/prewarm") {
        return handleVoiceRequest(rawMessage, sendResponse, parsedMessage);
      }

      preconnectTranscriptionOrigin(fetchImpl, warmState);
      loadAuth({ refreshToken: false }).catch(() => {});
      if (parsed.id != null) {
        sendResponse(JSON.stringify({
          id: parsed.id,
          result: {
            ok: true,
            formats: SUPPORTED_AUDIO_FORMATS,
          },
        }));
      }
      return true;
    },
  };
}

// ─── Audio validation helpers ───────────────────────────────

// Validates iPhone-owned audio input and proxies it to the official transcription endpoint.
async function transcribeVoice(
  params,
  {
    sendCodexRequest,
    fetchImpl,
    FormDataImpl,
    BlobImpl,
    loadAuth = () => loadAuthContext(sendCodexRequest, { refreshToken: false }),
    refreshAuth = () => loadAuthContext(sendCodexRequest, { refreshToken: true }),
  }
) {
  if (typeof sendCodexRequest !== "function") {
    throw voiceError("bridge_not_ready", "Voice transcription is not available right now.");
  }
  if (typeof fetchImpl !== "function" || !FormDataImpl || !BlobImpl) {
    throw voiceError("transcription_unavailable", "Voice transcription is unavailable on this bridge.");
  }

  const mimeType = readString(params.mimeType);
  if (mimeType !== WAV_MIME_TYPE && mimeType !== M4A_MIME_TYPE) {
    throw voiceError("unsupported_mime_type", "Only WAV or M4A audio is supported for voice transcription.");
  }

  const sampleRateHz = readPositiveNumber(params.sampleRateHz);
  if (sampleRateHz !== 24_000) {
    throw voiceError("unsupported_sample_rate", "Voice transcription requires 24 kHz mono WAV audio.");
  }

  const durationMs = readPositiveNumber(params.durationMs);
  if (durationMs <= 0) {
    throw voiceError("invalid_duration", "Voice messages must include a positive duration.");
  }
  if (durationMs > MAX_DURATION_MS) {
    throw voiceError("duration_too_long", `Voice messages are limited to ${MAX_DURATION_SECONDS} seconds.`);
  }

  const audioBuffer = decodeAudioBase64(params.audioBase64, mimeType);
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw voiceError("audio_too_large", "Voice messages are limited to 10 MB.");
  }

  const authContext = await loadAuth();
  return requestTranscription({
    authContext,
    audioBuffer,
    mimeType,
    filename: mimeType === M4A_MIME_TYPE ? "voice.m4a" : "voice.wav",
    fetchImpl,
    FormDataImpl,
    BlobImpl,
    refreshAuth,
  });
}

async function requestTranscription({
  authContext,
  audioBuffer,
  mimeType,
  filename,
  fetchImpl,
  FormDataImpl,
  BlobImpl,
  refreshAuth,
}) {
  const makeAttempt = async (activeAuthContext) => {
    const formData = new FormDataImpl();
    formData.append("file", new BlobImpl([audioBuffer], { type: mimeType }), filename);

    const headers = {
      Authorization: `Bearer ${activeAuthContext.token}`,
    };

    return fetchImpl(activeAuthContext.transcriptionURL, {
      method: "POST",
      headers,
      body: formData,
    });
  };

  let response = await makeAttempt(authContext);
  if (response.status === 401 || response.status === 403) {
    const refreshedAuthContext = await refreshAuth();
    response = await makeAttempt(refreshedAuthContext);
  }

  if (!response.ok) {
    let errorMessage = `Transcription failed with status ${response.status}.`;
    try {
      const errorPayload = await response.json();
      const providerMessage = readString(errorPayload?.error?.message) || readString(errorPayload?.message);
      if (providerMessage) {
        errorMessage = providerMessage;
      }
    } catch {
      // Keep the generic message when the provider body is empty or non-JSON.
    }

    if (response.status === 401 || response.status === 403) {
      throw voiceError("not_authenticated", "Your ChatGPT login has expired. Sign in again.");
    }

    throw voiceError("transcription_failed", errorMessage);
  }

  const payload = await response.json().catch(() => null);
  const text = readString(payload?.text) || readString(payload?.transcript);
  if (!text) {
    throw voiceError("transcription_invalid_response", "The transcription response did not include any text.");
  }

  return { text };
}

// Reads the current bridge-owned auth state from the local codex app-server and refreshes if needed.
async function loadAuthContext(sendCodexRequest, { refreshToken = true } = {}) {
  const authStatus = await sendCodexRequest("getAuthStatus", {
    includeToken: true,
    refreshToken,
  });

  const authMethod = readString(authStatus?.authMethod);
  const token = readString(authStatus?.authToken);
  const isChatGPT = isChatGPTAuthMethod(authMethod);

  if (!token) {
    throw voiceError("not_authenticated", "Sign in with ChatGPT before using voice transcription.");
  }
  if (!isChatGPT) {
    throw voiceError("not_chatgpt", "Voice transcription requires a ChatGPT account.");
  }

  return {
    authMethod,
    token,
    isChatGPT,
    transcriptionURL: CHATGPT_TRANSCRIPTIONS_URL,
    chatgptAccountId: readChatGPTAccountIdFromToken(token),
  };
}

function decodeAudioBase64(value, mimeType) {
  const normalized = normalizeBase64(value);
  if (!normalized) {
    throw voiceError("missing_audio", "The voice request did not include any audio.");
  }

  if (!isLikelyBase64(normalized)) {
    throw voiceError("invalid_audio", "The recorded audio could not be decoded.");
  }

  const audioBuffer = Buffer.from(normalized, "base64");
  if (!audioBuffer.length) {
    throw voiceError("invalid_audio", "The recorded audio could not be decoded.");
  }

  if (audioBuffer.toString("base64") !== normalized) {
    throw voiceError("invalid_audio", "The recorded audio could not be decoded.");
  }

  if (mimeType === WAV_MIME_TYPE && !isLikelyWavBuffer(audioBuffer)) {
    throw voiceError("invalid_audio", "The recorded audio is not a valid WAV file.");
  }

  if (mimeType === M4A_MIME_TYPE && !isLikelyM4ABuffer(audioBuffer)) {
    throw voiceError("invalid_audio", "The recorded audio is not a valid M4A file.");
  }

  return audioBuffer;
}

function parseJsonMessage(rawMessage) {
  try {
    return JSON.parse(rawMessage);
  } catch {
    return null;
  }
}

// Keeps the bridge strict about the payload shape so malformed uploads fail before fetch().
function normalizeBase64(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function isLikelyBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    return false;
  }

  const paddingStart = value.indexOf("=");
  if (paddingStart !== -1) {
    const paddingLength = value.length - paddingStart;
    if (paddingLength > 2) {
      return false;
    }
    for (let i = paddingStart; i < value.length; i += 1) {
      if (value[i] !== "=") {
        return false;
      }
    }
  }

  // Avoid one giant regex: V8 can overflow its stack on multi-MB voice clips.
  const dataEnd = paddingStart === -1 ? value.length : paddingStart;
  for (let i = 0; i < dataEnd; i += 1) {
    const code = value.charCodeAt(i);
    const isUppercase = code >= 65 && code <= 90;
    const isLowercase = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isUppercase && !isLowercase && !isDigit && value[i] !== "+" && value[i] !== "/") {
      return false;
    }
  }

  return true;
}

function isLikelyWavBuffer(buffer) {
  return buffer.length >= 44
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WAVE";
}

function isLikelyM4ABuffer(buffer) {
  if (buffer.length < 16 || buffer.toString("ascii", 4, 8) !== "ftyp") {
    return false;
  }

  const brands = new Set();
  for (let offset = 8; offset + 4 <= Math.min(buffer.length, 64); offset += 4) {
    const brand = buffer.toString("ascii", offset, offset + 4);
    if (/^[\x20-\x7E]{4}$/.test(brand)) {
      brands.add(brand);
    }
  }

  return brands.has("M4A ")
    || brands.has("M4B ")
    || brands.has("mp42")
    || brands.has("isom")
    || brands.has("iso2");
}

function preconnectTranscriptionOrigin(fetchImpl, warmState) {
  if (typeof fetchImpl !== "function") {
    return;
  }

  const now = Date.now();
  if (now - warmState.lastPreconnectAt < PRECONNECT_MIN_INTERVAL_MS) {
    return;
  }
  warmState.lastPreconnectAt = now;

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutID = controller
    ? setTimeout(() => controller.abort(new Error("voice preconnect timed out")), PRECONNECT_TIMEOUT_MS)
    : null;
  timeoutID?.unref?.();

  Promise.resolve()
    .then(() => fetchImpl(new URL("/", CHATGPT_TRANSCRIPTIONS_URL).toString(), {
      method: "HEAD",
      signal: controller?.signal,
    }))
    .then((response) => {
      response?.body?.cancel?.()?.catch?.(() => {});
    })
    .catch(() => {})
    .finally(() => {
      if (timeoutID) {
        clearTimeout(timeoutID);
      }
    });
}

function readChatGPTAccountIdFromToken(token) {
  const payload = decodeJWTPayload(token);
  const authClaim = payload?.["https://api.openai.com/auth"];
  return readString(
    authClaim?.chatgpt_account_id
      || authClaim?.chatgptAccountId
      || payload?.chatgpt_account_id
      || payload?.chatgptAccountId
  );
}

function decodeJWTPayload(token) {
  const segments = typeof token === "string" ? token.split(".") : [];
  if (segments.length < 2) {
    return null;
  }

  const normalized = segments[1]
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(segments[1].length / 4) * 4, "=");

  try {
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPositiveNumber(value) {
  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : 0;
}

function voiceError(errorCode, userMessage) {
  const error = new Error(userMessage);
  error.errorCode = errorCode;
  error.userMessage = userMessage;
  return error;
}

// Returns an ephemeral ChatGPT token so the phone can call the transcription API directly.
// Uses its own token resolution instead of loadAuthContext so errors are specific and actionable.
async function resolveVoiceAuth(sendCodexRequest) {
  let authStatus;
  try {
    authStatus = await sendCodexRequest("getAuthStatus", {
      includeToken: true,
      refreshToken: true,
    });
  } catch (err) {
    console.error(`[agnt] voice/resolveAuth: getAuthStatus RPC failed: ${err.message}`);
    throw voiceError("auth_unavailable", "Could not read ChatGPT session from the Mac runtime. Is the bridge running?");
  }

  const authMethod = readString(authStatus?.authMethod);
  const token = readString(authStatus?.authToken);
  const isChatGPT = isChatGPTAuthMethod(authMethod);

  // Check for a usable ChatGPT token first. The runtime may set requiresOpenaiAuth
  // even when a valid ChatGPT session is present (the flag is about the runtime's
  // preferred auth mode, not whether ChatGPT tokens are actually available).
  if (isChatGPT && token) {
    return { token };
  }

  if (!token) {
    console.error(`[agnt] voice/resolveAuth: no token. authMethod=${authMethod || "none"} requiresOpenaiAuth=${authStatus?.requiresOpenaiAuth}`);
    throw voiceError("token_missing", "No ChatGPT session token available. Sign in to ChatGPT on the Mac.");
  }

  throw voiceError("not_chatgpt", "Voice transcription requires a ChatGPT account.");
}

module.exports = {
  createVoiceHandler,
  resolveVoiceAuth,
};
