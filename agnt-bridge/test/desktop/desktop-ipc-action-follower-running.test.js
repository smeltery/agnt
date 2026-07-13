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

test("desktop IPC follower falls back locally when no Desktop client can handle the request", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-follower-local-fallback-");
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
        // Router-style no-handler error: the request never reached any client,
        // so retrying it locally is safe.
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "error",
          method: frame.method,
          handledByClientId: "",
          error: "No Codex IPC client can handle thread-follower-start-turn.",
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
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-route-fallback" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-route-fallback",
      change: {
        type: "snapshot",
        conversationState: { turns: [], requests: [] },
      },
    },
  });
  await wait(25);

  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-route-fallback",
    method: "turn/start",
    params: {
      threadId: "thread-route-fallback",
      input: [{ type: "input_text", text: "continue locally after failure" }],
    },
  }));
  assert.equal(handled, true);
  await waitFor(() => localForwards.length === 1);
  assert.equal(localForwards[0].id, "phone-turn-start-route-fallback");
  assert.equal(localForwards[0].method, "turn/start");
  assert.equal(outbound.some((message) => message.id === "phone-turn-start-route-fallback"), false);

  const handledAgain = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-route-fallback-2",
    method: "turn/start",
    params: {
      threadId: "thread-route-fallback",
      input: [{ type: "input_text", text: "stay local" }],
    },
  }));
  assert.equal(handledAgain, false);
  assert.equal(
    serverFrames.filter((frame) => frame.method === "thread-follower-start-turn").length,
    1
  );
});

test("desktop IPC follower falls back locally when Desktop settings sync times out before turn delivery", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-follower-settings-timeout-");
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
          handledByClientId: "desktop",
          result: { clientId: "agnt-test" },
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve)); t.after(() => { server.close(); serverSocket?.destroy(); fs.rmSync(tempDir, { recursive: true, force: true }); });

  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse: (message) => outbound.push(JSON.parse(message)),
    forwardToLocalCodex: (rawMessage) => localForwards.push(JSON.parse(rawMessage)),
    requestTimeoutMs: 100,
  }); t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({ method: "thread/resume", params: { threadId: "thread-settings-timeout" } }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-settings-timeout",
      change: { type: "snapshot", conversationState: { turns: [], requests: [] } },
    },
  });
  await wait(25);

  assert.equal(follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-settings-timeout",
    method: "turn/start",
    params: {
      threadId: "thread-settings-timeout",
      input: [{ type: "input_text", text: "continue despite stale Desktop owner" }],
      model: "gpt-test",
      effort: "low",
    },
  })), true);

  await waitFor(() => localForwards.length === 1, 1_000);
  assert.deepEqual([localForwards[0].id, localForwards[0].method], ["phone-turn-start-settings-timeout", "turn/start"]);
  assert.equal(serverFrames.some((frame) => frame.method === "thread-follower-start-turn"), false);
  assert.equal(outbound.some((message) => message.id === "phone-turn-start-settings-timeout"), false);
});

test("desktop IPC follower does not rerun ambiguous Desktop failures locally", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-follower-ambiguous-error-");
  const localForwards = [];
  let serverSocket = null;
  let respondWithTimeout = false;

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
      } else if (frame.method === "thread-follower-start-turn" && !respondWithTimeout) {
        // Explicit Desktop-side error: the request reached the owner, so the
        // bridge must not rerun the same turn on the local app-server.
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "error",
          method: frame.method,
          handledByClientId: "desktop",
          error: "Desktop rejected the turn",
        });
      }
      // When respondWithTimeout is set, never answer so the request times out.
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
    requestTimeoutMs: 150,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-ambiguous-error" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-ambiguous-error",
      change: {
        type: "snapshot",
        conversationState: { turns: [], requests: [] },
      },
    },
  });
  await wait(25);

  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-desktop-error",
    method: "turn/start",
    params: {
      threadId: "thread-ambiguous-error",
      input: [{ type: "input_text", text: "explicit desktop error" }],
    },
  }));
  assert.equal(handled, true);
  await waitFor(() => outbound.some((message) => message.id === "phone-turn-start-desktop-error"));
  const errorResponse = outbound.find((message) => message.id === "phone-turn-start-desktop-error");
  assert.equal(errorResponse.error.code, -32000);
  assert.deepEqual(localForwards, []);

  respondWithTimeout = true;
  const handledTimeout = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-desktop-timeout",
    method: "turn/start",
    params: {
      threadId: "thread-ambiguous-error",
      input: [{ type: "input_text", text: "desktop timeout" }],
    },
  }));
  assert.equal(handledTimeout, true);
  await waitFor(() => outbound.some((message) => message.id === "phone-turn-start-desktop-timeout"), 1_000);
  const timeoutResponse = outbound.find((message) => message.id === "phone-turn-start-desktop-timeout");
  assert.equal(timeoutResponse.error.code, -32000);
  assert.deepEqual(localForwards, []);
});

test("desktop IPC follower mirrors live assistant text growth from desktop state", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-assistant-delta-");
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
    params: { threadId: "thread-live-delta" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-live-delta",
      change: {
        type: "snapshot",
        conversationState: {
          turns: [{
            id: "turn-live-delta",
            status: "inProgress",
            items: [{
              id: "assistant-live-delta",
              type: "assistant_message",
              text: "Hello",
            }],
          }],
        },
      },
    },
  });
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-live-delta",
      change: {
        type: "patches",
        patches: [{
          op: "replace",
          path: ["turns", 0, "items", 0, "text"],
          value: "Hello world",
        }],
      },
    },
  });

  await waitFor(() => outbound.find((message) => message.method === "item/agentMessage/delta"));
  const deltaMessage = outbound.find((message) => message.method === "item/agentMessage/delta");
  assert.equal(deltaMessage.params.threadId, "thread-live-delta");
  assert.equal(deltaMessage.params.turnId, "turn-live-delta");
  assert.equal(deltaMessage.params.itemId, "assistant-live-delta");
  assert.equal(deltaMessage.params.delta, " world");
  assert.equal(deltaMessage.params.agntDesktopMirror, true);
  assert.equal(deltaMessage.params.agntDesktopIpcMirror, true);
});

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
