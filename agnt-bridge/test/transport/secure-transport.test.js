// FILE: secure-transport.test.js
// Purpose: Verifies plaintext rejection and encrypted trusted reconnect round trips.
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
  generateKeyPairSync,
  hkdfSync,
  sign,
} = require("crypto");
const {
  HANDSHAKE_MODE_TRUSTED_RECONNECT,
  createBridgeSecureTransport,
} = require("../../src/transport/secure-transport");
const {
  createOkpKeyPair,
  buildTranscriptBytes,
  encodeLengthPrefixedUTF8,
  encryptEnvelope,
  decryptEnvelope,
  base64UrlToBase64,
  base64ToBase64Url,
} = require("./secure-transport-test-helpers");

test("secure transport rejects plaintext JSON-RPC before the secure handshake", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-1",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-1",
      macIdentityPrivateKey: base64UrlToBase64(privateJwk.d),
      macIdentityPublicKey: base64UrlToBase64(publicJwk.x),
      trustedPhones: {},
    },
  });

  const controlMessages = [];
  const handled = secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      id: "1",
      method: "initialize",
      params: {},
    }),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage() {
        throw new Error("plaintext application payload should not be forwarded");
      },
    }
  );

  assert.equal(handled, true);
  assert.equal(controlMessages[0]?.kind, "secureError");
  assert.equal(controlMessages[0]?.code, "update_required");
});

test("secure transport round-trips encrypted payloads after a trusted reconnect handshake", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-2",
    relayUrl: "wss://relay.example/relay",
    displayName: "Desk Mac",
    deviceState: {
      macDeviceId: "mac-2",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {
        "phone-2": phoneIdentity.publicKey,
      },
    },
  });

  const controlMessages = [];
  const applicationMessages = [];
  const wireMessages = [];
  secureTransport.bindLiveSendWireMessage((message) => {
    wireMessages.push(message);
  });

  const clientNonce = Buffer.alloc(32, 7);
  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientHello",
      protocolVersion: 1,
      sessionId: "session-2",
      handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
      phoneDeviceId: "phone-2",
      phoneIdentityPublicKey: phoneIdentity.publicKey,
      phoneEphemeralPublicKey: phoneEphemeral.publicKey,
      clientNonce: clientNonce.toString("base64"),
    }),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  const serverHello = controlMessages.find((message) => message.kind === "serverHello");
  assert.ok(serverHello, "expected serverHello");
  assert.equal(serverHello.displayName, "Desk Mac");

  const transcriptBytes = buildTranscriptBytes({
    sessionId: "session-2",
    protocolVersion: 1,
    handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
    keyEpoch: serverHello.keyEpoch,
    macDeviceId: "mac-2",
    phoneDeviceId: "phone-2",
    macIdentityPublicKey: macIdentity.publicKey,
    phoneIdentityPublicKey: phoneIdentity.publicKey,
    macEphemeralPublicKey: serverHello.macEphemeralPublicKey,
    phoneEphemeralPublicKey: phoneEphemeral.publicKey,
    clientNonce,
    serverNonce: Buffer.from(serverHello.serverNonce, "base64"),
    expiresAtForTranscript: 0,
  });
  const phoneAuthTranscript = Buffer.concat([
    transcriptBytes,
    encodeLengthPrefixedUTF8("client-auth"),
  ]);
  const phoneSignature = sign(
    null,
    phoneAuthTranscript,
    createPrivateKey({
      key: {
        crv: "Ed25519",
        d: base64ToBase64Url(phoneIdentity.privateKey),
        kty: "OKP",
        x: base64ToBase64Url(phoneIdentity.publicKey),
      },
      format: "jwk",
    })
  );

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "clientAuth",
      sessionId: "session-2",
      phoneDeviceId: "phone-2",
      keyEpoch: serverHello.keyEpoch,
      phoneSignature: phoneSignature.toString("base64"),
    }),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  const secureReady = controlMessages.find((message) => message.kind === "secureReady");
  assert.ok(secureReady, "expected secureReady");

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
  const infoPrefix = `agnt-e2ee-v1|session-2|mac-2|phone-2|${serverHello.keyEpoch}`;
  const phoneToMacKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|phoneToMac`, "utf8"), 32)
  );
  const macToPhoneKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|macToPhone`, "utf8"), 32)
  );

  secureTransport.handleIncomingWireMessage(
    JSON.stringify({
      kind: "resumeState",
      sessionId: "session-2",
      keyEpoch: serverHello.keyEpoch,
      lastAppliedBridgeOutboundSeq: 0,
      bridgeReplayEpoch: serverHello.bridgeReplayEpoch,
    }),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "response-1", result: { ok: true } }),
    (message) => {
      wireMessages.push(message);
    }
  );
  assert.equal(wireMessages.length, 1);

  const outboundEnvelope = JSON.parse(wireMessages[0]);
  const outboundPayload = decryptEnvelope(outboundEnvelope, macToPhoneKey);
  assert.equal(outboundPayload.bridgeOutboundSeq, 1);
  assert.equal(outboundPayload.payloadText, JSON.stringify({ id: "response-1", result: { ok: true } }));

  const inboundEnvelope = encryptEnvelope(
    {
      payloadText: JSON.stringify({ id: "request-1", method: "thread/list", params: {} }),
    },
    phoneToMacKey,
    "iphone",
    0,
    "session-2",
    serverHello.keyEpoch
  );
  secureTransport.handleIncomingWireMessage(
    JSON.stringify(inboundEnvelope),
    {
      sendControlMessage(message) {
        controlMessages.push(message);
      },
      onApplicationMessage(message) {
        applicationMessages.push(message);
      },
    }
  );

  assert.deepEqual(applicationMessages, [
    JSON.stringify({ id: "request-1", method: "thread/list", params: {} }),
  ]);
});
