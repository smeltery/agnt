// FILE: desktop-ipc-action-follower-active-cache-eviction.test.js
// Purpose: Verifies Desktop IPC active-thread cache eviction and recency behavior.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, net, timers/promises, desktop-ipc-action-follower, desktop-ipc-action-follower-test-helpers


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

test("desktop IPC follower protects pending prompts from active-thread LRU eviction", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-active-thread-pending-cap-");
  const serverFrames = [];
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
      } else if (frame.method === "thread-follower-submit-user-input") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: frame.method,
          handledByClientId: "desktop",
          result: { ok: true },
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

  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    forwardToLocalCodex() {},
    requestTimeoutMs: 500,
    ownershipProbeTimeoutMs: 10_000,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-pending-cap" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-pending-cap",
      change: {
        type: "snapshot",
        conversationState: {
          requests: [{
            id: "req-pending-cap",
            method: "item/tool/requestUserInput",
            params: {
              threadId: "thread-pending-cap",
              turnId: "turn-pending-cap",
              itemId: "item-pending-cap",
              questions: [{ id: "q1", question: "Continue?" }],
            },
          }],
        },
      },
    },
  });
  await waitFor(() => outbound.find((message) => message.id === "req-pending-cap"));

  for (let i = 0; i < 512; i += 1) {
    follower.observeInbound(JSON.stringify({
      method: "thread/resume",
      params: { threadId: `thread-pending-cap-fill-${i}` },
    }));
  }

  await wait(25);
  assert.equal(
    outbound.some((message) => message.method === "serverRequest/resolved"
      && message.params?.requestId === "req-pending-cap"),
    false,
    "LRU eviction must not dismiss a still-pending Desktop prompt"
  );

  follower.observeInbound(JSON.stringify({
    id: "req-pending-cap",
    result: {
      answers: {
        q1: { answers: ["Yes"] },
      },
    },
  }));
  await waitFor(() => serverFrames.find((frame) => frame.method === "thread-follower-submit-user-input"));
  const replyFrame = serverFrames.find((frame) => frame.method === "thread-follower-submit-user-input");
  assert.equal(replyFrame.params.requestId, "req-pending-cap");
});

test("desktop IPC follower refreshes active-thread recency so re-read threads survive eviction", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-active-thread-lru-");
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

  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse() {},
    forwardToLocalCodex() {},
    requestTimeoutMs: 500,
    ownershipProbeTimeoutMs: 10_000,
  });
  t.after(() => follower.stopAll());

  // Fill the set exactly to MAX_ACTIVE_THREAD_IDS (512) with no eviction yet.
  for (let i = 0; i < 512; i += 1) {
    follower.observeInbound(JSON.stringify({
      method: "thread/resume",
      params: { threadId: `thread-lru-${i}` },
    }));
  }
  // Re-reading the oldest thread must refresh its recency (delete-before-add),
  // so the next overflow evicts thread-lru-1 instead of thread-lru-0.
  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-lru-0" },
  }));
  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-lru-512" },
  }));
  await waitFor(() => serverSocket);

  const heldRefreshed = follower.observeInbound(JSON.stringify({
    id: "phone-turn-lru-refreshed",
    method: "turn/start",
    params: {
      threadId: "thread-lru-0",
      input: [{ type: "input_text", text: "refreshed thread" }],
    },
  }));
  assert.equal(heldRefreshed, true, "a re-read thread must have its recency refreshed and survive eviction");

  const heldEvicted = follower.observeInbound(JSON.stringify({
    id: "phone-turn-lru-evicted",
    method: "turn/start",
    params: {
      threadId: "thread-lru-1",
      input: [{ type: "input_text", text: "evicted thread" }],
    },
  }));
  assert.equal(heldEvicted, false, "the least-recently-read thread must be the one evicted");
});
