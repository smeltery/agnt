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

test("desktop IPC background recovery stays lifecycle-only until open", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-background-recovery-");
  let serverSocket = null;
  let readAttempts = 0;
  const baseline = {
    turns: [{
      status: "inProgress",
      items: [{ id: "assistant-background-recovery", type: "assistant_message", text: "A" }],
    }],
    requests: [],
  };

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
    async readConversationState() {
      readAttempts += 1;
      return structuredClone(baseline);
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({ method: "thread/list", params: {} }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, desktopConversationSnapshot("thread-background-recovery", {
    turns: [{ status: "inProgress", items: [] }],
    requests: [],
  }));
  await waitFor(() => outbound.some((message) => message.method === "turn/started"));
  const started = outbound.find((message) => message.method === "turn/started");
  assert.equal(started.params.turnId, "ipc-turn-0");

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 11,
    params: {
      conversationId: "thread-background-recovery",
      change: {
        type: "patches",
        patches: [{
          op: "replace",
          path: ["turns", 0, "items", 0, "text"],
          value: "AB",
        }],
      },
    },
  });

  await waitFor(() => readAttempts > 0);
  await wait(25);
  assert.equal(
    outbound.some((message) => (
      message.method === "item/agentMessage/delta"
        && message.params?.threadId === "thread-background-recovery"
    )),
    false,
    "baseline recovery for unopened chats should not publish transcript deltas"
  );

  const readHandled = follower.observeInbound(JSON.stringify({
    id: "open-background-recovery",
    method: "thread/read",
    params: { threadId: "thread-background-recovery" },
  }));
  assert.equal(readHandled, true);
  assert.equal(
    outbound.find((message) => message.id === "open-background-recovery")
      ?.result?.thread?.turns?.[0]?.items?.[0]?.text,
    "AB"
  );

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 11,
    params: {
      conversationId: "thread-background-recovery",
      change: {
        type: "patches",
        patches: [{
          op: "replace",
          path: ["turns", 0, "items", 0, "text"],
          value: "ABC",
        }],
      },
    },
  });
  await waitFor(() => outbound.some((message) => (
    message.method === "item/agentMessage/delta"
      && message.params?.threadId === "thread-background-recovery"
      && message.params?.delta === "C"
  )));
});

test("desktop IPC follower discovers normalized running sidebar threads before open", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-normalized-background-");
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
  writeFrame(serverSocket, desktopConversationSnapshot(
    "thread-normalized-background",
    normalizedConversationState([
      { id: "turn-normalized-old", status: "completed", text: "done" },
      { id: "turn-normalized-running", status: "inProgress", text: "Working" },
    ], { turns: [] })
  ));

  await waitFor(() => outbound.some((message) => (
    message.method === "turn/started"
      && message.params?.threadId === "thread-normalized-background"
      && message.params?.turnId === "turn-normalized-running"
  )));
  assert.equal(
    outbound.some((message) => message.method === "item/agentMessage/delta"),
    false,
    "normalized unopened snapshots should remain lifecycle-only"
  );

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 11,
    params: {
      conversationId: "thread-normalized-background",
      change: {
        type: "patches",
        patches: [{
          op: "replace",
          path: ["turnHistory", "history", "entitiesByKey", "turn:turn-normalized-running", "status"],
          value: "completed",
        }],
      },
    },
  });
  await waitFor(() => outbound.some((message) => (
    message.method === "turn/completed"
      && message.params?.threadId === "thread-normalized-background"
      && message.params?.turnId === "turn-normalized-running"
      && message.params?.status === "completed"
  )));
});

test("desktop IPC follower yields normalized history reads while keeping live tail", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-normalized-live-tail-");
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
  writeFrame(serverSocket, desktopConversationSnapshot(
    "thread-normalized-live-tail",
    normalizedConversationState([
      { id: "turn-normalized-history", status: "completed", text: "old" },
      { id: "turn-normalized-live", status: "inProgress", text: "A" },
    ], { turns: [] })
  ));
  await waitFor(() => outbound.some((message) => message.method === "turn/started"));

  const handledRead = follower.observeInbound(JSON.stringify({
    id: "read-normalized-history",
    method: "thread/read",
    params: { threadId: "thread-normalized-live-tail" },
  }));
  assert.equal(handledRead, false);
  assert.equal(
    outbound.some((message) => message.id === "read-normalized-history"),
    false,
    "normalized history reads should fall through to canonical history"
  );

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 11,
    params: {
      conversationId: "thread-normalized-live-tail",
      change: {
        type: "patches",
        patches: [{
          op: "replace",
          path: ["turnHistory", "history", "entitiesByKey", "turn:turn-normalized-live", "items", 0, "text"],
          value: "AB",
        }],
      },
    },
  });
  await waitFor(() => outbound.some((message) => (
    message.method === "thread/replaced"
      && message.params?.threadId === "thread-normalized-live-tail"
  )));

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 11,
    params: {
      conversationId: "thread-normalized-live-tail",
      change: {
        type: "patches",
        patches: [{
          op: "replace",
          path: ["turnHistory", "history", "entitiesByKey", "turn:turn-normalized-live", "items", 0, "text"],
          value: "ABC",
        }],
      },
    },
  });
  await waitFor(() => outbound.some((message) => (
    message.method === "item/agentMessage/delta"
      && message.params?.threadId === "thread-normalized-live-tail"
      && message.params?.turnId === "turn-normalized-live"
      && message.params?.delta === "C"
  )));
});

test("desktop IPC follower treats normalized rehydration snapshots as baselines", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-normalized-rehydrate-");
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

  const threadId = "thread-normalized-rehydrate";
  follower.observeInbound(JSON.stringify({ method: "thread/resume", params: { threadId } }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, desktopConversationSnapshot(
    threadId,
    normalizedConversationState([
      { id: "turn-normalized-history", status: "completed", text: "old" },
      { id: "turn-normalized-live", status: "inProgress", text: "A" },
    ], { turns: [] })
  ));
  await waitFor(() => outbound.some((message) => message.method === "thread/replaced"));
  outbound.length = 0;

  writeFrame(serverSocket, desktopConversationSnapshot(
    threadId,
    normalizedConversationState([
      { id: "turn-normalized-history", status: "completed", text: "old" },
      {
        id: "turn-normalized-live",
        status: "inProgress",
        text: "A",
        itemId: "assistant-rehydrated-live",
      },
    ], { turns: [] })
  ));
  await wait(50);

  assert.equal(
    outbound.some((message) => message.method?.startsWith("item/")),
    false,
    "a full normalized rehydration snapshot must not replay historical item rows"
  );
  assert.equal(
    outbound.some((message) => message.method === "turn/started"),
    false,
    "the same active turn must not restart on baseline rehydration"
  );
});
