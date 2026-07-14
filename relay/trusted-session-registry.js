const { createPublicKey, verify } = require("crypto");

const TRUSTED_SESSION_RESOLVE_TAG = "agnt-trusted-session-resolve-v1";
const TRUSTED_SESSION_RESOLVE_SKEW_MS = 90_000;
const SHORT_PAIRING_CODE_MIN_LENGTH = 8;
const SHORT_PAIRING_CODE_MAX_LENGTH = 12;

function createTrustedSessionRegistry({ hasActiveMacSession }) {
  const liveSessionsByMacDeviceId = new Map();
  const liveSessionsByMacAndPhoneDeviceId = new Map();
  const liveSessionsByPairingCode = new Map();
  const usedResolveNonces = new Map();

  // Resolves the current live relay session for a previously trusted Mac without exposing the session id publicly.
  function resolveTrustedMacSession({
    macDeviceId,
    phoneDeviceId,
    phoneIdentityPublicKey,
    timestamp,
    nonce,
    signature,
    now = Date.now(),
  } = {}) {
    const normalizedMacDeviceId = normalizeNonEmptyString(macDeviceId);
    const normalizedPhoneDeviceId = normalizeNonEmptyString(phoneDeviceId);
    const normalizedPhoneIdentityPublicKey = normalizeNonEmptyString(phoneIdentityPublicKey);
    const normalizedNonce = normalizeNonEmptyString(nonce);
    const normalizedSignature = normalizeNonEmptyString(signature);
    const normalizedTimestamp = Number(timestamp);

    if (
      !normalizedMacDeviceId
      || !normalizedPhoneDeviceId
      || !normalizedPhoneIdentityPublicKey
      || !normalizedNonce
      || !normalizedSignature
      || !Number.isFinite(normalizedTimestamp)
    ) {
      throw createRelayError(400, "invalid_request", "The trusted-session resolve request is missing required fields.");
    }

    if (Math.abs(now - normalizedTimestamp) > TRUSTED_SESSION_RESOLVE_SKEW_MS) {
      throw createRelayError(401, "resolve_request_expired", "This trusted-session resolve request has expired.");
    }

    pruneUsedResolveNonces(now);
    const nonceKey = `${normalizedMacDeviceId}|${normalizedPhoneDeviceId}|${normalizedNonce}`;
    if (usedResolveNonces.has(nonceKey)) {
      throw createRelayError(409, "resolve_request_replayed", "This trusted-session resolve request was already used.");
    }

    const phoneSpecificSession = liveSessionsByMacAndPhoneDeviceId.get(
      macPhoneSessionKey(normalizedMacDeviceId, normalizedPhoneDeviceId)
    );
    const liveSession = phoneSpecificSession && hasActiveMacSession(phoneSpecificSession.sessionId)
      ? phoneSpecificSession
      : liveSessionsByMacDeviceId.get(normalizedMacDeviceId);
    if (!liveSession || !hasActiveMacSession(liveSession.sessionId)) {
      throw createRelayError(404, "session_unavailable", "The trusted Mac is offline right now.");
    }

    if (
      liveSession.trustedPhoneDeviceId !== normalizedPhoneDeviceId
      || liveSession.trustedPhonePublicKey !== normalizedPhoneIdentityPublicKey
    ) {
      throw createRelayError(403, "phone_not_trusted", "This iPhone is not trusted for the requested Mac.");
    }

    const transcriptBytes = buildTrustedSessionResolveBytes({
      macDeviceId: normalizedMacDeviceId,
      phoneDeviceId: normalizedPhoneDeviceId,
      phoneIdentityPublicKey: normalizedPhoneIdentityPublicKey,
      nonce: normalizedNonce,
      timestamp: normalizedTimestamp,
    });
    if (!verifyTrustedSessionResolveSignature(
      normalizedPhoneIdentityPublicKey,
      transcriptBytes,
      normalizedSignature
    )) {
      throw createRelayError(403, "invalid_signature", "The trusted-session resolve signature is invalid.");
    }

    usedResolveNonces.set(nonceKey, now + TRUSTED_SESSION_RESOLVE_SKEW_MS);
    return {
      ok: true,
      macDeviceId: normalizedMacDeviceId,
      macIdentityPublicKey: liveSession.macIdentityPublicKey,
      displayName: liveSession.displayName || null,
      sessionId: liveSession.sessionId,
    };
  }

  // Resolves the bootstrap metadata behind a short-lived manual pairing code.
  function resolvePairingCode({
    code,
    now = Date.now(),
  } = {}) {
    const normalizedCode = normalizeShortPairingCode(code);
    if (!normalizedCode) {
      throw createRelayError(400, "invalid_request", "The pairing code is missing or malformed.");
    }

    const registration = liveSessionsByPairingCode.get(normalizedCode);
    if (!registration || !hasActiveMacSession(registration.sessionId)) {
      throw createRelayError(404, "pairing_code_unavailable", "This pairing code is unavailable.");
    }

    if (!Number.isFinite(registration.pairingExpiresAt) || now > registration.pairingExpiresAt) {
      liveSessionsByPairingCode.delete(normalizedCode);
      throw createRelayError(410, "pairing_code_expired", "This pairing code has expired.");
    }

    if (
      !registration.macDeviceId
      || !registration.macIdentityPublicKey
      || !Number.isFinite(registration.pairingVersion)
    ) {
      throw createRelayError(409, "pairing_code_incomplete", "The bridge pairing metadata is incomplete.");
    }

    return {
      ok: true,
      v: registration.pairingVersion,
      sessionId: registration.sessionId,
      macDeviceId: registration.macDeviceId,
      macIdentityPublicKey: registration.macIdentityPublicKey,
      expiresAt: registration.pairingExpiresAt,
    };
  }

  function registerLiveMacSession(macRegistration) {
    if (!macRegistration?.macDeviceId) {
      return;
    }
    liveSessionsByMacDeviceId.set(macRegistration.macDeviceId, macRegistration);
    if (macRegistration.trustedPhoneDeviceId) {
      liveSessionsByMacAndPhoneDeviceId.set(
        macPhoneSessionKey(macRegistration.macDeviceId, macRegistration.trustedPhoneDeviceId),
        macRegistration
      );
    }
    if (macRegistration.pairingCode && Number.isFinite(macRegistration.pairingExpiresAt)) {
      liveSessionsByPairingCode.set(macRegistration.pairingCode, macRegistration);
    }
  }

  function applyMacRegistrationMessage(session, sessionId, rawMessage) {
    const parsed = safeParseJSON(rawMessage);
    if (parsed?.kind !== "relayMacRegistration" || typeof parsed.registration !== "object") {
      return false;
    }

    unregisterLiveMacSession(session.macRegistration, sessionId);
    session.macRegistration = normalizeMacRegistration(parsed.registration, sessionId);
    registerLiveMacSession(session.macRegistration);
    return true;
  }

  function unregisterLiveMacSession(macRegistration, sessionId) {
    const macDeviceId = macRegistration?.macDeviceId;
    if (!macDeviceId) {
      return;
    }

    const existing = liveSessionsByMacDeviceId.get(macDeviceId);
    if (existing?.sessionId === sessionId) {
      liveSessionsByMacDeviceId.delete(macDeviceId);
    }

    const trustedPhoneDeviceId = macRegistration?.trustedPhoneDeviceId;
    if (trustedPhoneDeviceId) {
      const phoneSessionKey = macPhoneSessionKey(macDeviceId, trustedPhoneDeviceId);
      const existingPhoneSpecific = liveSessionsByMacAndPhoneDeviceId.get(phoneSessionKey);
      if (existingPhoneSpecific?.sessionId === sessionId) {
        liveSessionsByMacAndPhoneDeviceId.delete(phoneSessionKey);
      }
    }

    const pairingCode = macRegistration?.pairingCode;
    if (pairingCode) {
      const existingPairingCode = liveSessionsByPairingCode.get(pairingCode);
      if (existingPairingCode?.sessionId === sessionId) {
        liveSessionsByPairingCode.delete(pairingCode);
      }
    }
  }

  function readMacRegistrationHeaders(headers, sessionId) {
    return normalizeMacRegistration({
      macDeviceId: readHeaderString(headers["x-mac-device-id"]),
      macIdentityPublicKey: readHeaderString(headers["x-mac-identity-public-key"]),
      displayName: readHeaderString(headers["x-machine-name"]),
      trustedPhoneDeviceId: readHeaderString(headers["x-trusted-phone-device-id"]),
      trustedPhonePublicKey: readHeaderString(headers["x-trusted-phone-public-key"]),
      pairingCode: readHeaderString(headers["x-pairing-code"]),
      pairingVersion: readHeaderString(headers["x-pairing-version"]),
      pairingExpiresAt: readHeaderString(headers["x-pairing-expires-at"]),
    }, sessionId);
  }

  function pairingCodeCount() {
    return liveSessionsByPairingCode.size;
  }

  function pruneUsedResolveNonces(now) {
    for (const [nonceKey, expiresAt] of usedResolveNonces.entries()) {
      if (now >= expiresAt) {
        usedResolveNonces.delete(nonceKey);
      }
    }
  }

  return {
    applyMacRegistrationMessage,
    pairingCodeCount,
    readMacRegistrationHeaders,
    registerLiveMacSession,
    resolvePairingCode,
    resolveTrustedMacSession,
    unregisterLiveMacSession,
  };
}

