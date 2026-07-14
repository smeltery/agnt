// FILE: secure-transport.js
// Purpose: Owns the bridge-side E2EE handshake, envelope crypto, and reconnect catch-up buffer.
// Layer: CLI helper
// Exports: createBridgeSecureTransport, SECURE_PROTOCOL_VERSION, PAIRING_QR_VERSION
// Depends on: crypto, ./secure-device-state

const {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} = require("crypto");
const {
  getTrustedPhonePublicKey,
  rememberTrustedPhone,
} = require("./secure-device-state");
const {
  HANDSHAKE_TAG,
  SECURE_SENDER_IPHONE,
  base64ToBase64Url,
  base64ToBuffer,
  base64UrlToBase64,
  buildTranscriptBytes,
  debugSecureLog,
  decryptEnvelopeBuffer,
  deriveAesKey,
  encodeLengthPrefixedUTF8,
  nonceForDirection,
  normalizeNonEmptyString,
  safeParseJSON,
  shortFingerprint,
  shortId,
  signTranscript,
  transcriptDigest,
  verifyTranscript,
} = require("./secure-transport-crypto");
const { createSecureTransportReplayBuffer } = require("./secure-transport-replay-buffer");

const PAIRING_QR_VERSION = 2;
const SECURE_PROTOCOL_VERSION = 1;
const HANDSHAKE_MODE_QR_BOOTSTRAP = "qr_bootstrap";
const HANDSHAKE_MODE_TRUSTED_RECONNECT = "trusted_reconnect";
const MAX_PAIRING_AGE_MS = 5 * 60 * 1000;
const MAX_BRIDGE_OUTBOUND_MESSAGES = 500;
const MAX_BRIDGE_OUTBOUND_BYTES = 10 * 1024 * 1024;

