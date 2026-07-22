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
} = require("../desktop-ipc-action-follower-test-helpers");

const {
  createDesktopIpcActionFollower,
  resolveDefaultIpcSocketPath,
} = require("../../../src/desktop/desktop-ipc-action-follower");

test("desktop IPC follower ignores agnt-owned live owner broadcasts", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-owner-echo-");
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
    params: { threadId: "thread-owner-broadcast" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "agnt-owner",
    version: 6,
    params: {
      conversationId: "thread-owner-broadcast",
      agntOwnerSource: "desktop-ipc-live-owner",
      change: {
        type: "snapshot",
        conversationState: {
          turns: [{
            id: "turn-owner-broadcast",
            items: [{
              id: "assistant-owner-broadcast",
              type: "agentMessage",
              text: "This is already phone-bound through app-server.",
            }],
          }],
          requests: [{
            id: "req-owner-broadcast",
            method: "item/fileChange/requestApproval",
            params: {
              threadId: "thread-owner-broadcast",
              turnId: "turn-owner-broadcast",
              itemId: "file-owner-broadcast",
            },
          }],
        },
      },
    },
  });

  await wait(50);
  assert.deepEqual(outbound, []);
});

test("desktop IPC follower stops serving stale active-turn caches to phone reads", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-stale-active-read-");
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

  let fakeNow = 1_000_000;
  const outbound = [];
  const follower = createDesktopIpcActionFollower({
    socketPath,
    now: () => fakeNow,
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-stale-active" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-live",
    version: 6,
    params: {
      conversationId: "thread-stale-active",
      change: {
        type: "snapshot",
        conversationState: {
          turns: [{
            id: "turn-stale-active",
            status: "inProgress",
            items: [],
          }],
          requests: [],
        },
      },
    },
  });
  await waitFor(() => follower.hasLiveThreadState("thread-stale-active"));

  // While Desktop keeps the stream fresh, cached reads answer immediately.
  assert.equal(follower.hasFreshLiveThreadState("thread-stale-active"), true);
  const freshServed = follower.observeInbound(JSON.stringify({
    id: "read-fresh",
    method: "thread/read",
    params: { threadId: "thread-stale-active" },
  }));
  assert.equal(freshServed, true);
  assert.equal(outbound.some((message) => message.id === "read-fresh"), true);

  // Desktop can be quiet during long-running tools, approvals, and subagents.
  // While the IPC publisher itself is still responsive, cached active reads stay
  // authoritative so the phone does not clear Stop from a real running turn.
  fakeNow += 21_000;
  assert.equal(follower.hasLiveThreadState("thread-stale-active"), true);
  assert.equal(follower.hasFreshLiveThreadState("thread-stale-active"), false);
  const quietServed = follower.observeInbound(JSON.stringify({
    id: "read-quiet-connected",
    method: "thread/read",
    params: { threadId: "thread-stale-active" },
  }));
  assert.equal(quietServed, true);
  assert.equal(outbound.some((message) => message.id === "read-quiet-connected"), true);

  // Once the IPC publisher has not produced frames for its generous activity
  // lease, the same active cache is stale evidence and reads fall through to
  // local recovery instead of pinning a phantom running indicator on the phone.
  // The same staleness must unmute the rollout fallback mirror
  // (hasFreshLiveThreadState false while hasLiveThreadState stays true) so the
  // reopened thread recovers.
  fakeNow += 5 * 60_000;
  const staleServed = follower.observeInbound(JSON.stringify({
    id: "read-stale",
    method: "thread/read",
    params: { threadId: "thread-stale-active" },
  }));
  assert.equal(staleServed, false);
  assert.equal(outbound.some((message) => message.id === "read-stale"), false);

  // The next fresh Desktop snapshot starts a new source epoch. It must arrive as
  // one replacement bootstrap, not as an incremental completion of stale state.
  const freshEpochStartIndex = outbound.length;
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-live",
    version: 6,
    params: {
      conversationId: "thread-stale-active",
      change: {
        type: "snapshot",
        conversationState: {
          turns: [{
            id: "turn-stale-active",
            status: "completed",
            items: [{
              id: "assistant-fresh-epoch",
              type: "agentMessage",
              text: "Fresh Desktop epoch.",
            }],
          }],
          requests: [],
        },
      },
    },
  });
  await waitFor(() => {
    const messages = outbound.slice(freshEpochStartIndex);
    return messages.some((message) => message.method === "thread/replaced")
      && messages.some((message) => message.method === "thread/started");
  });
  const freshEpochMessages = outbound.slice(freshEpochStartIndex);
  const replacementAnnouncementIndex = freshEpochMessages.findIndex((message) => (
    message.method === "thread/replaced"
  ));
  const replacementBootstrapIndex = freshEpochMessages.findIndex((message) => (
    message.method === "thread/started"
  ));
  assert.ok(replacementAnnouncementIndex >= 0);
  assert.ok(replacementAnnouncementIndex < replacementBootstrapIndex);
  const replacementBootstrap = freshEpochMessages.find((message) => (
    message.method === "thread/started"
  ));
  assert.equal(replacementBootstrap.params.threadId, "thread-stale-active");
  assert.equal(replacementBootstrap.params.agntDesktopMirror, true);
  assert.deepEqual(
    replacementBootstrap.params.thread.turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      itemIDs: turn.items.map((item) => item.id),
    })),
    [{
      id: "turn-stale-active",
      status: "completed",
      itemIDs: ["assistant-fresh-epoch"],
    }]
  );
  assert.equal(
    freshEpochMessages.some((message) => message.method === "turn/completed"),
    false
  );
  assert.equal(follower.hasLiveThreadState("thread-stale-active"), true);

  // Idle cached threads have no phantom-running risk: they stay servable even
  // after the active-state freshness window elapses again.
  fakeNow += 60_000;
  const idleServed = follower.observeInbound(JSON.stringify({
    id: "read-idle",
    method: "thread/read",
    params: { threadId: "thread-stale-active" },
  }));
  assert.equal(idleServed, true);
  const idleResponse = outbound.find((message) => message.id === "read-idle");
  assert.equal(idleResponse.result.thread.turns[0].status, "completed");
  assert.equal(idleResponse.result.thread.turns[0].items[0].id, "assistant-fresh-epoch");
});

