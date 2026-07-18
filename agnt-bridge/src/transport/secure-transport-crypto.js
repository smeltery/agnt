const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign,
  verify,
} = require("crypto");

const HANDSHAKE_TAG = "agnt-e2ee-v1";
const SECURE_SENDER_MAC = "mac";
const SECURE_SENDER_IPHONE = "iphone";

function debugSecureLog(message) {
  console.log(`[agnt][secure] ${message}`);
}

function shortId(value) {
  const normalized = normalizeNonEmptyString(value);
  return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 8) : "none";
}

function shortFingerprint(publicKeyBase64) {
  const bytes = base64ToBuffer(publicKeyBase64);
  if (!bytes || bytes.length === 0) {
    return "invalid";
  }
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

function transcriptDigest(transcriptBytes) {
  return createHash("sha256").update(transcriptBytes).digest("hex").slice(0, 16);
}

function encryptEnvelopePayload(payloadObject, key, sender, counter, sessionId, keyEpoch, protocolVersion) {
  const nonce = nonceForDirection(sender, counter);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payloadObject), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    kind: "encryptedEnvelope",
    v: protocolVersion,
    sessionId,
    keyEpoch,
    sender,
    counter,
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptEnvelopeBuffer(envelope, key, sender, counter) {
  try {
    const nonce = nonceForDirection(sender, counter);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(base64ToBuffer(envelope.tag));
    return Buffer.concat([
      decipher.update(base64ToBuffer(envelope.ciphertext)),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
}

function deriveAesKey(sharedSecret, salt, infoLabel) {
  return Buffer.from(hkdfSync("sha256", sharedSecret, salt, Buffer.from(infoLabel, "utf8"), 32));
}

function signTranscript(privateKeyBase64, publicKeyBase64, transcriptBytes) {
  const signature = sign(
    null,
    transcriptBytes,
    createPrivateKey({
      key: {
        crv: "Ed25519",
        d: base64ToBase64Url(privateKeyBase64),
        kty: "OKP",
        x: base64ToBase64Url(publicKeyBase64),
      },
      format: "jwk",
    })
  );
  return signature.toString("base64");
}

function verifyTranscript(publicKeyBase64, transcriptBytes, signatureBase64) {
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
      base64ToBuffer(signatureBase64)
    );
  } catch {
    return false;
  }
}

function buildTranscriptBytes({
  sessionId,
  protocolVersion,
  handshakeMode,
  keyEpoch,
  macDeviceId,
  phoneDeviceId,
  macIdentityPublicKey,
  phoneIdentityPublicKey,
  macEphemeralPublicKey,
  phoneEphemeralPublicKey,
  clientNonce,
  serverNonce,
  expiresAtForTranscript,
}) {
  return Buffer.concat([
    encodeLengthPrefixedUTF8(HANDSHAKE_TAG),
    encodeLengthPrefixedUTF8(sessionId),
    encodeLengthPrefixedUTF8(String(protocolVersion)),
    encodeLengthPrefixedUTF8(handshakeMode),
    encodeLengthPrefixedUTF8(String(keyEpoch)),
    encodeLengthPrefixedUTF8(macDeviceId),
    encodeLengthPrefixedUTF8(phoneDeviceId),
    encodeLengthPrefixedBuffer(base64ToBuffer(macIdentityPublicKey)),
    encodeLengthPrefixedBuffer(base64ToBuffer(phoneIdentityPublicKey)),
    encodeLengthPrefixedBuffer(base64ToBuffer(macEphemeralPublicKey)),
    encodeLengthPrefixedBuffer(base64ToBuffer(phoneEphemeralPublicKey)),
    encodeLengthPrefixedBuffer(clientNonce),
    encodeLengthPrefixedBuffer(serverNonce),
    encodeLengthPrefixedUTF8(String(expiresAtForTranscript)),
  ]);
}

function encodeLengthPrefixedUTF8(value) {
  return encodeLengthPrefixedBuffer(Buffer.from(String(value), "utf8"));
}

function encodeLengthPrefixedBuffer(buffer) {
  const lengthBuffer = Buffer.allocUnsafe(4);
  lengthBuffer.writeUInt32BE(buffer.length, 0);
  return Buffer.concat([lengthBuffer, buffer]);
}

function nonceForDirection(sender, counter) {
  const nonce = Buffer.alloc(12, 0);
  nonce.writeUInt8(sender === SECURE_SENDER_MAC ? 1 : 2, 0);
  let value = BigInt(counter);
  for (let index = 11; index >= 1; index -= 1) {
    nonce[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return nonce;
}

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function safeParseJSON(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function base64ToBuffer(value) {
  try {
    return Buffer.from(value, "base64");
  } catch {
    return null;
  }
}

function base64UrlToBase64(value) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4 || 4)) % 4)}`;
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

function base64ToBase64Url(value) {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

module.exports = {
  HANDSHAKE_TAG,
  SECURE_SENDER_IPHONE,
  SECURE_SENDER_MAC,
  base64ToBase64Url,
  base64ToBuffer,
  base64UrlToBase64,
  buildTranscriptBytes,
  debugSecureLog,
  decryptEnvelopeBuffer,
  deriveAesKey,
  encodeLengthPrefixedUTF8,
  encryptEnvelopePayload,
  nonceForDirection,
  normalizeNonEmptyString,
  safeParseJSON,
  shortFingerprint,
  shortId,
  signTranscript,
  transcriptDigest,
  verifyTranscript,
};
