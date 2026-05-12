// FILE: account-handler.js
// Purpose: All ChatGPT-account / sign-in / voice-auth RPCs the bridge answers
//          on behalf of the iOS app. Codex is the only provider that
//          implements these natively; other providers receive a synthetic
//          "managed externally" response so the auth UI doesn't hang. This
//          module owns the pending-sign-in state machine as well — when the
//          Codex transport forwards an `account/login/start` response, the
//          loginId/authUrl pair is cached locally so the phone can later
//          trigger `openOnMac` without a round-trip.
//
// Layer: bridge handler — runs inside the `startBridge` lifecycle. The
//        factory takes injected dependencies (active provider, Codex sender,
//        forwarded-request tracker, etc.) so the module has no implicit
//        coupling to bridge.js's relay loop.
//
// Exports: createAccountHandler
//
// Why a module: bridge.js previously inlined the account/voice gating,
// the synchronous response router, and the pending-auth state machine
// across ~250 lines, with the state machine reading the
// `forwardedRequestMethodsById` Map from a different region of the same
// closure. Lifting all of this into a named factory makes the surface
// reviewable in one place and lets future providers add their own
// auth-status payloads without touching the relay loop.

const { promisify } = require("util");
const { execFile } = require("child_process");

const execFileAsync = promisify(execFile);

const BRIDGE_MANAGED_METHODS = new Set([
  "account/status/read",
  "getAuthStatus",
  "account/login/openOnMac",
  "voice/resolveAuth",
]);
const CODEX_LOGIN_FORWARD_METHODS = new Set([
  "account/login/start",
  "account/login/cancel",
  "account/logout",
]);

/**
 * @param {object} deps
 * @param {{ id: string, displayName: string }} deps.activeProvider
 *   — current provider, used to gate Codex-only RPCs.
 * @param {(method: string, params: object) => Promise<any>} deps.sendCodexRequest
 *   — invokes the Codex transport. Only called when the active provider is
 *     Codex; other providers see the synthetic responses.
 * @param {() => Promise<any>} deps.readBridgePackageVersionStatus
 *   — opaque snapshot of the bridge's own version info, joined into the auth
 *     status payload.
 * @param {string} deps.codexMode — transport mode (spawn/http/...), surfaced
 *   to iOS so it can render the connection method.
 * @param {object} deps.tracker — forwarded-request-tracker instance.
 *   The auth state machine uses tracker.consumeForwardedResponse() to match
 *   incoming responses back to the methods that produced them.
 * @param {Function} deps.composeSanitizedAuthStatusFromSettledResults
 *   — pure helper from account-status.js. Injected to keep this module
 *     trivially testable.
 * @param {(send: Function) => Promise<any>} deps.resolveVoiceAuth
 *   — helper from voice-handler.js, invoked for `voice/resolveAuth`.
 * @returns {{
 *   handleBridgeManagedAccountRequest: (rawMessage: string, sendResponse: (line: string) => void) => boolean,
 *   handleNonCodexVoiceRequest:        (rawMessage: string, sendResponse: (line: string) => void) => boolean,
 *   updatePendingAuthLoginFromCodexMessage: (rawMessage: string) => void,
 *   clearPendingAuthLogin: () => void,
 *   hasPendingAuthLogin: () => boolean,
 * }}
 */