test("desktop IPC follower keeps phone interest in a thread across a Desktop disconnect", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-active-thread-disconnect-");
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
    params: { threadId: "thread-interest-disconnect" },
  }));
  await waitFor(() => serverSocket);

  // Before any disconnect, phone interest plus a live ownership probe window
  // means a quick turn/start is held rather than treated as unroutable.
  const heldBeforeDisconnect = follower.observeInbound(JSON.stringify({
    id: "phone-turn-before-disconnect",
    method: "turn/start",
    params: {
      threadId: "thread-interest-disconnect",
      input: [{ type: "input_text", text: "before disconnect" }],
    },
  }));
  assert.equal(heldBeforeDisconnect, true);

  serverSocket.destroy();
  await wait(25);

  // Phone interest is phone-scoped, not connection-scoped: a transient Desktop
  // disconnect must NOT drop it, or reconnect snapshots for a thread the phone
  // is still viewing would be ignored until the phone issues a fresh read. The
  // same ownership-probe window (still unexpired) must keep holding the turn.
  const handledAfterDisconnect = follower.observeInbound(JSON.stringify({
    id: "phone-turn-after-disconnect",
    method: "turn/start",
    params: {
      threadId: "thread-interest-disconnect",
      input: [{ type: "input_text", text: "after disconnect" }],
    },
  }));
  assert.equal(handledAfterDisconnect, true);
});

test("desktop IPC follower caps activeThreadIds so a marathon connection cannot grow it forever", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-active-thread-cap-");
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

  const oldestThreadId = "thread-cap-0";
  // MAX_ACTIVE_THREAD_IDS is 512: one more distinct thread than the cap must
  // evict the oldest LRU entry.
  const totalThreads = 513;
  for (let i = 0; i < totalThreads; i += 1) {
    follower.observeInbound(JSON.stringify({
      method: "thread/resume",
      params: { threadId: `thread-cap-${i}` },
    }));
  }
  await waitFor(() => serverSocket);

  const heldOldest = follower.observeInbound(JSON.stringify({
    id: "phone-turn-cap-oldest",
    method: "turn/start",
    params: {
      threadId: oldestThreadId,
      input: [{ type: "input_text", text: "oldest thread" }],
    },
  }));
  assert.equal(heldOldest, false, "the oldest thread id should have been evicted once the cap was exceeded");

  const newestThreadId = `thread-cap-${totalThreads - 1}`;
  const heldNewest = follower.observeInbound(JSON.stringify({
    id: "phone-turn-cap-newest",
    method: "turn/start",
    params: {
      threadId: newestThreadId,
      input: [{ type: "input_text", text: "newest thread" }],
    },
  }));
  assert.equal(heldNewest, true, "the most recently observed thread id should still be treated as active");
});
