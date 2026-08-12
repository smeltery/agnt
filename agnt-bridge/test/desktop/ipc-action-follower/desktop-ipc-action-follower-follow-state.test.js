// FILE: desktop-ipc-action-follower-follow-state.test.js
// Purpose: Verifies the bidirectional thread-stream-following-changed handshake
//          the auto-follow feature relies on: the bridge announces itself as a
//          follower of Desktop-owned threads it observes, and surfaces other
//          clients' (Codex Desktop's) follow announcements via onFollowerStateChanged.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, net, desktop-ipc-action-follower, desktop-ipc-action-follower-test-helpers

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const {
  attachFrameReader,
  writeFrame,
  waitFor,
  createIpcTestSocket,
} = require("../desktop-ipc-action-follower-test-helpers");

const { createDesktopIpcActionFollower } = require("../../../src/desktop/desktop-ipc-action-follower");

function startInitializedIpcTestServer(t, prefix, { clientId = "agnt-test" } = {}) {
  const { tempDir, socketPath } = createIpcTestSocket(prefix);
  const state = { socket: null, frames: [] };
  const server = net.createServer((socket) => {
    state.socket = socket;
    attachFrameReader(socket, (frame) => {
      state.frames.push(frame);
      if (frame.method === "initialize") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: "initialize",
          handledByClientId: "desktop",
          result: { clientId },
        });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      t.after(() => {
        server.close();
        state.socket?.destroy();
        fs.rmSync(tempDir, { recursive: true, force: true });
      });
      resolve({ socketPath, state });
    });
  });
}

test("desktop-owned follow handshakes notify the navigation controller", async (t) => {
  const { socketPath, state } = await startInitializedIpcTestServer(
    t,
    "agnt-action-follower-follow-"
  );
  const followerChanges = [];
  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse() {},
    onFollowerStateChanged(threadId, following) {
      followerChanges.push({ threadId, following });
    },
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/list",
    params: {},
  }));
  await waitFor(() => state.socket);

  writeFrame(state.socket, {
    type: "broadcast",
    method: "thread-stream-following-changed",
    sourceClientId: "desktop-renderer",
    version: 1,
    params: {
      hostId: "local",
      conversationId: "thread-desktop-follow",
      following: true,
    },
  });
  await waitFor(() => followerChanges.length === 1);
  assert.deepEqual(followerChanges[0], {
    threadId: "thread-desktop-follow",
    following: true,
  });

  writeFrame(state.socket, {
    type: "broadcast",
    method: "client-status-changed",
    sourceClientId: "router",
    version: 1,
    params: {
      clientId: "desktop-renderer",
      status: "disconnected",
    },
  });
  await waitFor(() => followerChanges.length === 2);
  assert.deepEqual(followerChanges[1], {
    threadId: "thread-desktop-follow",
    following: false,
  });
});

test("phone thread reads subscribe the bridge to Desktop-owned state patches", async (t) => {
  const { socketPath, state } = await startInitializedIpcTestServer(
    t,
    "agnt-action-follower-phone-follow-"
  );
  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse() {},
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    id: "phone-read",
    method: "thread/read",
    params: { threadId: "thread-open-on-phone" },
  }));

  await waitFor(() => state.frames.some((frame) => (
    frame.method === "thread-stream-following-changed"
      && frame.params?.conversationId === "thread-open-on-phone"
      && frame.params?.following === true
  )));
  const follow = state.frames.find((frame) => (
    frame.method === "thread-stream-following-changed"
      && frame.params?.conversationId === "thread-open-on-phone"
  ));
  assert.equal(follow.sourceClientId, "agnt-test");
});
