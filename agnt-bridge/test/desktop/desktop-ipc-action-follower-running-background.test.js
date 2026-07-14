// FILE: desktop-ipc-action-follower-running-background.test.js
// Purpose: Verifies Desktop IPC running-thread discovery and background lifecycle settlement.
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

test("desktop IPC follower discovers running sidebar threads before open", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-background-running-");
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
    id: "sidebar-list",
    method: "thread/list",
    params: {},
  }));
  await waitFor(() => serverSocket);

  writeFrame(serverSocket, desktopConversationSnapshot("thread-idle-unopened", {
    turns: [{ id: "turn-idle", status: "completed", items: [] }],
    requests: [],
  }));
  writeFrame(serverSocket, desktopConversationSnapshot("thread-running-unopened", {
    turns: [{
      id: "turn-running-unopened",
      status: "inProgress",
      items: [{
        id: "assistant-running-unopened",
        type: "assistant_message",
        text: "Working",
      }],
    }],
    requests: [],
  }));

  await waitFor(() => outbound.some((message) => (
    message.method === "turn/started"
      && message.params?.threadId === "thread-running-unopened"
      && message.params?.turnId === "turn-running-unopened"
  )));
  assert.equal(
    outbound.some((message) => message.params?.threadId === "thread-idle-unopened"),
    false,
    "idle unopened snapshots should stay local to the bridge"
  );
  assert.equal(
    outbound.some((message) => message.method === "item/agentMessage/delta"),
    false,
    "background discovery must not replay transcript rows"
  );
  const started = outbound.find((message) => message.method === "turn/started");
  assert.equal(started.params.agntBackgroundDiscovery, true);

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 11,
    params: {
      conversationId: "thread-running-unopened",
      change: {
        type: "patches",
        patches: [{
          op: "replace",
          path: ["turns", 0, "items", 0, "text"],
          value: "Working still",
        }],
      },
    },
  });
  await wait(25);
  assert.equal(
    outbound.some((message) => (
      message.method === "item/agentMessage/delta"
        && message.params?.threadId === "thread-running-unopened"
    )),
    false,
    "unopened running chats should remain lifecycle-only"
  );

  const readHandled = follower.observeInbound(JSON.stringify({
    id: "open-running-thread",
    method: "thread/read",
    params: { threadId: "thread-running-unopened" },
  }));
  assert.equal(readHandled, true);
  assert.equal(
    outbound.find((message) => message.id === "open-running-thread")
      ?.result?.thread?.turns?.[0]?.items?.[0]?.text,
    "Working still"
  );

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 11,
    params: {
      conversationId: "thread-running-unopened",
      change: {
        type: "patches",
        patches: [{
          op: "replace",
          path: ["turns", 0, "items", 0, "text"],
          value: "Working still after open",
        }],
      },
    },
  });

  await waitFor(() => outbound.some((message) => (
    message.method === "item/agentMessage/delta"
      && message.params?.threadId === "thread-running-unopened"
      && message.params?.delta === " after open"
  )));
});

test("desktop IPC follower settles background runs on completion and disconnect", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-background-settle-");
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
    backgroundDisconnectGraceMs: 20,
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({ method: "thread/list", params: {} }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, desktopConversationSnapshot("thread-background-complete", {
    turns: [{ id: "turn-background-complete", status: "inProgress", items: [] }],
    requests: [],
  }));
  await waitFor(() => outbound.some((message) => message.method === "turn/started"));
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 11,
    params: {
      conversationId: "thread-background-complete",
      change: {
        type: "patches",
        patches: [{ op: "replace", path: ["turns", 0, "status"], value: "completed" }],
      },
    },
  });
  await waitFor(() => outbound.some((message) => (
    message.method === "turn/completed"
      && message.params?.threadId === "thread-background-complete"
      && message.params?.status === "completed"
  )));

  writeFrame(serverSocket, desktopConversationSnapshot("thread-background-disconnect", {
    turns: [{ id: "turn-background-disconnect", status: "inProgress", items: [] }],
    requests: [],
  }));
  await waitFor(() => outbound.some((message) => (
    message.method === "turn/started"
      && message.params?.threadId === "thread-background-disconnect"
  )));
  serverSocket.destroy();
  await waitFor(() => outbound.some((message) => (
    message.method === "turn/completed"
      && message.params?.threadId === "thread-background-disconnect"
      && message.params?.status === "interrupted"
  )), 1_000);
});

test("desktop IPC follower settles a running background thread before archive", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-background-archive-");
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

  follower.observeInbound(JSON.stringify({ method: "thread/list", params: {} }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, desktopConversationSnapshot("thread-background-archive", {
    turns: [{ id: "turn-background-archive", status: "inProgress", items: [] }],
    requests: [],
  }));
  await waitFor(() => outbound.some((message) => message.method === "turn/started"));

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-archived",
    sourceClientId: "desktop",
    version: 2,
    params: { conversationId: "thread-background-archive" },
  });
  await waitFor(() => outbound.some((message) => message.method === "thread/archived"));

  const completionIndex = outbound.findIndex((message) => (
    message.method === "turn/completed"
      && message.params?.threadId === "thread-background-archive"
  ));
  const archiveIndex = outbound.findIndex((message) => message.method === "thread/archived");
  assert.ok(completionIndex >= 0 && completionIndex < archiveIndex);
  assert.equal(outbound[completionIndex].params.status, "interrupted");
});

test("desktop IPC follower keeps announced background turns through active-thread LRU", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-background-lru-");
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

  follower.observeInbound(JSON.stringify({ method: "thread/list", params: {} }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, desktopConversationSnapshot("thread-background-lru-protected", {
    turns: [{ id: "turn-background-lru-protected", status: "inProgress", items: [] }],
    requests: [],
  }));
  await waitFor(() => outbound.some((message) => message.method === "turn/started"));

  for (let index = 0; index < 512; index += 1) {
    writeFrame(serverSocket, desktopConversationSnapshot(`thread-background-lru-fill-${index}`, {
      turns: [{ id: `turn-background-lru-fill-${index}`, status: "completed", items: [] }],
      requests: [],
    }));
  }
  await wait(75);

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 11,
    params: {
      conversationId: "thread-background-lru-protected",
      change: {
        type: "patches",
        patches: [{ op: "replace", path: ["turns", 0, "status"], value: "completed" }],
      },
    },
  });

  await waitFor(() => outbound.some((message) => (
    message.method === "turn/completed"
      && message.params?.threadId === "thread-background-lru-protected"
      && message.params?.status === "completed"
  )));
});
