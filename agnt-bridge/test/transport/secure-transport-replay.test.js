// FILE: secure-transport-replay.test.js
// Purpose: Verifies QR bootstrap and relay replay behavior for secure transport.
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

test("qr bootstrap allows a fresh QR scan to replace the trusted iPhone", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const firstPhoneIdentity = createOkpKeyPair("ed25519");
  const firstPhoneEphemeral = createOkpKeyPair("x25519");
  const secondPhoneIdentity = createOkpKeyPair("ed25519");
  const secondPhoneEphemeral = createOkpKeyPair("x25519");
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-3",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-3",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });

  finishHandshake({
    secureTransport,
    sessionId: "session-3",
    macDeviceId: "mac-3",
    phoneDeviceId: "phone-3a",
    macIdentity,
    phoneIdentity: firstPhoneIdentity,
    phoneEphemeral: firstPhoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  finishHandshake({
    secureTransport,
    sessionId: "session-3",
    macDeviceId: "mac-3",
    phoneDeviceId: "phone-3b",
    macIdentity,
    phoneIdentity: secondPhoneIdentity,
    phoneEphemeral: secondPhoneEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });
});

test("qr bootstrap starts a fresh replay window instead of leaking buffered messages", () => {
  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const firstEphemeral = createOkpKeyPair("x25519");
  const secondEphemeral = createOkpKeyPair("x25519");
  const wireMessages = [];
  const secureTransport = createBridgeSecureTransport({
    sessionId: "session-4",
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId: "mac-4",
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: {},
    },
  });
  secureTransport.bindLiveSendWireMessage((message) => {
    wireMessages.push(message);
  });

  finishHandshake({
    secureTransport,
    sessionId: "session-4",
    macDeviceId: "mac-4",
    phoneDeviceId: "phone-4",
    macIdentity,
    phoneIdentity,
    phoneEphemeral: firstEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  secureTransport.queueOutboundApplicationMessage(
    JSON.stringify({ id: "stale-response", result: { ok: true } }),
    (message) => {
      wireMessages.push(message);
    }
  );
  assert.equal(wireMessages.length, 1);

  finishHandshake({
    secureTransport,
    sessionId: "session-4",
    macDeviceId: "mac-4",
    phoneDeviceId: "phone-4",
    macIdentity,
    phoneIdentity,
    phoneEphemeral: secondEphemeral,
    handshakeMode: HANDSHAKE_MODE_QR_BOOTSTRAP,
    lastAppliedBridgeOutboundSeq: 0,
  });

  assert.equal(wireMessages.length, 1);
});
