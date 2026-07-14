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
  parseFrameBuffer,
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

test("desktop IPC follower holds quick phone turns until the desktop snapshot arrives", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-hold-turn-");
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
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: frame.method,
          handledByClientId: "desktop",
          result: { turn: { id: "turn-held" } },
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
    ownershipProbeTimeoutMs: 400,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-held" },
  }));
  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-held",
    method: "turn/start",
    params: {
      threadId: "thread-held",
      input: [{ type: "input_text", text: "continue quickly" }],
    },
  }));
  assert.equal(handled, true);
  assert.deepEqual(localForwards, []);

  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-held",
      change: {
        type: "snapshot",
        conversationState: { turns: [], requests: [] },
      },
    },
  });

  await waitFor(() => serverFrames.find((frame) => frame.method === "thread-follower-start-turn"));
  const turnStartFrame = serverFrames.find((frame) => frame.method === "thread-follower-start-turn");
  assert.equal(turnStartFrame.params.conversationId, "thread-held");
  await waitFor(() => outbound.find((message) => message.id === "phone-turn-start-held"));
  assert.deepEqual(outbound.find((message) => message.id === "phone-turn-start-held"), {
    id: "phone-turn-start-held",
    result: { turn: { id: "turn-held" } },
  });
  assert.deepEqual(localForwards, []);
});

test("desktop IPC follower routes held phone turns once discovery confirms desktop ownership", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-probe-owned-");
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
      } else if (frame.type === "client-discovery-request") {
        // Codex Desktop only invokes handlers when the nested request version
        // matches the method version, so a missing version must read as false.
        writeFrame(socket, {
          type: "client-discovery-response",
          requestId: frame.requestId,
          response: { canHandle: frame.request?.version === 1 },
        });
      } else if (frame.method === "thread-follower-start-turn") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: frame.method,
          handledByClientId: "desktop",
          result: { turn: { id: "turn-probe-owned" } },
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
    ownershipProbeTimeoutMs: 2_000,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-probe-owned" },
  }));
  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-probe",
    method: "turn/start",
    params: {
      threadId: "thread-probe-owned",
      input: [{ type: "input_text", text: "route via probe" }],
    },
  }));
  assert.equal(handled, true);

  await waitFor(() => serverFrames.find((frame) => frame.method === "thread-follower-start-turn"), 1_000);
  const turnStartFrame = serverFrames.find((frame) => frame.method === "thread-follower-start-turn");
  assert.equal(turnStartFrame.params.conversationId, "thread-probe-owned");
  await waitFor(() => outbound.find((message) => message.id === "phone-turn-start-probe"));
  assert.deepEqual(outbound.find((message) => message.id === "phone-turn-start-probe"), {
    id: "phone-turn-start-probe",
    result: { turn: { id: "turn-probe-owned" } },
  });
  assert.deepEqual(localForwards, []);
});

test("desktop IPC follower coalesces duplicate held turn starts for a thread", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-held-turn-coalesce-");
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
      } else if (frame.type === "client-discovery-request") {
        writeFrame(socket, {
          type: "client-discovery-response",
          requestId: frame.requestId,
          response: { canHandle: true },
        });
      } else if (frame.method === "thread-follower-start-turn") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: frame.method,
          handledByClientId: "desktop",
          result: { turn: { id: "turn-coalesced" } },
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
    forwardToLocalCodex() {
      assert.fail("duplicate held turn/start should not fall back locally");
    },
    requestTimeoutMs: 500,
    ownershipProbeTimeoutMs: 2_000,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-held-coalesce" },
  }));
  assert.equal(follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-coalesce-old",
    method: "turn/start",
    params: {
      threadId: "thread-held-coalesce",
      input: [{ type: "input_text", text: "old duplicate" }],
    },
  })), true);
  assert.equal(follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-coalesce-new",
    method: "turn/start",
    params: {
      threadId: "thread-held-coalesce",
      input: [{ type: "input_text", text: "new duplicate" }],
    },
  })), true);

  await waitFor(() => outbound.find((message) => message.id === "phone-turn-start-coalesce-old"), 1_000);
  assert.equal(outbound.find((message) => message.id === "phone-turn-start-coalesce-old").error?.code, -32000);
  await waitFor(() => outbound.find((message) => message.id === "phone-turn-start-coalesce-new"), 1_000);
  assert.deepEqual(outbound.find((message) => message.id === "phone-turn-start-coalesce-new"), {
    id: "phone-turn-start-coalesce-new",
    result: { turn: { id: "turn-coalesced" } },
  });
  const routedStarts = serverFrames.filter((frame) => frame.method === "thread-follower-start-turn");
  assert.equal(routedStarts.length, 1);
  assert.equal(routedStarts[0].params.turnStartParams.input[0].text, "new duplicate");
});

test("desktop IPC follower retries held ownership probes after IPC connects", async (t) => {
  const outbound = [];
  const localForwards = [];
  const writtenFrames = [];
  let fakeSocket = null;

  const netModule = {
    createConnection() {
      fakeSocket = new EventEmitter();
      fakeSocket.destroyed = true;
      fakeSocket.write = (buffer, callback = () => {}) => {
        const frame = parseFrameBuffer(buffer);
        writtenFrames.push(frame);
        callback();
        if (frame.method === "initialize") {
          setImmediate(() => emitFrame(fakeSocket, {
            type: "response",
            requestId: frame.requestId,
            resultType: "success",
            method: "initialize",
            handledByClientId: "router",
            result: { clientId: "agnt-test" },
          }));
        } else if (frame.type === "client-discovery-request") {
          setImmediate(() => emitFrame(fakeSocket, {
            type: "client-discovery-response",
            requestId: frame.requestId,
            response: { canHandle: true },
          }));
        } else if (frame.method === "thread-follower-start-turn") {
          setImmediate(() => emitFrame(fakeSocket, {
            type: "response",
            requestId: frame.requestId,
            resultType: "success",
            method: frame.method,
            handledByClientId: "desktop",
            result: { turn: { id: "turn-connect-probe" } },
          }));
        }
      };
      fakeSocket.destroy = () => {
        fakeSocket.destroyed = true;
        fakeSocket.emit("close");
      };
      setTimeout(() => {
        fakeSocket.destroyed = false;
        fakeSocket.emit("connect");
      }, 25);
      return fakeSocket;
    },
  };

  const follower = createDesktopIpcActionFollower({
    socketPath: "/tmp/agnt-fake-ipc",
    netModule,
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    forwardToLocalCodex(rawMessage) {
      localForwards.push(JSON.parse(rawMessage));
    },
    requestTimeoutMs: 500,
    ownershipProbeTimeoutMs: 1_000,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-connect-probe" },
  }));
  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-connect-probe",
    method: "turn/start",
    params: {
      threadId: "thread-connect-probe",
      input: [{ type: "input_text", text: "route after connect" }],
    },
  }));
  assert.equal(handled, true);
  assert.equal(writtenFrames.some((frame) => frame.type === "client-discovery-request"), false);

  await waitFor(() => writtenFrames.some((frame) => frame.type === "client-discovery-request"), 1_000);
  await waitFor(() => outbound.find((message) => message.id === "phone-turn-start-connect-probe"), 1_000);
  assert.deepEqual(outbound.find((message) => message.id === "phone-turn-start-connect-probe"), {
    id: "phone-turn-start-connect-probe",
    result: { turn: { id: "turn-connect-probe" } },
  });
  assert.deepEqual(localForwards, []);
});
