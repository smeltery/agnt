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

test("desktop IPC follower accepts peer ownership snapshots before a phone resume", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-peer-snapshot-before-resume-");
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
          result: { turn: { id: "turn-peer-snapshot" } },
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
    forwardToLocalCodex() {},
    requestTimeoutMs: 500,
    ownershipProbeTimeoutMs: 2_000,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-other-active" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "agnt-owner",
    version: 6,
    params: {
      conversationId: "thread-peer-before-resume",
      agntOwnerSource: "desktop-ipc-live-owner",
      change: { type: "snapshot", conversationState: { turns: [], requests: [] } },
    },
  });
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    version: 6,
    params: {
      conversationId: "thread-peer-before-resume",
      change: { type: "snapshot", conversationState: { turns: [], requests: [] } },
    },
  });
  await wait(25);

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-peer-before-resume" },
  }));
  assert.equal(follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-peer-before-resume",
    method: "turn/start",
    params: {
      threadId: "thread-peer-before-resume",
      input: [{ type: "input_text", text: "desktop owns now" }],
    },
  })), true);

  await waitFor(() => serverFrames.find((frame) => frame.method === "thread-follower-start-turn"), 1_000);
  await waitFor(() => outbound.find((message) => message.id === "phone-turn-start-peer-before-resume"), 1_000);
  assert.deepEqual(outbound.find((message) => message.id === "phone-turn-start-peer-before-resume"), {
    id: "phone-turn-start-peer-before-resume",
    result: { turn: { id: "turn-peer-snapshot" } },
  });
});

test("desktop IPC follower ignores peer patches while the live owner owns a thread", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-ignore-peer-patch-");
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
    params: { threadId: "thread-ignore-peer-patch" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "agnt-owner",
    version: 6,
    params: {
      conversationId: "thread-ignore-peer-patch",
      agntOwnerSource: "desktop-ipc-live-owner",
      change: { type: "snapshot", conversationState: { turns: [], requests: [] } },
    },
  });
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-patch",
    version: 6,
    params: {
      conversationId: "thread-ignore-peer-patch",
      change: {
        type: "patches",
        patches: [{
          op: "add",
          path: ["requests", 0],
          value: {
            id: "req-peer-patch",
            method: "item/fileChange/requestApproval",
            params: {
              threadId: "thread-ignore-peer-patch",
              turnId: "turn-peer-patch",
              itemId: "item-peer-patch",
            },
          },
        }],
      },
    },
  });
  await wait(25);

  assert.equal(follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-ignore-peer-patch",
    method: "turn/start",
    params: {
      threadId: "thread-ignore-peer-patch",
      input: [{ type: "input_text", text: "stay with live owner" }],
    },
  })), false);
  await wait(25);
  assert.equal(
    serverFrames.some((frame) => frame.method === "thread-follower-start-turn"),
    false
  );
});

test("desktop IPC follower ignores Desktop echoes for locally owned threads", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-local-owner-echo-");
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

  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse() {},
    requestTimeoutMs: 500,
    // Simulates the bridge's live owner claiming the thread before any
    // live-owner broadcast has been observed on this socket.
    isLocallyOwnedThread: (threadId) => threadId === "thread-local-echo",
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-local-echo" },
  }));
  await waitFor(() => serverSocket);

  // An untagged Desktop snapshot of the locally-streamed thread must not become
  // follower state that would shadow the app-server for reads.
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-echo",
    version: 6,
    params: {
      conversationId: "thread-local-echo",
      change: { type: "snapshot", conversationState: { turns: [], requests: [] } },
    },
  });
  await wait(25);

  assert.equal(follower.hasLiveThreadState("thread-local-echo"), false);
});
