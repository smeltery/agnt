// FILE: desktop-ipc-action-follower.test.js
// Purpose: Verifies Codex Desktop IPC pending actions are projected and routed without using rollout text.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../../src/desktop/desktop-ipc-action-follower

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");
const {
  attachFrameReader,
  writeFrame,
  emitFrame,
  waitFor,
  createIpcTestSocket,
  desktopConversationSnapshot,
  normalizedConversationState,
  useProcessPlatform,
} = require("./desktop-ipc-action-follower-test-helpers");

const {
  createDesktopIpcActionFollower,
  resolveDefaultIpcSocketPath,
} = require("../../src/desktop/desktop-ipc-action-follower");

test("desktop IPC follower falls back locally when no Desktop client can handle the request", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-follower-local-fallback-");
  const serverFrames = [];
  const localForwards = [];
  let serverSocket = null;

  const server = net.createServer((socket) => {
    serverSocket = socket;
    attachFrameReader(socket, (frame) => {
      serverFrames.push(frame);
      if (frame.method === "initialize") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: "initialize",
          handledByClientId: "desktop",
          result: { clientId: "agnt-test" },
        });
      } else if (frame.method === "thread-follower-start-turn") {
        // Router-style no-handler error: the request never reached any client,
        // so retrying it locally is safe.
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "error",
          method: frame.method,
          handledByClientId: "",
          error: "No Codex IPC client can handle thread-follower-start-turn.",
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
    forwardToLocalCodex(rawMessage) {
      localForwards.push(JSON.parse(rawMessage));
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-route-fallback" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-route-fallback",
      change: {
        type: "snapshot",
        conversationState: { turns: [], requests: [] },
      },
    },
  });
  await wait(25);

  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-route-fallback",
    method: "turn/start",
    params: {
      threadId: "thread-route-fallback",
      input: [{ type: "input_text", text: "continue locally after failure" }],
    },
  }));
  assert.equal(handled, true);
  await waitFor(() => localForwards.length === 1);
  assert.equal(localForwards[0].id, "phone-turn-start-route-fallback");
  assert.equal(localForwards[0].method, "turn/start");
  assert.equal(outbound.some((message) => message.id === "phone-turn-start-route-fallback"), false);

  const handledAgain = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-route-fallback-2",
    method: "turn/start",
    params: {
      threadId: "thread-route-fallback",
      input: [{ type: "input_text", text: "stay local" }],
    },
  }));
  assert.equal(handledAgain, false);
  assert.equal(
    serverFrames.filter((frame) => frame.method === "thread-follower-start-turn").length,
    1
  );
});

test("desktop IPC follower falls back locally when Desktop settings sync times out before turn delivery", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-follower-settings-timeout-");
  const serverFrames = [];
  const localForwards = [];
  const outbound = [];
  let serverSocket = null;

  const server = net.createServer((socket) => {
    serverSocket = socket;
    attachFrameReader(socket, (frame) => {
      serverFrames.push(frame);
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
  await new Promise((resolve) => server.listen(socketPath, resolve)); t.after(() => { server.close(); serverSocket?.destroy(); fs.rmSync(tempDir, { recursive: true, force: true }); });

  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse: (message) => outbound.push(JSON.parse(message)),
    forwardToLocalCodex: (rawMessage) => localForwards.push(JSON.parse(rawMessage)),
    requestTimeoutMs: 100,
  }); t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({ method: "thread/resume", params: { threadId: "thread-settings-timeout" } }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-settings-timeout",
      change: { type: "snapshot", conversationState: { turns: [], requests: [] } },
    },
  });
  await wait(25);

  assert.equal(follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-settings-timeout",
    method: "turn/start",
    params: {
      threadId: "thread-settings-timeout",
      input: [{ type: "input_text", text: "continue despite stale Desktop owner" }],
      model: "gpt-test",
      effort: "low",
    },
  })), true);

  await waitFor(() => localForwards.length === 1, 1_000);
  assert.deepEqual([localForwards[0].id, localForwards[0].method], ["phone-turn-start-settings-timeout", "turn/start"]);
  assert.equal(serverFrames.some((frame) => frame.method === "thread-follower-start-turn"), false);
  assert.equal(outbound.some((message) => message.id === "phone-turn-start-settings-timeout"), false);
});

test("desktop IPC follower does not rerun ambiguous Desktop failures locally", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-follower-ambiguous-error-");
  const localForwards = [];
  let serverSocket = null;
  let respondWithTimeout = false;

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
      } else if (frame.method === "thread-follower-start-turn" && !respondWithTimeout) {
        // Explicit Desktop-side error: the request reached the owner, so the
        // bridge must not rerun the same turn on the local app-server.
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "error",
          method: frame.method,
          handledByClientId: "desktop",
          error: "Desktop rejected the turn",
        });
      }
      // When respondWithTimeout is set, never answer so the request times out.
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
    forwardToLocalCodex(rawMessage) {
      localForwards.push(JSON.parse(rawMessage));
    },
    requestTimeoutMs: 150,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-ambiguous-error" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-ambiguous-error",
      change: {
        type: "snapshot",
        conversationState: { turns: [], requests: [] },
      },
    },
  });
  await wait(25);

  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-desktop-error",
    method: "turn/start",
    params: {
      threadId: "thread-ambiguous-error",
      input: [{ type: "input_text", text: "explicit desktop error" }],
    },
  }));
  assert.equal(handled, true);
  await waitFor(() => outbound.some((message) => message.id === "phone-turn-start-desktop-error"));
  const errorResponse = outbound.find((message) => message.id === "phone-turn-start-desktop-error");
  assert.equal(errorResponse.error.code, -32000);
  assert.deepEqual(localForwards, []);

  respondWithTimeout = true;
  const handledTimeout = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-desktop-timeout",
    method: "turn/start",
    params: {
      threadId: "thread-ambiguous-error",
      input: [{ type: "input_text", text: "desktop timeout" }],
    },
  }));
  assert.equal(handledTimeout, true);
  await waitFor(() => outbound.some((message) => message.id === "phone-turn-start-desktop-timeout"), 1_000);
  const timeoutResponse = outbound.find((message) => message.id === "phone-turn-start-desktop-timeout");
  assert.equal(timeoutResponse.error.code, -32000);
  assert.deepEqual(localForwards, []);
});

test("desktop IPC follower mirrors live assistant text growth from desktop state", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-assistant-delta-");
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
    params: { threadId: "thread-live-delta" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-live-delta",
      change: {
        type: "snapshot",
        conversationState: {
          turns: [{
            id: "turn-live-delta",
            status: "inProgress",
            items: [{
              id: "assistant-live-delta",
              type: "assistant_message",
              text: "Hello",
            }],
          }],
        },
      },
    },
  });
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-live-delta",
      change: {
        type: "patches",
        patches: [{
          op: "replace",
          path: ["turns", 0, "items", 0, "text"],
          value: "Hello world",
        }],
      },
    },
  });

  await waitFor(() => outbound.find((message) => message.method === "item/agentMessage/delta"));
  const deltaMessage = outbound.find((message) => message.method === "item/agentMessage/delta");
  assert.equal(deltaMessage.params.threadId, "thread-live-delta");
  assert.equal(deltaMessage.params.turnId, "turn-live-delta");
  assert.equal(deltaMessage.params.itemId, "assistant-live-delta");
  assert.equal(deltaMessage.params.delta, " world");
  assert.equal(deltaMessage.params.agntDesktopMirror, true);
  assert.equal(deltaMessage.params.agntDesktopIpcMirror, true);
});
