// FILE: desktop-ipc-action-follower-ownership-routing.test.js
// Purpose: Verifies Desktop IPC ownership routing for phone turns and live-owner handoff.
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
} = require("../desktop-ipc-action-follower-test-helpers");

const {
  createDesktopIpcActionFollower,
  resolveDefaultIpcSocketPath,
} = require("../../../src/desktop/desktop-ipc-action-follower");

test("desktop IPC follower normalizes phone turn starts before Desktop follower requests", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-follower-normalize-");
  const serverFrames = [];
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
    sendApplicationResponse() {},
    normalizeTurnStartParams(params) {
      return { ...params, summary: "none" };
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-normalize" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-normalize",
      change: {
        type: "snapshot",
        conversationState: { turns: [], requests: [] },
      },
    },
  });
  await wait(25);

  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-normalize",
    method: "turn/start",
    params: {
      threadId: "thread-normalize",
      input: [{ type: "input_text", text: "continue" }],
      summary: "auto",
    },
  }));
  assert.equal(handled, true);

  await waitFor(() => serverFrames.find((frame) => frame.method === "thread-follower-start-turn"));
  const turnStartFrame = serverFrames.find((frame) => frame.method === "thread-follower-start-turn");
  assert.deepEqual(turnStartFrame.params.turnStartParams, {
    threadId: "thread-normalize",
    input: [{ type: "input_text", text: "continue" }],
    summary: "none",
  });
});

test("desktop IPC follower releases desktop state when the live owner claims a thread", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-owner-release-");
  const serverFrames = [];
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
          handledByClientId: "router",
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
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-released" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-released",
      change: {
        type: "snapshot",
        conversationState: { turns: [], requests: [] },
      },
    },
  });
  await wait(25);

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "agnt-owner",
    version: 6,
    params: {
      conversationId: "thread-released",
      agntOwnerSource: "desktop-ipc-live-owner",
      change: {
        type: "snapshot",
        conversationState: { turns: [], requests: [] },
      },
    },
  });
  await wait(25);

  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-released",
    method: "turn/start",
    params: {
      threadId: "thread-released",
      input: [{ type: "input_text", text: "continue locally" }],
    },
  }));
  assert.equal(handled, false);
  await wait(25);
  assert.equal(
    serverFrames.some((frame) => frame.method === "thread-follower-start-turn"),
    false
  );
});

test("desktop IPC follower keeps held turns queued across a transient IPC disconnect", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-hold-disconnect-");
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
          handledByClientId: "router",
          result: { clientId: "agnt-test" },
        });
      } else if (frame.method === "thread-follower-start-turn") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: frame.method,
          handledByClientId: "desktop",
          result: { turn: { id: "turn-after-reconnect" } },
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
    forwardToLocalCodex(rawMessage) {
      localForwards.push(JSON.parse(rawMessage));
    },
    requestTimeoutMs: 500,
    ownershipProbeTimeoutMs: 600,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-hold-disconnect" },
  }));
  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-hold-disconnect",
    method: "turn/start",
    params: {
      threadId: "thread-hold-disconnect",
      input: [{ type: "input_text", text: "survive the drop" }],
    },
  }));
  assert.equal(handled, true);

  // Drop the IPC connection while the turn is still held: it must stay queued
  // instead of running locally on unproven ownership.
  await waitFor(() => serverSocket);
  const firstSocket = serverSocket;
  serverSocket = null;
  firstSocket.destroy();
  await wait(50);
  assert.deepEqual(localForwards, []);

  // At the hold deadline the request routes through the bus over a reconnect.
  await waitFor(() => serverFrames.find((frame) => frame.method === "thread-follower-start-turn"), 2_000);
  await waitFor(() => outbound.find((message) => message.id === "phone-turn-start-hold-disconnect"), 1_000);
  assert.deepEqual(outbound.find((message) => message.id === "phone-turn-start-hold-disconnect"), {
    id: "phone-turn-start-hold-disconnect",
    result: { turn: { id: "turn-after-reconnect" } },
  });
  assert.deepEqual(localForwards, []);
});

test("desktop IPC follower keeps live owner routing guard across IPC disconnects", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-owner-disconnect-");
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
          handledByClientId: "router",
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
    forwardToLocalCodex(rawMessage) {
      localForwards.push(JSON.parse(rawMessage));
    },
    requestTimeoutMs: 500,
    ownershipProbeTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-owner-disconnect" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "agnt-owner",
    version: 6,
    params: {
      conversationId: "thread-owner-disconnect",
      agntOwnerSource: "desktop-ipc-live-owner",
      change: {
        type: "snapshot",
        conversationState: { turns: [], requests: [] },
      },
    },
  });
  await wait(25);
  serverSocket.destroy();
  await wait(25);

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-owner-disconnect" },
  }));
  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-owner-disconnect",
    method: "turn/start",
    params: {
      threadId: "thread-owner-disconnect",
      input: [{ type: "input_text", text: "stay local after disconnect" }],
    },
  }));
  assert.equal(handled, false);
  assert.deepEqual(localForwards, []);
  assert.equal(
    serverFrames.some((frame) => frame.method === "thread-follower-start-turn"),
    false
  );
});

test("desktop IPC follower rejects unsupported Desktop-owned mutations", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-unsupported-mutation-");
  const outbound = [];
  const localForwards = [];
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
    sendApplicationResponse(rawMessage) {
      outbound.push(JSON.parse(rawMessage));
    },
    forwardToLocalCodex(rawMessage) {
      localForwards.push(JSON.parse(rawMessage));
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-desktop-mutation" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-desktop-mutation",
      change: {
        type: "snapshot",
        conversationState: { turns: [], requests: [] },
      },
    },
  });
  await wait(25);

  const handled = follower.observeInbound(JSON.stringify({
    id: "review-start-1",
    method: "review/start",
    params: { threadId: "thread-desktop-mutation" },
  }));

  assert.equal(handled, true);
  assert.deepEqual(outbound.find((message) => message.id === "review-start-1"), {
    id: "review-start-1",
    error: {
      code: -32004,
      message: "Start this review in Codex Desktop.",
    },
  });
  assert.deepEqual(localForwards, []);
});
