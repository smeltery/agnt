// FILE: handshake-handler.js
// Purpose: Owns the bridge's handshake replay logic and the iOS-app version
//          compatibility check that piggybacks on the `initialize` request.
//          Sits between the phone's JSON-RPC `initialize` and the Codex
//          transport's own MCP handshake so the phone doesn't re-init a
//          warm Codex runtime (which would just return "Already initialized")
//          on every reconnect.
//
// Layer: bridge handler — factory called once per bridge connection. The
//        module owns the handshake state machine; bridge.js keeps the
//        transport launch state (`codexLaunchState`) since that's an
//        unrelated concern of the relay loop.
//
// Exports: createHandshakeHandler
//
// Why a module: this was four closure-bound functions
// (`handleBridgeManagedHandshakeMessage`, `bridgeManagedInitializeCompatibilityError`,
// `logIOSAppCompatibilityWarning`, `trackCodexHandshakeState`) plus three
// `let` slots inside `startBridge`. They form a coherent unit — the
// `forwardedInitializeRequestIds` Set is written by the inbound replay
// handler and consumed by the codex-response observer, with the
// `codexHandshakeState` flag flipping between them. Lifting the whole
// thing into one module makes the warm/cold transition visible in one
// place.

const {
  MINIMUM_SUPPORTED_IOS_APP_VERSION,
  buildCachedIOSAppCompatibilityWarning,
  buildIOSAppCompatibilitySnapshot,
  normalizeVersionString,
} = require("./ios-app-compatibility");
const { rememberLastSeenPhoneAppVersion } = require("../transport/secure-device-state");

/**
 * @param {object} deps
 * @param {(line: string) => void} deps.sendApplicationResponse
 *   — Push a relay-bound JSON-RPC line back to the phone. Wired to the
 *     bridge's existing secure-transport queue.
 * @param {string} deps.bridgePackageVersion — published in compatibility
 *   error payloads so the phone can render the right downgrade hint.
 * @param {boolean} [deps.initialHandshakeWarm=false]
 *   — true when the bridge connected to an already-warm Codex runtime
 *     (e.g. `--codex-endpoint` was set). Otherwise the first inbound
 *     `initialize` must round-trip to the spawned Codex transport.
 * @param {() => object} deps.getDeviceState
 *   — Read accessor for the mutable device-state slot in bridge.js. The
 *     handler may mutate device state via `rememberLastSeenPhoneAppVersion`,
 *     so it needs a write-back hook too.
 * @param {(next: object) => void} deps.setDeviceState
 *   — Write accessor that lets the handler publish the rebuilt device-state
 *     object back into bridge.js after the version-bump pass.
 * @param {Console} [deps.consoleImpl=console]
 *   — Console injection for tests. Defaults to the global console.
 * @returns {{
 *   handlePhoneMessage:   (rawMessage: string) => boolean,
 *   observeCodexResponse: (rawMessage: string) => void,
 *   logCompatibilityWarning: (warning: string) => void,
 *   isWarm:               () => boolean,
 * }}
 */
