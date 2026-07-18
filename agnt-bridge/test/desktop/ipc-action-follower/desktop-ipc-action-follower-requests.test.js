// FILE: desktop-ipc-action-follower-requests.test.js
// Purpose: Verifies Desktop IPC pending action request projection and reply routing.
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
} = require("../desktop-ipc-action-follower-test-helpers");

const { createDesktopIpcActionFollower } = require("../../../src/desktop/desktop-ipc-action-follower");

test("desktop IPC follower answers client discovery requests as a passive client", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-discovery-");
  const serverFrames = [];
  let serverSocket = null;

  const server = net.createServer((socket) => {
    serverSocket = socket;
    attachFrameReader(socket, (frame) => {
      serverFrames.push(frame);
      if (frame.method === "initialize") {
        writeFrame(socket, { type: "response", requestId: frame.requestId, resultType: "success", method: "initialize" });
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
    params: { threadId: "thread-discovery" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "client-discovery-request",
    requestId: "discovery-1",
    request: {
      requestId: "inner-1",
      sourceClientId: "desktop",
      version: 1,
      method: "thread-follower-start-turn",
      params: {},
    },
  });
  await wait(25);

  const discoveryResponse = serverFrames.find((frame) => frame.type === "client-discovery-response");
  assert.deepEqual(discoveryResponse, {
    type: "client-discovery-response",
    requestId: "discovery-1",
    response: {
      canHandle: false,
    },
  });
});

test("desktop IPC follower forwards pending actions and routes iOS replies back to the Mac", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-follower-");
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
    params: { threadId: "thread-live" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-live",
      change: {
        type: "snapshot",
        conversationState: {
          requests: [{
            id: "req-live",
            method: "item/tool/requestUserInput",
            params: {
              threadId: "thread-live",
              turnId: "turn-live",
              itemId: "item-live",
              questions: [{ id: "q1", question: "Continue?" }],
            },
          }],
        },
      },
    },
  });
  await wait(25);

  assert.equal(outbound[0].id, "req-live");
  assert.equal(outbound[0].method, "item/tool/requestUserInput");

  follower.observeInbound(JSON.stringify({
    id: "req-live",
    result: {
      answers: {
        q1: { answers: ["Yes"] },
      },
    },
  }));
  await wait(25);

  const replyFrame = serverFrames.find((frame) => frame.method === "thread-follower-submit-user-input");
  assert.deepEqual(replyFrame.params, {
    conversationId: "thread-live",
    requestId: "req-live",
    response: {
      answers: {
        q1: { answers: ["Yes"] },
      },
    },
  });
});

test("desktop IPC follower keeps projected actions pending across IPC disconnects", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-follower-disconnect-action-");
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
    params: { threadId: "thread-action-disconnect" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-action-disconnect",
      change: {
        type: "snapshot",
        conversationState: {
          requests: [{
            id: "req-action-disconnect",
            method: "item/tool/requestUserInput",
            params: {
              threadId: "thread-action-disconnect",
              turnId: "turn-action-disconnect",
              itemId: "item-action-disconnect",
              questions: [{ id: "q1", question: "Continue?" }],
            },
          }],
        },
      },
    },
  });
  await waitFor(() => outbound.find((message) => message.id === "req-action-disconnect"));

  const previousSocket = serverSocket;
  serverSocket = null;
  previousSocket.destroy();

  // A transient disconnect proves nothing about the prompt's outcome, so the
  // phone-side approval must stay open instead of being falsely resolved.
  await wait(150);
  assert.equal(
    outbound.some((message) => message.method === "serverRequest/resolved"
      && message.params?.requestId === "req-action-disconnect"),
    false
  );

  // Reconnect and deliver a snapshot where the prompt is gone: only now does the
  // follower resolve it, tagged as a Desktop mirror event.
  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-action-disconnect" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-action-disconnect",
      change: {
        type: "snapshot",
        conversationState: { turns: [], requests: [] },
      },
    },
  });
  await waitFor(
    () => outbound.find((message) => message.method === "serverRequest/resolved"
      && message.params?.requestId === "req-action-disconnect"),
    1_000
  );
  const resolved = outbound.find((message) => message.method === "serverRequest/resolved"
    && message.params?.requestId === "req-action-disconnect");
  assert.deepEqual(resolved, {
    method: "serverRequest/resolved",
    params: {
      threadId: "thread-action-disconnect",
      requestId: "req-action-disconnect",
      agntDesktopMirror: true,
      agntDesktopIpcMirror: true,
      agntActionSource: "desktop-ipc-action-follower",
    },
  });
});