function createAccountHandler({
  activeProvider,
  sendCodexRequest,
  readBridgePackageVersionStatus,
  codexMode,
  tracker,
  composeSanitizedAuthStatusFromSettledResults,
  resolveVoiceAuth,
}) {
  // ── per-bridge state ───────────────────────────────────────────────────
  // The phone reads `loginInFlight` (via readSanitizedAuthStatus) to know
  // whether to render a sign-in card. The pair {loginId, authUrl} also lets
  // the phone trigger `account/login/openOnMac` without round-tripping back
  // to ChatGPT for the URL.
  const pendingAuthLogin = {
    loginId: null,
    authUrl: null,
    requestId: null,
    startedAt: 0,
  };

  function clearPendingAuthLogin() {
    pendingAuthLogin.loginId = null;
    pendingAuthLogin.authUrl = null;
    pendingAuthLogin.requestId = null;
    pendingAuthLogin.startedAt = 0;
  }

  function hasPendingAuthLogin() {
    return Boolean(pendingAuthLogin.loginId);
  }

  // ── inbound interception (codex → phone) ───────────────────────────────
  // Called for every codex response. The auth state machine consumes the
  // forwarded-method ledger so it can recognize login/cancel/logout
  // responses by id and update local state before the response is relayed
  // to the phone.
  function updatePendingAuthLoginFromCodexMessage(rawMessage) {
    tracker.pruneExpired();
    const parsed = safeParseJson(rawMessage);
    const responseId = parsed?.id;
    if (responseId != null) {
      const trackedRequest = tracker.consumeForwardedResponse(responseId);
      if (trackedRequest) {
        const requestMethod = trackedRequest.method;
        if (requestMethod === "account/login/start") {
          const loginId = readString(parsed?.result?.loginId);
          const authUrl = readString(parsed?.result?.authUrl);
          if (!loginId || !authUrl) {
            clearPendingAuthLogin();
            return;
          }
          pendingAuthLogin.loginId = loginId;
          pendingAuthLogin.authUrl = authUrl;
          pendingAuthLogin.requestId = String(responseId);
          pendingAuthLogin.startedAt = Date.now();
          return;
        }
        if (requestMethod === "account/login/cancel" || requestMethod === "account/logout") {
          clearPendingAuthLogin();
          return;
        }
      }
    }

    // Codex also sends unsolicited `account/login/completed` and
    // `account/updated` notifications when the login URL is completed in a
    // browser. Both flush the pending state.
    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (method === "account/login/completed") {
      clearPendingAuthLogin();
      return;
    }
    if (method === "account/updated") {
      clearPendingAuthLogin();
    }
  }

  // ── outbound dispatch (phone → bridge) ─────────────────────────────────
  // Returns true if the message was handled locally (caller must not forward
  // it to the codex transport). false means "not my problem, keep routing".
  function handleBridgeManagedAccountRequest(rawMessage, sendResponse) {
    const parsed = safeParseJson(rawMessage);
    if (!parsed) return false;

    const method = typeof parsed.method === "string" ? parsed.method.trim() : "";
    const isCodexBridgeManaged = BRIDGE_MANAGED_METHODS.has(method);
    const isCodexLoginForward = CODEX_LOGIN_FORWARD_METHODS.has(method);
    if (!isCodexBridgeManaged && !isCodexLoginForward) {
      return false;
    }

    const requestId = parsed.id;
    const shouldRespond = requestId != null;

    if (activeProvider.id !== "codex") {
      const result = buildNonCodexAccountResponse(method, activeProvider);
      if (shouldRespond) {
        if (result.error) {
          sendResponse(createJsonRpcErrorResponse(
            requestId,
            result.error,
            result.error.errorCode || "not_supported",
          ));
        } else {
          sendResponse(JSON.stringify({ id: requestId, result: result.value }));
        }
      }
      return true;
    }

    // Codex case: only the bridge-managed methods are answered locally. The
    // login/start/cancel/logout family is forwarded so the forwarded-request
    // tracker can pair the response with the right state transition.
    if (isCodexLoginForward) {
      return false;
    }

    readBridgeManagedAccountResult(method, parsed.params || {})
      .then((result) => {
        if (shouldRespond) {
          sendResponse(JSON.stringify({ id: requestId, result }));
        }
      })
      .catch((error) => {
        if (shouldRespond) {
          sendResponse(createJsonRpcErrorResponse(requestId, error, "auth_status_failed"));
        }
      });

    return true;
  }

  function handleNonCodexVoiceRequest(rawMessage, sendResponse) {
    if (activeProvider.id === "codex") return false;
    const parsed = safeParseJson(rawMessage);
    if (!parsed) return false;
    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (method !== "voice/transcribe") return false;
    if (parsed.id == null) return true;
    sendResponse(JSON.stringify({
      id: parsed.id,
      ...buildNonCodexVoiceTranscribeError(activeProvider),
    }));
    return true;
  }

  async function readBridgeManagedAccountResult(method, params) {
    switch (method) {
      case "account/status/read":
      case "getAuthStatus":
        return readSanitizedAuthStatus();
      case "account/login/openOnMac":
        return openPendingAuthLoginOnMac(params);
      case "voice/resolveAuth":
        return resolveVoiceAuth(sendCodexRequest);
      default:
        throw new Error(`Unsupported bridge-managed account method: ${method}`);
    }
  }

  async function readSanitizedAuthStatus() {
    // Settle independently so a transient failure in one RPC doesn't hide the other.
    const [accountReadResult, authStatusResult, bridgeVersionInfoResult] = await Promise.allSettled([
      sendCodexRequest("account/read", { refreshToken: false }),
      sendCodexRequest("getAuthStatus", { includeToken: true, refreshToken: true }),
      readBridgePackageVersionStatus(),
    ]);

    return composeSanitizedAuthStatusFromSettledResults({
      accountReadResult: accountReadResult.status === "fulfilled"
        ? { status: "fulfilled", value: normalizeAccountRead(accountReadResult.value) }
        : accountReadResult,
      authStatusResult,
      loginInFlight: hasPendingAuthLogin(),
      bridgeVersionInfo: bridgeVersionInfoResult.status === "fulfilled"
        ? bridgeVersionInfoResult.value
        : null,
      transportMode: codexMode,
      hostPlatform: process.platform,
    });
  }

  async function openPendingAuthLoginOnMac(params) {
    if (process.platform !== "darwin") {
      const error = new Error("Opening ChatGPT sign-in on the bridge is only supported on macOS.");
      error.errorCode = "unsupported_platform";
      throw error;
    }
    const authUrl = readString(params?.authUrl) || pendingAuthLogin.authUrl;
    if (!authUrl) {
      const error = new Error("No pending ChatGPT sign-in URL is available on this bridge.");
      error.errorCode = "missing_auth_url";
      throw error;
    }
    await execFileAsync("open", [authUrl], { timeout: 15_000 });
    return { success: true, openedOnMac: true };
  }

  return {
    handleBridgeManagedAccountRequest,
    handleNonCodexVoiceRequest,
    updatePendingAuthLoginFromCodexMessage,
    clearPendingAuthLogin,
    hasPendingAuthLogin,
  };
}

