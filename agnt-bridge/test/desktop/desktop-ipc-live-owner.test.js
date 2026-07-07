// FILE: desktop-ipc-live-owner.test.js
// Purpose: Verifies bridge-owned Codex streams are exposed to Codex Desktop over IPC.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, net, ../../src/desktop/desktop-ipc-live-owner

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");
const {
  createDesktopIpcLiveOwner,
} = require("../../src/desktop/desktop-ipc-live-owner");

test("live owner broadcasts phone-owned turn snapshots over Desktop IPC", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-live-owner-");
  const frames = [];
  let serverSocket = null;

  const server = net.createServer((socket) => {
    serverSocket = socket;
    attachFrameReader(socket, (frame) => {
      frames.push(frame);
      if (frame.method === "initialize") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: "initialize",
          handledByClientId: "router",
          result: { clientId: "agnt-owner-test" },
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const owner = createDesktopIpcLiveOwner({
    socketPath,
    snapshotDebounceMs: 1,
    sendCodexRequest: async () => ({ ok: true }),
    sendRawCodexMessage() {},
  });

  t.after(() => {
    owner.stopAll();
    server.close();
    serverSocket?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  owner.observeInbound(JSON.stringify({
    id: "turn-start-1",
    method: "turn/start",
    params: {
      threadId: "thread-live-owner",
      cwd: "/tmp/project",
      input: [{ type: "input_text", text: "Build it" }],
    },
  }));
  owner.observeOutbound(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-live-owner",
      turn: {
        id: "turn-live-owner",
        items: [],
        status: "inProgress",
        startedAt: 2,
      },
    },
  }));
  owner.observeOutbound(JSON.stringify({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-live-owner",
      turnId: "turn-live-owner",
      itemId: "assistant-live-owner",
      delta: "Hello",
    },
  }));

  const broadcast = await waitForMessage(
    frames,
    (frame) => frame.type === "broadcast"
      && frame.method === "thread-stream-state-changed"
      && frame.params?.conversationId === "thread-live-owner"
  );
  assert.equal(broadcast.version, 8);
  assert.equal(broadcast.params.version, 8);
  assert.equal(broadcast.params.agntOwnerSource, "desktop-ipc-live-owner");
  assert.equal(broadcast.params.change.type, "snapshot");
  const turn = broadcast.params.change.conversationState.turns[0];
  assert.equal(turn.turnId, "turn-live-owner");
  assert.deepEqual(turn.params.input, [{ type: "input_text", text: "Build it" }]);
  assert.equal(turn.items[0].text, "Hello");
});

test("live owner routes Desktop follower turns to Codex", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-live-owner-router-");
  const codexRequests = [];
  const desktopFrames = [];
  let desktopSocket = null;

  const owner = createDesktopIpcLiveOwner({
    socketPath,
    snapshotDebounceMs: 1,
    reconnectMs: 10,
    requestTimeoutMs: 500,
    async sendCodexRequest(method, params) {
      codexRequests.push({ method, params });
      return { turn: { id: "turn-desktop-start" } };
    },
    sendRawCodexMessage() {},
  });

  t.after(() => {
    owner.stopAll();
    desktopSocket?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  owner.observeInbound(JSON.stringify({
    method: "turn/start",
    params: { threadId: "thread-router-owned", input: [] },
  }));
  await waitFor(() => fs.existsSync(socketPath));

  desktopSocket = net.createConnection(socketPath);
  attachFrameReader(desktopSocket, (frame) => desktopFrames.push(frame));
  await new Promise((resolve) => desktopSocket.once("connect", resolve));
  writeFrame(desktopSocket, {
    type: "request",
    requestId: "desktop-init-1",
    sourceClientId: "initializing-client",
    version: 1,
    method: "initialize",
    params: { clientType: "vscode" },
  });
  await waitFor(() => desktopFrames.some((frame) => frame.requestId === "desktop-init-1"));

  writeFrame(desktopSocket, {
    type: "request",
    requestId: "desktop-start-1",
    sourceClientId: "desktop-client",
    method: "thread-follower-start-turn",
    params: {
      conversationId: "thread-router-owned",
      turnStartParams: {
        input: [{ type: "text", text: "continue from desktop" }],
        cwd: "/tmp/router-project",
      },
    },
  });

  const response = await waitForMessage(
    desktopFrames,
    (frame) => frame.type === "response" && frame.requestId === "desktop-start-1"
  );
  assert.equal(response.resultType, "success");
  assert.deepEqual(codexRequests.filter((request) => request.method === "turn/start"), [{
    method: "turn/start",
    params: {
      threadId: "thread-router-owned",
      input: [{ type: "text", text: "continue from desktop" }],
      cwd: "/tmp/router-project",
    },
  }]);
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

async function waitForMessage(messages, predicate, timeoutMs = 1_000) {
  await waitFor(() => messages.find(predicate), timeoutMs);
  return messages.find(predicate);
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