function createBridgeSecureTransport({
  sessionId,
  relayUrl,
  deviceState,
  displayName = "",
  onTrustedPhoneUpdate = null,
}) {
  let currentDeviceState = deviceState;
  const bridgeDisplayName = normalizeNonEmptyString(displayName);
  let pendingHandshake = null;
  let activeSession = null;
  let liveSendWireMessage = null;
  // Tracks the highest bridge seq the phone has definitely acked, so replay
  // decisions never depend on best-effort local socket writes.
  let lastRelayedBridgeOutboundSeq = 0;
  let currentPairingExpiresAt = Date.now() + MAX_PAIRING_AGE_MS;
  let nextKeyEpoch = 1;
  const bridgeReplayEpoch = randomBytes(16).toString("hex");
  const replayBuffer = createSecureTransportReplayBuffer({
    bridgeReplayEpoch,
    getActiveSession: () => activeSession,
    getLastRelayedBridgeOutboundSeq: () => lastRelayedBridgeOutboundSeq,
    getSessionId: () => sessionId,
    maxOutboundBytes: MAX_BRIDGE_OUTBOUND_BYTES,
    maxOutboundMessages: MAX_BRIDGE_OUTBOUND_MESSAGES,
    protocolVersion: SECURE_PROTOCOL_VERSION,
    setLastRelayedBridgeOutboundSeq: (value) => { lastRelayedBridgeOutboundSeq = value; },
  });

  function createPairingPayload() {
    currentPairingExpiresAt = Date.now() + MAX_PAIRING_AGE_MS;
    return {
      v: PAIRING_QR_VERSION,
      relay: relayUrl,
      sessionId,
      macDeviceId: currentDeviceState.macDeviceId,
      macIdentityPublicKey: currentDeviceState.macIdentityPublicKey,
      expiresAt: currentPairingExpiresAt,
      displayName: bridgeDisplayName,
    };
  }

  function handleIncomingWireMessage(rawMessage, { sendControlMessage, onApplicationMessage }) {
    const parsed = safeParseJSON(rawMessage);
    if (!parsed || typeof parsed !== "object") {
      return false;
    }

    const kind = normalizeNonEmptyString(parsed.kind);
    if (!kind) {
      if (parsed.method || parsed.id != null) {
        sendControlMessage(createSecureError({
          code: "update_required",
          message: "This bridge requires the latest agnt iPhone app for secure pairing.",
        }));
        return true;
      }
      return false;
    }

    switch (kind) {
    case "clientHello":
      handleClientHello(parsed, sendControlMessage);
      return true;
    case "clientAuth":
      handleClientAuth(parsed, sendControlMessage);
      return true;
    case "resumeState":
      handleResumeState(parsed);
      return true;
    case "encryptedEnvelope":
      return handleEncryptedEnvelope(parsed, sendControlMessage, onApplicationMessage);
    default:
      return false;
    }
  }

  function queueOutboundApplicationMessage(payloadText, sendWireMessage) {
    const normalizedPayload = normalizeNonEmptyString(payloadText);
    if (!normalizedPayload) {
      return;
    }
    replayBuffer.queueOutboundApplicationMessage(normalizedPayload, sendWireMessage);
  }

  function isSecureChannelReady() {
    return Boolean(activeSession?.isResumed);
  }

  function handleClientHello(message, sendControlMessage) {
    const protocolVersion = Number(message.protocolVersion);
    const incomingSessionId = normalizeNonEmptyString(message.sessionId);
    const handshakeMode = normalizeNonEmptyString(message.handshakeMode);
    const phoneDeviceId = normalizeNonEmptyString(message.phoneDeviceId);
    const phoneIdentityPublicKey = normalizeNonEmptyString(message.phoneIdentityPublicKey);
    const phoneEphemeralPublicKey = normalizeNonEmptyString(message.phoneEphemeralPublicKey);
    const clientNonceBase64 = normalizeNonEmptyString(message.clientNonce);

    if (protocolVersion !== SECURE_PROTOCOL_VERSION || incomingSessionId !== sessionId) {
      sendControlMessage(createSecureError({
        code: "update_required",
        message: "The bridge and iPhone are not using the same secure transport version.",
      }));
      return;
    }

    if (!phoneDeviceId || !phoneIdentityPublicKey || !phoneEphemeralPublicKey || !clientNonceBase64) {
      sendControlMessage(createSecureError({
        code: "invalid_client_hello",
        message: "The iPhone handshake is missing required secure fields.",
      }));
      return;
    }

    if (handshakeMode !== HANDSHAKE_MODE_QR_BOOTSTRAP && handshakeMode !== HANDSHAKE_MODE_TRUSTED_RECONNECT) {
      sendControlMessage(createSecureError({
        code: "invalid_handshake_mode",
        message: "The iPhone requested an unknown secure pairing mode.",
      }));
      return;
    }

    if (handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP && Date.now() > currentPairingExpiresAt) {
      sendControlMessage(createSecureError({
        code: "pairing_expired",
        message: "The pairing QR code has expired. Generate a new QR code from the bridge.",
      }));
      return;
    }

    const trustedPhonePublicKey = getTrustedPhonePublicKey(currentDeviceState, phoneDeviceId);
    if (handshakeMode === HANDSHAKE_MODE_TRUSTED_RECONNECT) {
      if (!trustedPhonePublicKey) {
        sendControlMessage(createSecureError({
          code: "phone_not_trusted",
          message: "This iPhone is not trusted by the current bridge session. Scan a fresh QR code to pair again.",
        }));
        return;
      }
      if (trustedPhonePublicKey !== phoneIdentityPublicKey) {
        sendControlMessage(createSecureError({
          code: "phone_identity_changed",
          message: "The trusted iPhone identity does not match this reconnect attempt.",
        }));
        return;
      }
    }

    const clientNonce = base64ToBuffer(clientNonceBase64);
    if (!clientNonce || clientNonce.length === 0) {
      sendControlMessage(createSecureError({
        code: "invalid_client_nonce",
        message: "The iPhone secure nonce could not be decoded.",
      }));
      return;
    }

    const ephemeral = generateKeyPairSync("x25519");
    const privateJwk = ephemeral.privateKey.export({ format: "jwk" });
    const publicJwk = ephemeral.publicKey.export({ format: "jwk" });
    const serverNonce = randomBytes(32);
    const keyEpoch = nextKeyEpoch;
    const expiresAtForTranscript = handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP
      ? currentPairingExpiresAt
      : 0;
    const transcriptBytes = buildTranscriptBytes({
      sessionId,
      protocolVersion,
      handshakeMode,
      keyEpoch,
      macDeviceId: currentDeviceState.macDeviceId,
      phoneDeviceId,
      macIdentityPublicKey: currentDeviceState.macIdentityPublicKey,
      phoneIdentityPublicKey,
      macEphemeralPublicKey: base64UrlToBase64(publicJwk.x),
      phoneEphemeralPublicKey,
      clientNonce,
      serverNonce,
      expiresAtForTranscript,
    });
    const macSignature = signTranscript(
      currentDeviceState.macIdentityPrivateKey,
      currentDeviceState.macIdentityPublicKey,
      transcriptBytes
    );
    debugSecureLog(
      `serverHello mode=${handshakeMode} session=${shortId(sessionId)} keyEpoch=${keyEpoch} `
      + `mac=${shortId(currentDeviceState.macDeviceId)} phone=${shortId(phoneDeviceId)} `
      + `macKey=${shortFingerprint(currentDeviceState.macIdentityPublicKey)} `
      + `phoneKey=${shortFingerprint(phoneIdentityPublicKey)} `
      + `transcript=${transcriptDigest(transcriptBytes)}`
    );

    pendingHandshake = {
      sessionId,
      handshakeMode,
      keyEpoch,
      phoneDeviceId,
      phoneIdentityPublicKey,
      phoneEphemeralPublicKey,
      macEphemeralPrivateKey: base64UrlToBase64(privateJwk.d),
      macEphemeralPublicKey: base64UrlToBase64(publicJwk.x),
      transcriptBytes,
      expiresAtForTranscript,
    };
    activeSession = null;

    sendControlMessage({
      kind: "serverHello",
      protocolVersion: SECURE_PROTOCOL_VERSION,
      sessionId,
      handshakeMode,
      macDeviceId: currentDeviceState.macDeviceId,
      macIdentityPublicKey: currentDeviceState.macIdentityPublicKey,
      macEphemeralPublicKey: pendingHandshake.macEphemeralPublicKey,
      serverNonce: serverNonce.toString("base64"),
      keyEpoch,
      bridgeReplayEpoch,
      expiresAtForTranscript,
      macSignature,
      clientNonce: clientNonceBase64,
      displayName: bridgeDisplayName,
    });
  }

  function handleClientAuth(message, sendControlMessage) {
    if (!pendingHandshake) {
      sendControlMessage(createSecureError({
        code: "unexpected_client_auth",
        message: "The bridge did not have a pending secure handshake to finalize.",
      }));
      return;
    }

    const incomingSessionId = normalizeNonEmptyString(message.sessionId);
    const phoneDeviceId = normalizeNonEmptyString(message.phoneDeviceId);
    const keyEpoch = Number(message.keyEpoch);
    const phoneSignature = normalizeNonEmptyString(message.phoneSignature);
    if (
      incomingSessionId !== pendingHandshake.sessionId
      || phoneDeviceId !== pendingHandshake.phoneDeviceId
      || keyEpoch !== pendingHandshake.keyEpoch
      || !phoneSignature
    ) {
      pendingHandshake = null;
      sendControlMessage(createSecureError({
        code: "invalid_client_auth",
        message: "The secure client authentication payload was invalid.",
      }));
      return;
    }

    const clientAuthTranscript = Buffer.concat([
      pendingHandshake.transcriptBytes,
      encodeLengthPrefixedUTF8("client-auth"),
    ]);
    const phoneVerified = verifyTranscript(
      pendingHandshake.phoneIdentityPublicKey,
      clientAuthTranscript,
      phoneSignature
    );
    if (!phoneVerified) {
      pendingHandshake = null;
      sendControlMessage(createSecureError({
        code: "invalid_phone_signature",
        message: "The iPhone secure signature could not be verified.",
      }));
      return;
    }

    const sharedSecret = diffieHellman({
      privateKey: createPrivateKey({
        key: {
          crv: "X25519",
          d: base64ToBase64Url(pendingHandshake.macEphemeralPrivateKey),
          kty: "OKP",
          x: base64ToBase64Url(pendingHandshake.macEphemeralPublicKey),
        },
        format: "jwk",
      }),
      publicKey: createPublicKey({
        key: {
          crv: "X25519",
          kty: "OKP",
          x: base64ToBase64Url(pendingHandshake.phoneEphemeralPublicKey),
        },
        format: "jwk",
      }),
    });
    const salt = createHash("sha256").update(pendingHandshake.transcriptBytes).digest();
    const infoPrefix = [
      HANDSHAKE_TAG,
      pendingHandshake.sessionId,
      currentDeviceState.macDeviceId,
      pendingHandshake.phoneDeviceId,
      String(pendingHandshake.keyEpoch),
    ].join("|");

    activeSession = {
      sessionId: pendingHandshake.sessionId,
      keyEpoch: pendingHandshake.keyEpoch,
      phoneDeviceId: pendingHandshake.phoneDeviceId,
      phoneIdentityPublicKey: pendingHandshake.phoneIdentityPublicKey,
      phoneToMacKey: deriveAesKey(sharedSecret, salt, `${infoPrefix}|phoneToMac`),
      macToPhoneKey: deriveAesKey(sharedSecret, salt, `${infoPrefix}|macToPhone`),
      lastInboundCounter: -1,
      nextOutboundCounter: 0,
      isResumed: false,
      sendWireMessage: liveSendWireMessage,
      firstOutboundSeq: replayBuffer.nextSeq(),
    };

    nextKeyEpoch = pendingHandshake.keyEpoch + 1;
    if (
      pendingHandshake.handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP
      || getTrustedPhonePublicKey(currentDeviceState, pendingHandshake.phoneDeviceId)
    ) {
      // Lock the trusted phone identity so later reconnects can be verified cleanly.
      const previousTrustedPhonePublicKey = getTrustedPhonePublicKey(
        currentDeviceState,
        pendingHandshake.phoneDeviceId
      );
      currentDeviceState = rememberTrustedPhone(
        currentDeviceState,
        pendingHandshake.phoneDeviceId,
        pendingHandshake.phoneIdentityPublicKey
      );
      if (previousTrustedPhonePublicKey !== pendingHandshake.phoneIdentityPublicKey) {
        onTrustedPhoneUpdate?.(currentDeviceState);
      }
    }
    if (pendingHandshake.handshakeMode === HANDSHAKE_MODE_QR_BOOTSTRAP) {
      replayBuffer.resetOutboundReplayState();
      activeSession.firstOutboundSeq = replayBuffer.nextSeq();
    }

    pendingHandshake = null;
    sendControlMessage({
      kind: "secureReady",
      sessionId,
      keyEpoch: activeSession.keyEpoch,
      macDeviceId: currentDeviceState.macDeviceId,
    });
  }

  function handleResumeState(message) {
    if (!activeSession) {
      return;
    }

    const incomingSessionId = normalizeNonEmptyString(message.sessionId);
    const keyEpoch = Number(message.keyEpoch);
    if (incomingSessionId !== sessionId || keyEpoch !== activeSession.keyEpoch) {
      return;
    }

    const lastAppliedBridgeOutboundSeq = Number(message.lastAppliedBridgeOutboundSeq) || 0;
    const phoneReplayEpoch = normalizeNonEmptyString(message.bridgeReplayEpoch);
    replayBuffer.handleResumeState({
      activeSession,
      lastAppliedBridgeOutboundSeq,
      phoneReplayEpoch,
    });
  }

  function handleEncryptedEnvelope(message, sendControlMessage, onApplicationMessage) {
    if (!activeSession) {
      sendControlMessage(createSecureError({
        code: "secure_channel_unavailable",
        message: "The secure channel is not ready yet on the bridge.",
      }));
      return true;
    }

    const incomingSessionId = normalizeNonEmptyString(message.sessionId);
    const keyEpoch = Number(message.keyEpoch);
    const sender = normalizeNonEmptyString(message.sender);
    const counter = Number(message.counter);
    if (
      incomingSessionId !== sessionId
      || keyEpoch !== activeSession.keyEpoch
      || sender !== SECURE_SENDER_IPHONE
      || !Number.isInteger(counter)
      || counter <= activeSession.lastInboundCounter
    ) {
      sendControlMessage(createSecureError({
        code: "invalid_envelope",
        message: "The bridge rejected an invalid or replayed secure envelope.",
      }));
      return true;
    }

    const plaintextBuffer = decryptEnvelopeBuffer(message, activeSession.phoneToMacKey, SECURE_SENDER_IPHONE, counter);
    if (!plaintextBuffer) {
      sendControlMessage(createSecureError({
        code: "decrypt_failed",
        message: "The bridge could not decrypt the iPhone secure payload.",
      }));
      return true;
    }

    activeSession.lastInboundCounter = counter;
    const payloadObject = safeParseJSON(plaintextBuffer.toString("utf8"));
    const payloadText = normalizeNonEmptyString(payloadObject?.payloadText);
    if (!payloadText) {
      sendControlMessage(createSecureError({
        code: "invalid_payload",
        message: "The secure payload did not contain a usable application message.",
      }));
      return true;
    }

    onApplicationMessage(payloadText);
    return true;
  }

  function bindLiveSendWireMessage(sendWireMessage) {
    liveSendWireMessage = sendWireMessage;
    if (activeSession) {
      activeSession.sendWireMessage = sendWireMessage;
      replayBuffer.replayBufferedOutboundMessages();
    }
  }

  return {
    PAIRING_QR_VERSION,
    SECURE_PROTOCOL_VERSION,
    bindLiveSendWireMessage,
    createPairingPayload,
    handleIncomingWireMessage,
    isSecureChannelReady,
    queueOutboundApplicationMessage,
  };
}

function createSecureError({ code, message }) {
  return {
    kind: "secureError",
    code,
    message,
  };
}

module.exports = {
  HANDSHAKE_MODE_QR_BOOTSTRAP,
  HANDSHAKE_MODE_TRUSTED_RECONNECT,
  PAIRING_QR_VERSION,
  SECURE_PROTOCOL_VERSION,
  createBridgeSecureTransport,
  nonceForDirection,
};
