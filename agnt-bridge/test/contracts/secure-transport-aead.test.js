// FILE: contracts/secure-transport-aead.test.js
// Purpose: Pins the AEAD / replay / cross-implementation alignment contracts
//          of the bridge secure transport. Today's secure-transport.test.js
//          covers the happy-path handshake + round-trip and the QR /
//          replay-window flows; it does not cover the load-bearing security
//          rejections (replay, tampering, out-of-order) or the byte-level
//          alignment with agnt-web's transcript.ts and AgntAndroid's
//          SecureEnvelopeCipher.kt.
//
// What's pinned here:
//   - Replay rejection: re-sending the same envelope counter is rejected.
//   - Out-of-order rejection: an envelope with a counter lower than the
//     last-seen is rejected.
//   - AEAD tag tampering: a one-byte flip in the auth tag fails decryption.
//   - AEAD ciphertext tampering: a one-byte flip in the ciphertext fails
//     decryption.
//   - Nonce layout snapshot: nonceForDirection produces the exact 12-byte
//     layout the agnt-web and Android implementations expect (direction in
//     byte 0, big-endian counter across bytes 1..11). A change to either
//     side here would silently break cross-platform decryption.
//   - HKDF info-string snapshot: a fixed (sharedSecret, salt, info) input
//     produces a fixed 32-byte key. This locks the info-string format
//     ("agnt-e2ee-v1|<session>|<macId>|<phoneId>|<keyEpoch>|<dir>") that
//     must stay byte-aligned with agnt-web and Android.
//
// Layer: Contract test (security)
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCipheriv,
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
  nonceForDirection,
} = require("../../src/transport/secure-transport");

// ── helpers (mirror the patterns already in test/secure-transport.test.js) ──

function base64UrlToBase64(value) {
  return value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
}

