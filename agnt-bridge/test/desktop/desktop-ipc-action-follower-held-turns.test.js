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

test("desktop IPC follower ignores stale positive discovery after a held turn already expired", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-probe-expired-");
  const serverFrames = [];
  const localForwards = [];
  let serverSocket = null;
  let discoveryRequestFrame = null;

  // Ignores discovery probes, and reports no handler for routed requests so the
  // expired hold falls back to the local app-server.
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
        discoveryRequestFrame = frame;
      } else if (frame.type === "request" && frame.method?.startsWith("thread-follower-")) {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "error",
          error: "no-client-found",
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
    ownershipProbeTimeoutMs: 100,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-probe-expired" },
  }));
  const firstHandled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-expired-probe",
    method: "turn/start",
    params: {
      threadId: "thread-probe-expired",
      input: [{ type: "input_text", text: "expires before discovery answers" }],
    },
  }));
  assert.equal(firstHandled, true);

  // The hold expires and the request falls back to the local app-server.
  await waitFor(() => localForwards.some((message) => message.id === "phone-turn-start-expired-probe"), 1_000);
  assert.ok(discoveryRequestFrame);

  // A very late positive discovery answer must not flip the thread to Desktop.
  writeFrame(serverSocket, {
    type: "client-discovery-response",
    requestId: discoveryRequestFrame.requestId,
    response: { canHandle: true },
  });
  await wait(25);

  const secondHandled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-after-expired-probe",
    method: "turn/start",
    params: {
      threadId: "thread-probe-expired",
      input: [{ type: "input_text", text: "must not route to desktop" }],
    },
  }));
  assert.equal(secondHandled, false);
});

test("desktop IPC follower ignores stale positive discovery after live owner claims a thread", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-probe-stale-");
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
      } else if (frame.method === "thread-follower-start-turn") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: frame.method,
          handledByClientId: "desktop",
          result: { turn: { id: "turn-should-not-route" } },
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
    ownershipProbeTimeoutMs: 5_000,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-probe-stale" },
  }));
  const firstHandled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-stale-probe",
    method: "turn/start",
    params: {
      threadId: "thread-probe-stale",
      input: [{ type: "input_text", text: "hold before owner claim" }],
    },
  }));
  assert.equal(firstHandled, true);

  await waitFor(() => (
    serverFrames.find((frame) => frame.type === "client-discovery-request")
  ), 1_000);
  const discoveryRequest = serverFrames.find((frame) => frame.type === "client-discovery-request");
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "agnt-owner",
    version: 6,
    params: {
      conversationId: "thread-probe-stale",
      agntOwnerSource: "desktop-ipc-live-owner",
      change: {
        type: "snapshot",
        conversationState: { turns: [], requests: [] },
      },
    },
  });

  await waitFor(() => localForwards.some((message) => message.id === "phone-turn-start-stale-probe"), 1_000);
  writeFrame(serverSocket, {
    type: "client-discovery-response",
    requestId: discoveryRequest.requestId,
    response: { canHandle: true },
  });
  await wait(25);

  const secondHandled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-after-stale-probe",
    method: "turn/start",
    params: {
      threadId: "thread-probe-stale",
      input: [{ type: "input_text", text: "must stay local" }],
    },
  }));
  assert.equal(secondHandled, false);
  await wait(25);
  assert.equal(
    serverFrames.some((frame) => frame.method === "thread-follower-start-turn"),
    false
  );
});

test("desktop IPC follower cancels held turns when the live owner removes a thread", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-probe-removed-");
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
          result: { turn: { id: "turn-should-not-start-after-removal" } },
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
    ownershipProbeTimeoutMs: 5_000,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-probe-removed" },
  }));
  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-removed",
    method: "turn/start",
    params: {
      threadId: "thread-probe-removed",
      input: [{ type: "input_text", text: "must not start after removal" }],
    },
  }));
  assert.equal(handled, true);

  await waitFor(() => (
    serverFrames.find((frame) => frame.type === "client-discovery-request")
  ), 1_000);
  const discoveryRequest = serverFrames.find((frame) => frame.type === "client-discovery-request");
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "agnt-owner",
    version: 6,
    params: {
      conversationId: "thread-probe-removed",
      agntOwnerSource: "desktop-ipc-live-owner",
      agntOwnerReleased: true,
      change: {
        type: "snapshot",
        conversationState: { agntRemoved: true, turns: [], requests: [] },
      },
    },
  });

  await waitFor(() => outbound.some((message) => message.id === "phone-turn-start-removed"), 1_000);
  writeFrame(serverSocket, {
    type: "client-discovery-response",
    requestId: discoveryRequest.requestId,
    response: { canHandle: true },
  });
  await wait(25);

  const errorResponse = outbound.find((message) => message.id === "phone-turn-start-removed");
  assert.equal(errorResponse.error.code, -32000);
  assert.deepEqual(localForwards, []);
  assert.equal(
    serverFrames.some((frame) => frame.method === "thread-follower-start-turn"),
    false
  );
});

test("desktop IPC follower keeps held phone turns queued when discovery denies ownership", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-probe-denied-");
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
        writeFrame(socket, {
          type: "client-discovery-response",
          requestId: frame.requestId,
          response: { canHandle: false },
        });
      } else if (frame.type === "request" && frame.method === "thread-follower-start-turn") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "error",
          error: "no-client-found",
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
    ownershipProbeTimeoutMs: 120,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-probe-denied" },
  }));
  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-denied",
    method: "turn/start",
    params: {
      threadId: "thread-probe-denied",
      input: [{ type: "input_text", text: "local thread" }],
    },
  }));
  assert.equal(handled, true);

  await waitFor(() => serverFrames.some((frame) => frame.type === "client-discovery-request"), 1_000);
  await wait(30);
  assert.deepEqual(localForwards, []);
  assert.equal(
    serverFrames.some((frame) => frame.method === "thread-follower-start-turn"),
    false
  );

  // The timer-routed request can still fall back locally after a real no-client-found.
  await waitFor(() => localForwards.length > 0, 1_000);
  assert.equal(localForwards[0].id, "phone-turn-start-denied");
  assert.equal(
    serverFrames.some((frame) => frame.method === "thread-follower-start-turn"),
    true
  );
});

test("desktop IPC follower forwards held phone turns to local codex when no snapshot arrives", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-hold-timeout-");
  const serverFrames = [];
  const localForwards = [];
  let serverSocket = null;

  // Models Codex Desktop's real router: client-origin discovery probes are
  // ignored, but routed requests get a no-client-found error when nobody owns
  // the thread.
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
      } else if (frame.type === "request" && frame.method?.startsWith("thread-follower-")) {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "error",
          error: "no-client-found",
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
    ownershipProbeTimeoutMs: 100,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-hold-timeout" },
  }));
  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-timeout",
    method: "turn/start",
    params: {
      threadId: "thread-hold-timeout",
      input: [{ type: "input_text", text: "no desktop here" }],
    },
  }));
  assert.equal(handled, true);

  await waitFor(() => localForwards.length > 0, 1_000);
  assert.equal(localForwards[0].id, "phone-turn-start-timeout");
  assert.equal(localForwards[0].method, "turn/start");
});
