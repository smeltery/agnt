// FILE: desktop-ipc-action-follower-running-normalized.test.js
// Purpose: Verifies Desktop IPC normalized active-turn bootstrap and snapshot coalescing.
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

test("desktop IPC follower bootstraps normalized active turns when opened from background", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-background-normalized-open-");
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

  const threadId = "thread-background-normalized-open";
  follower.observeInbound(JSON.stringify({ id: "sidebar", method: "thread/list", params: {} }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, desktopConversationSnapshot(
    threadId,
    normalizedConversationState([
      { id: "turn-background-history", status: "completed", text: "Older completed output" },
      {
        id: "turn-background-parallel",
        status: "inProgress",
        items: [{ id: "assistant-background-parallel", type: "agentMessage", text: "Parallel active block" }],
      },
      {
        id: "turn-background-open",
        status: "inProgress",
        input: [{ type: "text", text: "Continue the active task" }],
        items: [
          { id: "assistant-background-first", type: "agentMessage", text: "First active block" },
          { id: "assistant-background-second", type: "agentMessage", text: "Second active block" },
        ],
      },
    ], {
      turns: [],
      threadRuntimeStatus: { type: "active", activeFlags: [] },
    })
  ));
  await waitFor(() => outbound.some((message) => (
    message.method === "turn/started" && message.params?.threadId === threadId
  )));
  assert.equal(
    outbound.filter((message) => (
      message.method === "turn/started" && message.params?.threadId === threadId
    )).length,
    1,
    "background discovery should announce one active turn"
  );
  outbound.length = 0;

  const handled = follower.observeInbound(JSON.stringify({
    id: "metadata-only-resume",
    method: "thread/resume",
    params: { threadId, excludeTurns: true },
  }));
  assert.equal(handled, false);
  await waitFor(() => outbound.some((message) => (
    message.method === "item/started"
      && message.params?.itemId === "assistant-background-second"
  )));

  assert.equal(outbound[0].method, "thread/replaced");
  assert.deepEqual(
    outbound
      .filter((message) => message.method === "turn/started")
      .map((message) => message.params.turnId),
    ["turn-background-parallel"],
    "opening should add the other active turn without repeating the sidebar-announced run"
  );
  assert.deepEqual(
    outbound
      .filter((message) => message.method === "item/started")
      .map((message) => message.params.itemId),
    [
      "assistant-background-parallel",
      "turn-background-open:input",
      "assistant-background-first",
      "assistant-background-second",
    ]
  );
  assert.equal(
    outbound.some((message) => message.params?.itemId === "assistant-turn-background-history"),
    false,
    "opening an active chat must not replay completed historical turns"
  );
  outbound.length = 0;

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 11,
    params: {
      conversationId: threadId,
      change: {
        type: "patches",
        patches: [{
          op: "replace",
          path: ["turnHistory", "history", "entitiesByKey", "turn:turn-background-open", "items", 1, "text"],
          value: "Second active block continued",
        }],
      },
    },
  });
  await waitFor(() => outbound.some((message) => message.method === "item/agentMessage/delta"));
  assert.deepEqual(
    outbound.map((message) => ({
      method: message.method,
      itemId: message.params?.itemId,
      delta: message.params?.delta,
    })),
    [{
      method: "item/agentMessage/delta",
      itemId: "assistant-background-second",
      delta: " continued",
    }]
  );
});