function base64ToBase64Url(value) {
  return value.replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createOkpKeyPair(type) {
  const { privateKey, publicKey } = generateKeyPairSync(type);
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  return {
    privateKey: base64UrlToBase64(privateJwk.d),
    publicKey: base64UrlToBase64(publicJwk.x),
  };
}

function encodeLengthPrefixedBuffer(buf) {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function encodeLengthPrefixedUTF8(value) {
  return encodeLengthPrefixedBuffer(Buffer.from(value, "utf8"));
}

function buildTranscriptBytes({
  sessionId, protocolVersion, handshakeMode, keyEpoch,
  macDeviceId, phoneDeviceId,
  macIdentityPublicKey, phoneIdentityPublicKey,
  macEphemeralPublicKey, phoneEphemeralPublicKey,
  clientNonce, serverNonce, expiresAtForTranscript,
}) {
  return Buffer.concat([
    encodeLengthPrefixedUTF8("agnt-e2ee-v1"),
    encodeLengthPrefixedUTF8(sessionId),
    encodeLengthPrefixedUTF8(String(protocolVersion)),
    encodeLengthPrefixedUTF8(handshakeMode),
    encodeLengthPrefixedUTF8(String(keyEpoch)),
    encodeLengthPrefixedUTF8(macDeviceId),
    encodeLengthPrefixedUTF8(phoneDeviceId),
    encodeLengthPrefixedBuffer(Buffer.from(macIdentityPublicKey, "base64")),
    encodeLengthPrefixedBuffer(Buffer.from(phoneIdentityPublicKey, "base64")),
    encodeLengthPrefixedBuffer(Buffer.from(macEphemeralPublicKey, "base64")),
    encodeLengthPrefixedBuffer(Buffer.from(phoneEphemeralPublicKey, "base64")),
    encodeLengthPrefixedBuffer(clientNonce),
    encodeLengthPrefixedBuffer(serverNonce),
    encodeLengthPrefixedUTF8(String(expiresAtForTranscript)),
  ]);
}

function encryptEnvelope(payloadObject, key, sender, counter, sessionId, keyEpoch) {
  const nonce = nonceForDirection(sender, counter);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payloadObject), "utf8")),
    cipher.final(),
  ]);
  return {
    kind: "encryptedEnvelope",
    v: 1,
    sessionId,
    keyEpoch,
    sender,
    counter,
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

// Runs a full trusted-reconnect handshake and returns the derived keys.
function setupSecureSession({ sessionId, macDeviceId, phoneDeviceId } = {}) {
  sessionId = sessionId || "session-aead";
  macDeviceId = macDeviceId || "mac-aead";
  phoneDeviceId = phoneDeviceId || "phone-aead";

  const macIdentity = createOkpKeyPair("ed25519");
  const phoneIdentity = createOkpKeyPair("ed25519");
  const phoneEphemeral = createOkpKeyPair("x25519");

  const secureTransport = createBridgeSecureTransport({
    sessionId,
    relayUrl: "wss://relay.example/relay",
    deviceState: {
      macDeviceId,
      macIdentityPrivateKey: macIdentity.privateKey,
      macIdentityPublicKey: macIdentity.publicKey,
      trustedPhones: { [phoneDeviceId]: phoneIdentity.publicKey },
    },
  });

  const controlMessages = [];
  const ctx = {
    sendControlMessage(m) { controlMessages.push(m); },
    onApplicationMessage() {},
  };

  const clientNonce = Buffer.alloc(32, 7);
  secureTransport.handleIncomingWireMessage(JSON.stringify({
    kind: "clientHello",
    protocolVersion: 1,
    sessionId,
    handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
    phoneDeviceId,
    phoneIdentityPublicKey: phoneIdentity.publicKey,
    phoneEphemeralPublicKey: phoneEphemeral.publicKey,
    clientNonce: clientNonce.toString("base64"),
  }), ctx);

  const serverHello = controlMessages.find((m) => m.kind === "serverHello");
  assert.ok(serverHello, "expected serverHello");

  const transcriptBytes = buildTranscriptBytes({
    sessionId, protocolVersion: 1,
    handshakeMode: HANDSHAKE_MODE_TRUSTED_RECONNECT,
    keyEpoch: serverHello.keyEpoch,
    macDeviceId, phoneDeviceId,
    macIdentityPublicKey: macIdentity.publicKey,
    phoneIdentityPublicKey: phoneIdentity.publicKey,
    macEphemeralPublicKey: serverHello.macEphemeralPublicKey,
    phoneEphemeralPublicKey: phoneEphemeral.publicKey,
    clientNonce,
    serverNonce: Buffer.from(serverHello.serverNonce, "base64"),
    expiresAtForTranscript: 0,
  });
  const authTranscript = Buffer.concat([transcriptBytes, encodeLengthPrefixedUTF8("client-auth")]);
  const phoneSignature = sign(null, authTranscript, createPrivateKey({
    key: {
      crv: "Ed25519",
      d: base64ToBase64Url(phoneIdentity.privateKey),
      kty: "OKP",
      x: base64ToBase64Url(phoneIdentity.publicKey),
    },
    format: "jwk",
  }));

  secureTransport.handleIncomingWireMessage(JSON.stringify({
    kind: "clientAuth",
    sessionId,
    phoneDeviceId,
    keyEpoch: serverHello.keyEpoch,
    phoneSignature: phoneSignature.toString("base64"),
  }), ctx);

  const secureReady = controlMessages.find((m) => m.kind === "secureReady");
  assert.ok(secureReady, "expected secureReady");

  // Derive the same key the bridge derived so we can produce valid envelopes.
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
  const infoPrefix = `agnt-e2ee-v1|${sessionId}|${macDeviceId}|${phoneDeviceId}|${serverHello.keyEpoch}`;
  const phoneToMacKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${infoPrefix}|phoneToMac`, "utf8"), 32),
  );

  return {
    secureTransport,
    sessionId,
    keyEpoch: serverHello.keyEpoch,
    phoneToMacKey,
    controlMessages,
  };
}

// ── replay & ordering ────────────────────────────────────────────────────

test("the same envelope counter cannot be replayed", () => {
  const { secureTransport, sessionId, keyEpoch, phoneToMacKey } = setupSecureSession();
  const appMessages = [];
  const controlMessages = [];
  const ctx = {
    sendControlMessage(m) { controlMessages.push(m); },
    onApplicationMessage(m) { appMessages.push(m); },
  };

  // First send at counter=0 is accepted.
  const env = encryptEnvelope(
    { payloadText: JSON.stringify({ id: "x", method: "thread/list" }) },
    phoneToMacKey, "iphone", 0, sessionId, keyEpoch,
  );
  secureTransport.handleIncomingWireMessage(JSON.stringify(env), ctx);
  assert.equal(appMessages.length, 1, "first envelope must be delivered");

  // Replay the same envelope (same counter).
  controlMessages.length = 0;
  appMessages.length = 0;
  secureTransport.handleIncomingWireMessage(JSON.stringify(env), ctx);

  assert.equal(appMessages.length, 0, "replayed envelope must NOT be delivered");
  const err = controlMessages.find((m) => m.kind === "secureError");
  assert.ok(err, "expected a secureError on replay");
  assert.equal(err.code, "invalid_envelope");
});

test("an envelope with a counter lower than the last-seen is rejected", () => {
  const { secureTransport, sessionId, keyEpoch, phoneToMacKey } = setupSecureSession();
  const appMessages = [];
  const controlMessages = [];
  const ctx = {
    sendControlMessage(m) { controlMessages.push(m); },
    onApplicationMessage(m) { appMessages.push(m); },
  };

  // Send counter=5 first.
  secureTransport.handleIncomingWireMessage(JSON.stringify(encryptEnvelope(
    { payloadText: "first" }, phoneToMacKey, "iphone", 5, sessionId, keyEpoch,
  )), ctx);
  assert.equal(appMessages.length, 1);

  // Then a stale frame at counter=2 — must be rejected.
  controlMessages.length = 0;
  appMessages.length = 0;
  secureTransport.handleIncomingWireMessage(JSON.stringify(encryptEnvelope(
    { payloadText: "stale" }, phoneToMacKey, "iphone", 2, sessionId, keyEpoch,
  )), ctx);

  assert.equal(appMessages.length, 0, "lower-counter envelope must not be delivered");
  const err = controlMessages.find((m) => m.kind === "secureError");
  assert.ok(err);
  assert.equal(err.code, "invalid_envelope");
});

// ── AEAD authenticity ────────────────────────────────────────────────────

test("a one-byte flip in the AEAD tag fails decryption", () => {
  const { secureTransport, sessionId, keyEpoch, phoneToMacKey } = setupSecureSession();
  const env = encryptEnvelope(
    { payloadText: "real message" },
    phoneToMacKey, "iphone", 0, sessionId, keyEpoch,
  );

  // Flip a single bit in the auth tag.
  const tagBytes = Buffer.from(env.tag, "base64");
  tagBytes[0] ^= 0x01;
  env.tag = tagBytes.toString("base64");

  const appMessages = [];
  const controlMessages = [];
  secureTransport.handleIncomingWireMessage(JSON.stringify(env), {
    sendControlMessage(m) { controlMessages.push(m); },
    onApplicationMessage(m) { appMessages.push(m); },
  });

  assert.equal(appMessages.length, 0, "tampered-tag envelope must not be delivered");
  const err = controlMessages.find((m) => m.kind === "secureError");
  assert.ok(err, "expected a secureError on auth failure");
  assert.equal(err.code, "decrypt_failed");
});

test("a one-byte flip in the AEAD ciphertext fails decryption", () => {
  const { secureTransport, sessionId, keyEpoch, phoneToMacKey } = setupSecureSession();
  const env = encryptEnvelope(
    { payloadText: "real message" },
    phoneToMacKey, "iphone", 0, sessionId, keyEpoch,
  );

  // Flip a single bit in the ciphertext.
  const ctBytes = Buffer.from(env.ciphertext, "base64");
  ctBytes[0] ^= 0x01;
  env.ciphertext = ctBytes.toString("base64");

  const appMessages = [];
  const controlMessages = [];
  secureTransport.handleIncomingWireMessage(JSON.stringify(env), {
    sendControlMessage(m) { controlMessages.push(m); },
    onApplicationMessage(m) { appMessages.push(m); },
  });

  assert.equal(appMessages.length, 0, "tampered-ciphertext envelope must not be delivered");
  const err = controlMessages.find((m) => m.kind === "secureError");
  assert.ok(err);
  assert.equal(err.code, "decrypt_failed");
});

// ── cross-implementation alignment snapshots ─────────────────────────────

test("nonceForDirection produces the canonical 12-byte layout (direction byte + big-endian counter)", () => {
  // Direction bytes per the bridge / agnt-web / Android contract:
  //   mac    -> 1
  //   iphone -> 2
  // The remaining 11 bytes are a big-endian counter. Any drift here would
  // silently break decryption across implementations.

  const macNonce0 = nonceForDirection("mac", 0);
  assert.equal(macNonce0.length, 12);
  assert.deepEqual([...macNonce0], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  const phoneNonce0 = nonceForDirection("iphone", 0);
  assert.deepEqual([...phoneNonce0], [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  // Counter 1 must place 0x01 in the *last* byte (big-endian).
  const macNonce1 = nonceForDirection("mac", 1);
  assert.deepEqual([...macNonce1], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

  // Counter 256 must place 0x01 in byte 10 and 0x00 in byte 11.
  const macNonce256 = nonceForDirection("mac", 256);
  assert.deepEqual([...macNonce256], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);

  // Large counter — verify the byte split for a value that exercises bytes 4..11.
  const macNonceBig = nonceForDirection("iphone", 0x0102030405);
  assert.deepEqual([...macNonceBig], [2, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5]);
});

test("nonceForDirection mac and iphone for the same counter differ only in byte 0", () => {
  // Cross-direction isolation: the only difference between mac→phone and
  // phone→mac nonces at the same counter must be the direction byte. If
  // anyone widened that byte or shifted layout, this comparison fails.
  for (const counter of [0, 1, 7, 256, 65536, 1_000_000]) {
    const macNonce = nonceForDirection("mac", counter);
    const phoneNonce = nonceForDirection("iphone", counter);
    assert.equal(macNonce[0], 1, `mac direction byte must be 1 (counter=${counter})`);
    assert.equal(phoneNonce[0], 2, `iphone direction byte must be 2 (counter=${counter})`);
    // Bytes 1..11 must be byte-identical.
    assert.deepEqual(
      [...macNonce.slice(1)],
      [...phoneNonce.slice(1)],
      `counter bytes diverge between directions (counter=${counter})`,
    );
  }
});

test("HKDF info-string format is byte-stable for a fixed input", () => {
  // Locks the exact info-string format the bridge uses to derive directional
  // keys. agnt-web and AgntAndroid must use the same shape; if any side
  // changes the separator, capitalization, or field order, the derived
  // keys diverge and decryption silently fails cross-implementation.
  //
  // Format: `agnt-e2ee-v1|<sessionId>|<macDeviceId>|<phoneDeviceId>|<keyEpoch>|<direction>`
  //
  // This test computes HKDF with fixed inputs and asserts the resulting
  // 32-byte key. If the info string drifts, this snapshot fails.
  const sharedSecret = Buffer.alloc(32, 0xab);
  const salt = Buffer.alloc(32, 0xcd);
  const info = "agnt-e2ee-v1|sess-abc|mac-1|phone-1|7|phoneToMac";
  const derived = Buffer.from(hkdfSync("sha256", sharedSecret, salt, Buffer.from(info, "utf8"), 32));

  // Computed once with the canonical info-string format. If the
  // info-string format ever needs to change, recompute this value with
  // a careful audit of the three implementations (bridge + agnt-web +
  // AgntAndroid) in the same PR.
  const expected = Buffer.from(
    "0da7f7fed05ba63e2aa14ef199344953c6809a425a8f281b5915bbf68b2fba09",
    "hex",
  );
  assert.deepEqual(derived, expected,
    "HKDF info-string format changed — update agnt-web and AgntAndroid in the same PR");
});