function createHandshakeHandler({
  sendApplicationResponse,
  bridgePackageVersion,
  initialHandshakeWarm = false,
  getDeviceState,
  setDeviceState,
  consoleImpl = console,
}) {
  // ── per-bridge state ───────────────────────────────────────────────────
  let codexHandshakeState = initialHandshakeWarm ? "warm" : "cold";
  let lastCompatibilityWarning = "";
  /** Tracks `initialize` request ids the bridge forwarded to Codex; their
   *  responses flip the handshake to "warm" so future reconnects can be
   *  answered locally. */
  const forwardedInitializeIds = new Set();

  /**
   * Inbound from the phone. Returns true if the bridge consumed the message
   * locally; false means "keep routing this through the normal pipeline".
   */
  function handlePhoneMessage(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (!method) {
      return false;
    }

    if (method === "initialize" && parsed.id != null) {
      const compatibilityError = buildCompatibilityError(parsed.params || {});
      if (compatibilityError) {
        sendApplicationResponse(JSON.stringify({
          id: parsed.id,
          error: compatibilityError,
        }));
        return true;
      }

      if (codexHandshakeState !== "warm") {
        // First initialize of a cold bridge — forward to Codex and remember
        // the request id so the response can flip us warm.
        forwardedInitializeIds.add(String(parsed.id));
        return false;
      }

      sendApplicationResponse(JSON.stringify({
        id: parsed.id,
        result: { bridgeManaged: true },
      }));
      return true;
    }

    if (method === "initialized") {
      // A warm bridge already handled the matching initialize locally; the
      // phone's notification can be dropped instead of confusing Codex.
      return codexHandshakeState === "warm";
    }

    return false;
  }

  /**
   * Inbound from Codex. Walks responses to find the matching initialize id
   * so the handshake state flips warm.
   */
  function observeCodexResponse(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const responseId = parsed?.id;
    if (responseId == null) return;

    const responseKey = String(responseId);
    if (!forwardedInitializeIds.has(responseKey)) return;

    forwardedInitializeIds.delete(responseKey);

    if (parsed?.result != null) {
      codexHandshakeState = "warm";
      return;
    }

    const errorMessage = typeof parsed?.error?.message === "string"
      ? parsed.error.message.toLowerCase()
      : "";
    if (errorMessage.includes("already initialized")) {
      // Codex already handshook with someone else (e.g. the desktop app);
      // treat that as warm too so the phone doesn't blow on reconnect.
      codexHandshakeState = "warm";
    }
  }

  /**
   * Logs a compatibility warning once per distinct message — repeated phone
   * reconnects with the same stale build shouldn't spam the console.
   */
  function logCompatibilityWarning(warning) {
    const normalizedWarning = typeof warning === "string" ? warning.trim() : "";
    if (!normalizedWarning || normalizedWarning === lastCompatibilityWarning) {
      return;
    }
    lastCompatibilityWarning = normalizedWarning;
    consoleImpl.warn(normalizedWarning);
  }

  /** Test-and-debug helper. */
  function isWarm() {
    return codexHandshakeState === "warm";
  }

  // ── private: builds the JSON-RPC error sent back when the phone is too old
  function buildCompatibilityError(params) {
    const clientInfo = params && typeof params === "object" ? params.clientInfo : null;
    const clientName = normalizeNonEmptyString(clientInfo?.name);
    if (clientName !== "codexmobile_ios") {
      return null;
    }

    const clientVersion = normalizeVersionString(clientInfo?.version);
    if (clientVersion) {
      setDeviceState(rememberLastSeenPhoneAppVersion(getDeviceState(), clientVersion));
    }

    const compatibility = buildIOSAppCompatibilitySnapshot({
      bridgeVersion: bridgePackageVersion,
      iosAppVersion: clientVersion,
    });
    if (!compatibility.requiresAppUpdate) {
      return null;
    }

    logCompatibilityWarning(buildCachedIOSAppCompatibilityWarning({
      bridgeVersion: bridgePackageVersion,
      iosAppVersion: clientVersion,
    }));

    return {
      code: -32001,
      message: compatibility.message,
      data: {
        errorCode: "ios_app_update_required",
        minimumSupportedAppVersion: MINIMUM_SUPPORTED_IOS_APP_VERSION,
        bridgeVersion: normalizeVersionString(bridgePackageVersion) || null,
        clientVersion,
        compatibleBridgeVersion: compatibility.legacyBridgeVersion,
        downgradeCommand: compatibility.downgradeCommand,
      },
    };
  }

  return {
    handlePhoneMessage,
    observeCodexResponse,
    logCompatibilityWarning,
    isWarm,
  };
}

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length === 0 ? "" : trimmed;
}

module.exports = {
  createHandshakeHandler,
};
