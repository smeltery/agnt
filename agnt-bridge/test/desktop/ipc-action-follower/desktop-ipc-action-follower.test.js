// FILE: desktop-ipc-action-follower.test.js
// Purpose: Verifies Codex Desktop IPC baseline recovery and snapshot projection behavior.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, net, timers/promises, desktop-ipc-action-follower, desktop-ipc-action-follower-test-helpers

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const { setTimeout: wait } = require("node:timers/promises");
const {
  attachFrameReader,
  writeFrame,
  waitFor,
  createIpcTestSocket,
  useProcessPlatform,
} = require("../desktop-ipc-action-follower-test-helpers");

const {
  createDesktopIpcActionFollower,
  resolveDefaultIpcSocketPath,
} = require("../../../src/desktop/desktop-ipc-action-follower");

test("desktop IPC follower backs off baseline recovery instead of hot-looping", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-recovery-backoff-");
  let serverSocket = null;

  const server = net.createServer((socket) => {
    serverSocket = socket;
    attachFrameReader(socket, (frame) => {
      if (frame.method === "initialize") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: "initialize",
          handledByClientId: "desktop",
          result: { clientId: "agnt-test" },
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    server.close();
    serverSocket?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const outbound = [];
  let readAttempts = 0;
  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    async readConversationState() {
      readAttempts += 1;
      throw new Error("thread not loaded");
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-backoff" },
  }));
  await waitFor(() => serverSocket);

  const patchBroadcast = (value) => ({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-backoff",
      change: {
        type: "patches",
        patches: [{ op: "replace", path: ["turns", 0, "items", 0, "text"], value }],
      },
    },
  });

  // A burst of patch-only broadcasts must trigger at most one immediate read
  // attempt; retries wait for the backoff window instead of running per patch.
  for (let index = 0; index < 5; index += 1) {
    writeFrame(serverSocket, patchBroadcast(`delta ${index}`));
  }
  await wait(100);
  assert.equal(readAttempts, 1);

  // Failed recovery must not leak speculative timeline rows to the phone.
  assert.deepEqual(
    outbound.filter((message) => typeof message.method === "string"
      && (message.method.startsWith("item/") || message.method.startsWith("turn/"))),
    []
  );
});

test("desktop IPC follower announces thread replacement when synthetic turn ids become real", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-follower-full-replace-");
  let serverSocket = null;

  const server = net.createServer((socket) => {
    serverSocket = socket;
    attachFrameReader(socket, (frame) => {
      if (frame.method === "initialize") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: "initialize",
          handledByClientId: "desktop",
          result: { clientId: "agnt-test" },
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    server.close();
    serverSocket?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const outbound = [];
  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-full-replace" },
  }));
  await waitFor(() => serverSocket);

  // First snapshot carries a turn without any id, so the projector synthesizes one.
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-full-replace",
      change: {
        type: "snapshot",
        conversationState: {
          turns: [{
            status: "inProgress",
            items: [{ id: "assistant-replace", type: "agentMessage", text: "partial" }],
          }],
          requests: [],
        },
      },
    },
  });
  await waitFor(() => outbound.some((message) => message.method === "turn/started"));

  // The next snapshot has the canonical turn id: the phone must be told to rebuild.
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-full-replace",
      change: {
        type: "snapshot",
        conversationState: {
          turns: [{
            turnId: "turn-real-id",
            status: "inProgress",
            items: [{ id: "assistant-replace", type: "agentMessage", text: "partial" }],
          }],
          requests: [],
        },
      },
    },
  });

  await waitFor(() => outbound.some((message) => message.method === "thread/replaced"));
  const replaced = outbound.find((message) => message.method === "thread/replaced");
  assert.equal(replaced.params.threadId, "thread-full-replace");
  assert.equal(replaced.params.agntDesktopMirror, true);
  assert.equal(replaced.params.agntDesktopIpcMirror, true);
  // No embedded thread: the phone rebuilds from canonical history, and heavy
  // threads must not ship as one oversized relay frame.
  assert.equal(replaced.params.thread, undefined);

  // The replacement bootstrap follows the announcement with the real turn id.
  const replacedIndex = outbound.indexOf(replaced);
  const followUpTurnStarted = outbound.slice(replacedIndex + 1)
    .find((message) => message.method === "turn/started");
  assert.equal(followUpTurnStarted.params.turnId, "turn-real-id");
});

test("uses the Codex Desktop named pipe as the default Windows IPC path", (t) => {
  useProcessPlatform(t, "win32");
  assert.equal(resolveDefaultIpcSocketPath(), "\\\\.\\pipe\\codex-ipc");
});