test("desktop IPC follower completes either parallel active turn across normalized snapshots", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-parallel-normalized-");
  let serverSocket = null;
  const nowValue = Date.now();

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
    now: () => nowValue,
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  const threadId = "thread-parallel-normalized";
  const sendSnapshot = (firstStatus, secondStatus, runtimeType = "active") => {
    writeFrame(serverSocket, desktopConversationSnapshot(
      threadId,
      normalizedConversationState([
        { id: "turn-parallel-a", status: firstStatus, text: "" },
        { id: "turn-parallel-b", status: secondStatus, text: "" },
      ], {
        turns: [],
        threadRuntimeStatus: { type: runtimeType, activeFlags: [] },
      })
    ));
  };

  follower.observeInbound(JSON.stringify({ method: "thread/resume", params: { threadId } }));
  await waitFor(() => serverSocket);

  sendSnapshot("inProgress", "inProgress");
  await waitFor(() => outbound.filter((message) => message.method === "turn/started").length === 2);
  assert.deepEqual(
    outbound
      .filter((message) => message.method === "turn/started")
      .map((message) => message.params?.turnId),
    ["turn-parallel-a", "turn-parallel-b"]
  );
  outbound.length = 0;

  sendSnapshot("completed", "inProgress");
  await waitFor(() => outbound.some((message) => (
    message.method === "turn/completed"
      && message.params?.turnId === "turn-parallel-a"
  )));
  assert.equal(
    outbound.some((message) => (
      message.method === "turn/completed"
        && message.params?.turnId === "turn-parallel-b"
    )),
    false
  );
  assert.equal(outbound.some((message) => message.method?.startsWith("item/")), false);
  outbound.length = 0;

  sendSnapshot("completed", "completed", "idle");
  await waitFor(() => outbound.some((message) => (
    message.method === "turn/completed"
      && message.params?.turnId === "turn-parallel-b"
  )));
  assert.equal(outbound.some((message) => message.method === "turn/started"), false);
});

test("desktop IPC follower coalesces stale normalized snapshot bursts before publishing lifecycle", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-snapshot-coalesce-");
  let serverSocket = null;
  const nowValue = Date.now();

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
  const locallyOwnedThreadIds = new Set();
  const follower = createDesktopIpcActionFollower({
    socketPath,
    now: () => nowValue,
    snapshotDebounceMs: 75,
    isLocallyOwnedThread: (threadId) => locallyOwnedThreadIds.has(threadId),
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  const sendSnapshot = ({ threadId = "thread-snapshot-coalesce", oldStatus, includeNewTurn }) => {
    const turns = [{ id: "turn-old", status: oldStatus, text: "" }];
    if (includeNewTurn) {
      turns.push({ id: "turn-new", status: "inProgress", text: "" });
    }
    writeFrame(serverSocket, desktopConversationSnapshot(
      threadId,
      normalizedConversationState(turns, {
        turns: [],
        threadRuntimeStatus: { type: "active", activeFlags: [] },
      })
    ));
  };

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-snapshot-coalesce" },
  }));
  await waitFor(() => serverSocket);

  sendSnapshot({ oldStatus: "inProgress", includeNewTurn: false });
  await wait(25);
  assert.equal(follower.hasLiveThreadState("thread-snapshot-coalesce"), false);
  assert.deepEqual(outbound.filter((message) => message.method?.startsWith("turn/")), []);

  sendSnapshot({ oldStatus: "completed", includeNewTurn: true });
  await wait(50);
  assert.deepEqual(outbound.filter((message) => message.method?.startsWith("turn/")), []);

  await waitFor(() => outbound.some((message) => (
    message.method === "turn/started" && message.params?.turnId === "turn-new"
  )));
  assert.equal(
    outbound.some((message) => (
      message.method === "turn/started" && message.params?.turnId === "turn-old"
    )),
    false
  );
  assert.equal(
    outbound.filter((message) => message.method === "thread/replaced").length,
    1
  );
  outbound.length = 0;

  const locallyOwnedThreadId = "thread-owned-during-snapshot-debounce";
  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: locallyOwnedThreadId },
  }));
  sendSnapshot({
    threadId: locallyOwnedThreadId,
    oldStatus: "inProgress",
    includeNewTurn: false,
  });
  await wait(25);
  locallyOwnedThreadIds.add(locallyOwnedThreadId);
  await wait(75);

  assert.deepEqual(outbound, []);
  assert.equal(follower.hasLiveThreadState(locallyOwnedThreadId), false);
});