// ── pure helpers ─────────────────────────────────────────────────────────
function normalizeAccountRead(payload) {
  if (!payload || typeof payload !== "object") {
    return { account: null, requiresOpenaiAuth: true };
  }
  return {
    account: payload.account && typeof payload.account === "object" ? payload.account : null,
    requiresOpenaiAuth: Boolean(payload.requiresOpenaiAuth),
  };
}

function createJsonRpcErrorResponse(requestId, error, defaultErrorCode) {
  return JSON.stringify({
    id: requestId,
    error: {
      code: -32000,
      message: error?.userMessage || error?.message || "Bridge request failed.",
      data: { errorCode: error?.errorCode || defaultErrorCode },
    },
  });
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readString(value) {
  return typeof value === "string" && value ? value : "";
}

// Pure response builder for non-Codex account RPCs. Codex is the only provider
// that implements ChatGPT-style account/login/voice-auth flows; for other
// providers the bridge answers locally so the iOS auth UI renders a "managed
// externally" state instead of hanging on a request that would never reach
// a handler.
function buildNonCodexAccountResponse(method, provider) {
  if (method === "account/status/read" || method === "getAuthStatus") {
    return {
      value: {
        loggedIn: false,
        supportsLogin: false,
        provider: provider.id,
        providerName: provider.displayName,
        authMethod: "external",
        message: `${provider.displayName} manages authentication outside of agnt.`,
      },
    };
  }
  if (method === "voice/resolveAuth") {
    return { value: { token: "", supported: false } };
  }
  if (method === "account/login/start"
    || method === "account/login/cancel"
    || method === "account/login/openOnMac"
    || method === "account/logout") {
    const err = new Error(`${provider.displayName} does not support agnt-managed sign-in.`);
    err.errorCode = "not_supported";
    return { error: err };
  }
  return { value: null };
}

// Pure JSON-RPC error shape for voice/transcribe when the active provider is
// not Codex.
function buildNonCodexVoiceTranscribeError(provider) {
  return {
    error: {
      code: -32601,
      message: `Voice transcription is not supported with ${provider.displayName}.`,
      data: { errorCode: "not_supported", provider: provider.id },
    },
  };
}

module.exports = {
  buildNonCodexAccountResponse,
  buildNonCodexVoiceTranscribeError,
  createAccountHandler,
  createJsonRpcErrorResponse,
  normalizeAccountRead,
};
