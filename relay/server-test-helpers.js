// FILE: server-test-helpers.js
// Purpose: Shared relay server test fixtures and protocol helpers.
// Layer: Unit test support
// Exports: helper functions for relay node:test suites
// Depends on: crypto, ws, ./server

const { generateKeyPairSync, sign } = require("crypto");
const WebSocket = require("ws");
const { createRelayServer } = require("./server");

async function withServer(run, serverOptions = {}) {
  const { server, wss } = createRelayServer(serverOptions);
  const address = await listen(server);
  try {
    return await run({
      port: address.port,
      server,
      wss,
    });
  } finally {
    await close(server, wss);
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address());
    });
  });
}

function close(server, wss) {
  // Force-terminate any still-open WS clients before calling server.close().
  // Otherwise an assertion failure inside the withServer body (which skips the
  // explicit mac.close() that normally drains the connection) would leave a
  // live WebSocket attached and server.close() would hang waiting for it,
  // turning a fast unit-test failure into a 6h CI job timeout (#26442150962).
  return new Promise((resolve, reject) => {
    for (const ws of wss.clients) {
      ws.terminate();
    }
    wss.close();
    server.closeAllConnections?.();
    server.close((error) => {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function onceMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (value) => resolve(value.toString("utf8")));
    socket.once("error", reject);
  });
}

function onceClosed(socket) {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }

    socket.once("close", resolve);
  });
}

function onceCloseDetails(socket) {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve({ code: 1005, reason: "" });
      return;
    }

    socket.once("close", (code, reasonBuffer) => {
      resolve({
        code,
        reason: reasonBuffer.toString("utf8"),
      });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function makePhoneIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });
  return {
    phoneDeviceId: `phone-${Math.random().toString(16).slice(2)}`,
    phoneIdentityPublicKey: base64UrlToBase64(publicJwk.x),
    phoneIdentityPrivateKey: base64UrlToBase64(privateJwk.d),
  };
}

function makeTrustedResolveBody({
  macDeviceId,
  phoneIdentity,
  nonce,
  timestamp,
}) {
  const transcript = buildTrustedResolveTranscript({
    macDeviceId,
    phoneDeviceId: phoneIdentity.phoneDeviceId,
    phoneIdentityPublicKey: phoneIdentity.phoneIdentityPublicKey,
    nonce,
    timestamp,
  });
  return {
    macDeviceId,
    phoneDeviceId: phoneIdentity.phoneDeviceId,
    phoneIdentityPublicKey: phoneIdentity.phoneIdentityPublicKey,
    nonce,
    timestamp,
    signature: sign(
      null,
      transcript,
      {
        key: {
          crv: "Ed25519",
          d: base64ToBase64Url(phoneIdentity.phoneIdentityPrivateKey),
          kty: "OKP",
          x: base64ToBase64Url(phoneIdentity.phoneIdentityPublicKey),
        },
        format: "jwk",
      }
    ).toString("base64"),
  };
}

function buildTrustedResolveTranscript({
  macDeviceId,
  phoneDeviceId,
  phoneIdentityPublicKey,
  nonce,
  timestamp,
}) {
  return Buffer.concat([
    encodeLengthPrefixedUTF8("agnt-trusted-session-resolve-v1"),
    encodeLengthPrefixedUTF8(macDeviceId),
    encodeLengthPrefixedUTF8(phoneDeviceId),
    encodeLengthPrefixedData(Buffer.from(phoneIdentityPublicKey, "base64")),
    encodeLengthPrefixedUTF8(nonce),
    encodeLengthPrefixedUTF8(String(timestamp)),
  ]);
}

function encodeLengthPrefixedUTF8(value) {
  return encodeLengthPrefixedData(Buffer.from(value, "utf8"));
}

function encodeLengthPrefixedData(value) {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

function base64UrlToBase64(value) {
  const normalized = String(value || "")
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  const remainder = normalized.length % 4;
  return remainder === 0
    ? normalized
    : normalized + "=".repeat(4 - remainder);
}

function base64ToBase64Url(value) {
  return String(value || "")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}


module.exports = {
  withServer,
  listen,
  close,
  onceOpen,
  onceMessage,
  onceClosed,
  onceCloseDetails,
  delay,
  makePhoneIdentity,
  makeTrustedResolveBody,
  buildTrustedResolveTranscript,
  encodeLengthPrefixedUTF8,
  encodeLengthPrefixedData,
  base64UrlToBase64,
  base64ToBase64Url,
};
