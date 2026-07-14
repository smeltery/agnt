// FILE: secure-transport-resume-cursor.test.js
// Purpose: Verifies secure transport resume cursor and stale cursor behavior.
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
  base64ToBase64Url,
} = require("./secure-transport-test-helpers");

test("resume replay does not advance the replay watermark before a phone ack", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-6",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-6",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });

  const initialReplayWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    initialReplayWireMessages.push(message);
    return true;
  });

  const { serverHello, transcriptBytes } = finishHandshake({
    secureTransport,
    sessionId: "session-6",
    macDeviceId: "mac-6",
    phoneDeviceId: "phone-6",
    macIdentity,
    phoneIdentity,
    phoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
    skipResumeState: true,
  });

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "response-6", result: { ok: true } }),
    () => {
      throw new Error("expected bound sender to stay attached after secureReady");
    }
  );

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "resumeState",
      sessionId: "session-6",
      keyEpoch: serverHello.keyEpoch,
      lastAppliedBridgeOutboundSeq: 0,
      bridgeReplayEpoch: serverHello.bridgeReplayEpoch,
    }),
    {
      sendControlMessage() {},
      onApplicationMessage() {},
    }
  );

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
  const infoPrefix = `agnt-e2ee-v1|session-6|mac-6|phone-6|${serverHello.keyEpoch}`;
  const macToPhoneKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|macToPhone`, "utf8"), 32)
  );

  assert.equal(initialReplayWireMessages.length, 1);

  const reboundWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    reboundWireMessages.push(message);
    return true;
  });

  assert.equal(reboundWireMessages.length, 1);
  const reboundEnvelope = JSON.parse(reboundWireMessages[0]);
  const reboundPayload = decryptEnvelope(reboundEnvelope, macToPhoneKey);
  assert.equal(reboundPayload.bridgeOutboundSeq, 1);
  assert.equal(reboundPayload.payloadText, JSON.stringify({ id: "response-6", result: { ok: true } }));
});

test("resume replay keeps current handshake output when the phone cursor is stale", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-7",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-7",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {
        "phone-7": phoneIdentity.publicKey,
      },
    },
  });

  const replayWireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    replayWireMessages.push(message);
    return true;
  });

  const { serverHello, transcriptBytes } = finishHandshake({
    secureTransport,
    sessionId: "session-7",
    macDeviceId: "mac-7",
    phoneDeviceId: "phone-7",
    macIdentity,
    phoneIdentity,
    phoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
    lastAppliedBridgeOutboundSeq: 0,
    skipResumeState: true,
  });

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "initialize", result: { ok: true } }),
    () => {
      throw new Error("expected buffered initialize response to wait for resumeState");
    }
  );

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "resumeState",
      sessionId: "session-7",
      keyEpoch: serverHello.keyEpoch,
      lastAppliedBridgeOutboundSeq: 999,
      bridgeReplayEpoch: serverHello.bridgeReplayEpoch,
    }),
    {
      sendControlMessage() {},
      onApplicationMessage() {},
    }
  );

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
  const infoPrefix = `agnt-e2ee-v1|session-7|mac-7|phone-7|${serverHello.keyEpoch}`;
  const macToPhoneKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|macToPhone`, "utf8"), 32)
  );

  assert.equal(replayWireMessages.length, 2);
  const resetEnvelope = JSON.parse(replayWireMessages[0]);
  const resetPayload = decryptEnvelope(resetEnvelope, macToPhoneKey);
  const resetMessage = JSON.parse(resetPayload.payloadText);
  assert.equal(resetMessage.method, "agnt/bufferedReplay/reset");
  assert.deepEqual(resetMessage.params, {
    agntBufferedReplayReset: true,
    resetBridgeOutboundSeqTo: 0,
    bridgeReplayEpoch: serverHello.bridgeReplayEpoch,
  });

  const outboundEnvelope = JSON.parse(replayWireMessages[1]);
  const outboundPayload = decryptEnvelope(outboundEnvelope, macToPhoneKey);
  assert.equal(outboundPayload.bridgeOutboundSeq, 1);
  assert.equal(outboundPayload.payloadText, JSON.stringify({ id: "initialize", result: { ok: true } }));
});
