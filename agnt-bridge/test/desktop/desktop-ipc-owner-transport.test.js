// FILE: desktop-ipc-owner-transport.test.js
// Purpose: Verifies the bridge's Desktop IPC owner transport and its fallback router.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, net, ../../src/desktop/desktop-ipc-owner-transport

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");
const {
  createDesktopOwnerIpcClient,
} = require("../../src/desktop/desktop-ipc-owner-transport");

test("desktop owner IPC fallback router keeps broadcasts pending until a peer connects", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-owner-transport-");
  const peerFrames = [];
  let connectedClientId = "";
  let peerSocket = null;

  const client = createDesktopOwnerIpcClient({
    socketPath,
    netModule: net,
    now: () => 1,
    requestTimeoutMs: 200,
    reconnectMs: 10,
    logPrefix: "[test]",
    onConnected: (clientId) => {
      connectedClientId = clientId;
    },
  });
  t.after(() => {
    client.close();
    peerSocket?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  client.ensureConnected();
  await waitFor(() => connectedClientId.startsWith("agnt-router-"));

  // Only the bridge-owned fallback router is up; no Desktop/VSCode peer has
  // joined it yet, so the write must not be reported as a real delivery.
  assert.equal(
    client.sendBroadcast("thread-unarchived", { conversationId: "thread-pending" }),
    false,
    "the fallback router alone must not count as a recipient"
  );

  peerSocket = net.createConnection(socketPath);
  attachFrameReader(peerSocket, (frame) => peerFrames.push(frame));
  await new Promise((resolve) => peerSocket.once("connect", resolve));
  writeFrame(peerSocket, {
    type: "request",
    requestId: "desktop-init",
    sourceClientId: "initializing-client",
    version: 1,
    method: "initialize",
    params: { clientType: "vscode" },
  });
  await waitFor(() => peerFrames.some(
    (frame) => frame.type === "response" && frame.requestId === "desktop-init"
  ));

  assert.equal(
    client.sendBroadcast("thread-unarchived", { conversationId: "thread-pending" }),
    true,
    "a real peer joining the fallback router must count as a recipient"
  );
  await waitFor(() => peerFrames.some(
    (frame) => frame.type === "broadcast"
      && frame.method === "thread-unarchived"
      && frame.params?.conversationId === "thread-pending"
  ));
});

function attachFrameReader(socket, onFrame) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const frameLength = buffer.readUInt32LE(0);
      if (buffer.length < 4 + frameLength) {
        return;
      }
      const payload = buffer.slice(4, 4 + frameLength).toString("utf8");
      buffer = buffer.slice(4 + frameLength);
      onFrame(JSON.parse(payload));
    }
  });
}

function writeFrame(socket, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  socket.write(Buffer.concat([header, body]));
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await wait(5);
  }
}

function createIpcTestSocket(prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\${path.basename(tempDir)}-ipc`
    : path.join(tempDir, "ipc.sock");
  return { tempDir, socketPath };
}
