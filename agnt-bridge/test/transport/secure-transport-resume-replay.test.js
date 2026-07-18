// FILE: secure-transport-resume-replay.test.js
// Purpose: Verifies secure transport relay replay and resume cursor behavior.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, crypto, ../../src/transport/secure-transport, ./secure-transport-test-helpers

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} = require("crypto");
const {
  HANDSHAKE_MODE_QR_BOOTSTRAP,
  HANDSHAKE_MODE_TRUSTED_RECONNECT,
  createBridgeSecureTransport,
} = require("../../src/transport/secure-transport");
const {
  finishHandshake,
  createOkpKeyPair,
  decryptEnvelope,
  deriveMacToPhoneKey,
  base64ToBase64Url,
} = require("./secure-transport-test-helpers");

test("rebinding the relay socket replays bridge output from the last phone ack", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-5",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-5",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });

  const { serverHello, transcriptBytes } = finishHandshake({
    secureTransport,
    sessionId: "session-5",
    macDeviceId: "mac-5",
    phoneDeviceId: "phone-5",
    macIdentity,
    phoneIdentity,
    phoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({
      key: {
        crv: "X25519",
        d: base64ToBase64Url(phoneEphemeral.privateKey),
        kty: "OKP",
        x: base64ToBase64Url(phoneEphemeral.publicKey),
      },
      format: "jwk",
    }),
    publicKey: createPublicKey({
      key: {
        crv: "X25519",
        kty: "OKP",
        x: base64ToBase64Url(serverHello.macEphemeralPublicKey),
      },
      format: "jwk",
    }),
  });
  const salt = createHash("sha256").update(transcriptBytes).digest();
  const infoPrefix = `agnt-e2ee-v1|session-5|mac-5|phone-5|${serverHello.keyEpoch}`;
  const macToPhoneKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|macToPhone`, "utf8"), 32)
  );

  secureTransport.bindLiveSendWireMessage(() => false);
  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "response-5", result: { ok: true } }),
    () => false
  );

  const firstRecoveryWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    firstRecoveryWireMessages.push(message);
    return true;
  });

  assert.equal(firstRecoveryWireMessages.length, 1);
  const outboundEnvelope = JSON.parse(firstRecoveryWireMessages[0]);
  const outboundPayload = decryptEnvelope(outboundEnvelope, macToPhoneKey);
  assert.equal(outboundPayload.bridgeOutboundSeq, 1);
  assert.equal(outboundPayload.payloadText, JSON.stringify({ id: "response-5", result: { ok: true } }));

  const liveWireMessages = [];
  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "response-6", result: { ok: true } }),
    () => {
      throw new Error("expected active relay sender to handle resumed output");
    }
  );

  secureTransport.bindLiveSendWireMessage((message) => {
    liveWireMessages.push(message);
    return true;
  });

  assert.equal(liveWireMessages.length, 2);
  const replayedPayloads = liveWireMessages.map((message) => {
    const envelope = JSON.parse(message);
    return decryptEnvelope(envelope, macToPhoneKey);
  });
  assert.deepEqual(
    replayedPayloads.map((payload) => payload.bridgeOutboundSeq),
    [1, 2]
  );
});

test("same-session relay replays keep live notifications untagged", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-replay-tag",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-replay-tag",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });

  const { serverHello, transcriptBytes } = finishHandshake({
    secureTransport,
    sessionId: "session-replay-tag",
    macDeviceId: "mac-replay-tag",
    phoneDeviceId: "phone-replay-tag",
    macIdentity,
    phoneIdentity,
    phoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });
  const macToPhoneKey = deriveMacToPhoneKey({
    sessionId: "session-replay-tag",
    macDeviceId: "mac-replay-tag",
    phoneDeviceId: "phone-replay-tag",
    phoneEphemeral,
    serverHello,
    transcriptBytes,
  });

  const liveWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    liveWireMessages.push(message);
    return true;
  });

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ method: "turn/started", params: { threadId: "thread-live" } }),
    () => false
  );
  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "response-live", result: { ok: true } }),
    () => false
  );

  assert.equal(liveWireMessages.length, 2);
  const livePayload = JSON.parse(decryptEnvelope(JSON.parse(liveWireMessages[0]), macToPhoneKey).payloadText);
  assert.equal(livePayload.params.agntReplayedEvent, undefined);

  const replayWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    replayWireMessages.push(message);
    return true;
  });

  assert.equal(replayWireMessages.length, 2);
  const replayedNotification = decryptEnvelope(JSON.parse(replayWireMessages[0]), macToPhoneKey);
  const replayedNotificationPayload = JSON.parse(replayedNotification.payloadText);
  assert.equal(replayedNotificationPayload.method, "turn/started");
  assert.equal(replayedNotificationPayload.params.threadId, "thread-live");
  assert.equal(replayedNotificationPayload.params.agntReplayedEvent, undefined);

  const replayedResponse = decryptEnvelope(JSON.parse(replayWireMessages[1]), macToPhoneKey);
  assert.equal(
    replayedResponse.payloadText,
    JSON.stringify({ id: "response-live", result: { ok: true } })
  );
});

test("previous-session replayed notifications are tagged as catch-up history", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-previous-replay-tag",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-previous-replay-tag",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });

  finishHandshake({
    secureTransport,
    sessionId: "session-previous-replay-tag",
    macDeviceId: "mac-previous-replay-tag",
    phoneDeviceId: "phone-previous-replay-tag",
    macIdentity,
    phoneIdentity,
    phoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  let captureReplay = false;
  const replayWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    if (captureReplay) {
      replayWireMessages.push(message);
    }
    return true;
  });

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ method: "turn/started", params: { threadId: "thread-previous-session" } }),
    () => false
  );

  const reconnectEphemeral = createOkpKeyPair("x25519");
  captureReplay = true;
  const { serverHello, transcriptBytes } = finishHandshake({
    secureTransport,
    sessionId: "session-previous-replay-tag",
    macDeviceId: "mac-previous-replay-tag",
    phoneDeviceId: "phone-previous-replay-tag",
    macIdentity,
    phoneIdentity,
    phoneEphemeral: reconnectEphemeral,
    handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
    lastAppliedBridgeOutboundSeq: 0,
  });
  const macToPhoneKey = deriveMacToPhoneKey({
    sessionId: "session-previous-replay-tag",
    macDeviceId: "mac-previous-replay-tag",
    phoneDeviceId: "phone-previous-replay-tag",
    phoneEphemeral: reconnectEphemeral,
    serverHello,
    transcriptBytes,
  });

  assert.equal(replayWireMessages.length, 2);
  const replayedNotification = decryptEnvelope(JSON.parse(replayWireMessages[0]), macToPhoneKey);
  const replayedNotificationPayload = JSON.parse(replayedNotification.payloadText);
  assert.equal(replayedNotificationPayload.method, "turn/started");
  assert.equal(replayedNotificationPayload.params.threadId, "thread-previous-session");
  assert.equal(replayedNotificationPayload.params.agntReplayedEvent, true);
  const completionMarker = decryptEnvelope(JSON.parse(replayWireMessages[1]), macToPhoneKey);
  const completionPayload = JSON.parse(completionMarker.payloadText);
  assert.equal(completionPayload.method, "agnt/bufferedReplay/completed");
  assert.equal(completionPayload.params.agntBufferedReplayComplete, true);
});

test("truncated resume replay declares a canonical-history gap", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-truncated-replay",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-truncated-replay",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });

  finishHandshake({
    secureTransport,
    sessionId: "session-truncated-replay",
    macDeviceId: "mac-truncated-replay",
    phoneDeviceId: "phone-truncated-replay",
    macIdentity,
    phoneIdentity,
    phoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  let captureReplay = false;
  const replayWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    if (captureReplay) {
      replayWireMessages.push(message);
    }
    return true;
  });

  for (let index = 0; index < 505; index += 1) {
    secureTransport.queueOutboundApplicationMessage(
      JSON.stringify({
        method: "item/updated",
        params: { threadId: "thread-truncated-replay", itemId: `item-${index}` },
      }),
      () => false
    );
  }

  const reconnectEphemeral = createOkpKeyPair("x25519");
  captureReplay = true;
  const { serverHello, transcriptBytes } = finishHandshake({
    secureTransport,
    sessionId: "session-truncated-replay",
    macDeviceId: "mac-truncated-replay",
    phoneDeviceId: "phone-truncated-replay",
    macIdentity,
    phoneIdentity,
    phoneEphemeral: reconnectEphemeral,
    handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
    lastAppliedBridgeOutboundSeq: 0,
  });
  const macToPhoneKey = deriveMacToPhoneKey({
    sessionId: "session-truncated-replay",
    macDeviceId: "mac-truncated-replay",
    phoneDeviceId: "phone-truncated-replay",
    phoneEphemeral: reconnectEphemeral,
    serverHello,
    transcriptBytes,
  });

  assert.equal(replayWireMessages.length, 2);
  const gapPayload = decryptEnvelope(JSON.parse(replayWireMessages[0]), macToPhoneKey);
  const gapMessage = JSON.parse(gapPayload.payloadText);
  assert.equal(gapMessage.method, "agnt/bufferedReplay/gap");
  assert.deepEqual(gapMessage.params, {
    agntBufferedReplayGap: true,
    expectedBridgeOutboundSeq: 1,
    firstAvailableBridgeOutboundSeq: 6,
    lastDiscardedBridgeOutboundSeq: 505,
  });

  const completionPayload = decryptEnvelope(JSON.parse(replayWireMessages[1]), macToPhoneKey);
  const completionMessage = JSON.parse(completionPayload.payloadText);
  assert.equal(completionMessage.method, "agnt/bufferedReplay/completed");
  assert.equal(completionMessage.params.agntBufferedReplayComplete, true);
});