function macPhoneSessionKey(macDeviceId, phoneDeviceId) {
  return `${macDeviceId}|${phoneDeviceId}`;
}

function normalizeMacRegistration(registration, sessionId) {
  return {
    sessionId,
    macDeviceId: normalizeNonEmptyString(registration?.macDeviceId),
    macIdentityPublicKey: normalizeNonEmptyString(registration?.macIdentityPublicKey),
    displayName: normalizeNonEmptyString(registration?.displayName),
    trustedPhoneDeviceId: normalizeNonEmptyString(registration?.trustedPhoneDeviceId),
    trustedPhonePublicKey: normalizeNonEmptyString(registration?.trustedPhonePublicKey),
    pairingCode: normalizeShortPairingCode(registration?.pairingCode),
    pairingVersion: normalizePositiveInteger(registration?.pairingVersion),
    pairingExpiresAt: normalizePositiveInteger(registration?.pairingExpiresAt),
  };
}

function buildTrustedSessionResolveBytes({
  macDeviceId,
  phoneDeviceId,
  phoneIdentityPublicKey,
  nonce,
  timestamp,
}) {
  return Buffer.concat([
    encodeLengthPrefixedUTF8(TRUSTED_SESSION_RESOLVE_TAG),
    encodeLengthPrefixedUTF8(macDeviceId),
    encodeLengthPrefixedUTF8(phoneDeviceId),
    encodeLengthPrefixedData(Buffer.from(phoneIdentityPublicKey, "base64")),
    encodeLengthPrefixedUTF8(nonce),
    encodeLengthPrefixedUTF8(String(timestamp)),
  ]);
}

function verifyTrustedSessionResolveSignature(publicKeyBase64, transcriptBytes, signatureBase64) {
  try {
    return verify(
      null,
      transcriptBytes,
      createPublicKey({
        key: {
          crv: "Ed25519",
          kty: "OKP",
          x: base64ToBase64Url(publicKeyBase64),
        },
        format: "jwk",
      }),
      Buffer.from(signatureBase64, "base64")
    );
  } catch {
    return false;
  }
}

function encodeLengthPrefixedUTF8(value) {
  return encodeLengthPrefixedData(Buffer.from(value, "utf8"));
}

function encodeLengthPrefixedData(value) {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

function base64ToBase64Url(value) {
  return String(value || "")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeShortPairingCode(value) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");
  if (
    normalized.length < SHORT_PAIRING_CODE_MIN_LENGTH
    || normalized.length > SHORT_PAIRING_CODE_MAX_LENGTH
    || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/.test(normalized)
  ) {
    return "";
  }

  return normalized;
}

function normalizePositiveInteger(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}

function createRelayError(status, code, message) {
  return Object.assign(new Error(message), {
    status,
    code,
  });
}

function readHeaderString(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function safeParseJSON(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = {
  createTrustedSessionRegistry,
};
