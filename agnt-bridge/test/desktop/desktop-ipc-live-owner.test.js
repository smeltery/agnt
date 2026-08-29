// FILE: desktop-ipc-live-owner.test.js
// Purpose: Verifies bridge-owned Codex streams are exposed to Codex Desktop over IPC.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, net, ../../src/desktop/desktop-ipc-live-owner

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");
const {
  createDesktopIpcLiveOwner,
} = require("../../src/desktop/desktop-ipc-live-owner");
const {
  applyAppServerMessageToConversationState,
} = require("../../src/desktop/desktop-ipc-conversation-adapter");

test("conversation adapter ignores empty plan updates but keeps explanation-only updates", () => {
  const threadId = "thread-plan-visibility";
  const turnId = "turn-plan-visibility";
  const conversations = new Map();
  const apply = (message) => applyAppServerMessageToConversationState({
    conversations,
    message,
    shouldOwnThread: (candidate) => candidate === threadId,
    now: () => 1_000,
  });

  apply({
    method: "thread/started",
    params: {
      thread: {
        id: threadId,
        cwd: "/tmp/project",
        turns: [{ id: turnId, status: "inProgress", items: [] }],
      },
    },
  });

  const emptyUpdate = apply({
    method: "turn/plan/updated",
    params: { threadId, turnId, plan: [] },
  });
  assert.deepEqual(emptyUpdate, { threadId, changed: false });
  assert.deepEqual(conversations.get(threadId).turns[0].items, []);

  const explanationUpdate = apply({
    method: "turn/plan/updated",
    params: { threadId, turnId, explanation: "Keep the last meaningful plan visible.", plan: [] },
  });
  assert.deepEqual(explanationUpdate, { threadId, changed: true });
  assert.equal(conversations.get(threadId).turns[0].items.length, 1);
  assert.equal(
    conversations.get(threadId).turns[0].items[0].explanation,
    "Keep the last meaningful plan visible."
  );
});

test("live owner broadcasts phone-owned turn snapshots over Desktop IPC", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-live-owner-");
  const frames = [];
  let serverSocket = null;

  const server = net.createServer((socket) => {
    serverSocket = socket;
    attachFrameReader(socket, (frame) => {
      frames.push(frame);
      if (frame.method === "initialize") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: "initialize",
          handledByClientId: "router",
          result: { clientId: "agnt-owner-test" },
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const owner = createDesktopIpcLiveOwner({
    socketPath,
    snapshotDebounceMs: 1,
    sendCodexRequest: async () => ({ ok: true }),
    sendRawCodexMessage() {},
  });

  t.after(() => {
    owner.stopAll();
    server.close();
    serverSocket?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  owner.observeInbound(JSON.stringify({
    id: "turn-start-1",
    method: "turn/start",
    params: {
      threadId: "thread-live-owner",
      cwd: "/tmp/project",
      input: [{ type: "input_text", text: "Build it" }],
    },
  }));
  owner.observeOutbound(JSON.stringify({
    method: "thread/started",
    params: {
      thread: {
        id: "thread-live-owner",
        cwd: "/tmp/project",
        turns: [],
      },
    },
  }));
  owner.observeOutbound(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-live-owner",
      turn: {
        id: "turn-live-owner",
        items: [],
        status: "inProgress",
        startedAt: 2,
      },
    },
  }));
  owner.observeOutbound(JSON.stringify({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-live-owner",
      turnId: "turn-live-owner",
      itemId: "assistant-live-owner",
      delta: "Hello",
    },
  }));

  const broadcast = await waitForMessage(
    frames,
    (frame) => frame.type === "broadcast"
      && frame.method === "thread-stream-state-changed"
      && frame.params?.conversationId === "thread-live-owner"
  );
  assert.equal(broadcast.version, 8);
  assert.equal(broadcast.params.version, 8);
  assert.equal(broadcast.params.agntOwnerSource, "desktop-ipc-live-owner");
  assert.equal(broadcast.params.change.type, "snapshot");
  const turn = broadcast.params.change.conversationState.turns[0];
  assert.equal(turn.turnId, "turn-live-owner");
  assert.deepEqual(turn.params.input, [{ type: "input_text", text: "Build it" }]);
  assert.equal(turn.items[0].text, "Hello");
});

test("live owner confirms Desktop follow handshakes and sends an immediate baseline", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-live-owner-follow-");
  const frames = [];
  const followerChanges = [];
  let serverSocket = null;

  const server = net.createServer((socket) => {
    serverSocket = socket;
    attachFrameReader(socket, (frame) => {
      frames.push(frame);
      if (frame.method === "initialize") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: "initialize",
          handledByClientId: "router",
          result: { clientId: "agnt-owner-follow" },
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const owner = createDesktopIpcLiveOwner({
    socketPath,
    snapshotDebounceMs: 1,
    sendCodexRequest: async () => ({ ok: true }),
    sendRawCodexMessage() {},
    onFollowerStateChanged(threadId, following) {
      followerChanges.push({ threadId, following });
    },
  });
  t.after(() => {
    owner.stopAll();
    server.close();
    serverSocket?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  owner.observeInbound(JSON.stringify({
    id: "thread-follow-start",
    method: "thread/start",
    params: {
      cwd: "/tmp/project",
    },
  }));
  owner.observeOutbound(JSON.stringify({
    id: "thread-follow-start",
    result: {
      thread: {
        id: "thread-follow-handshake",
        sessionId: "thread-follow-handshake",
        preview: "hello",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: 1,
        updatedAt: 1,
        status: { type: "idle" },
        cwd: "/tmp/project",
        turns: [],
      },
    },
  }));
  await waitForMessage(frames, (frame) => frame.method === "initialize");
  await waitForMessage(
    frames,
    (frame) => frame.method === "thread-stream-following-status-requested"
      && frame.params?.conversationId === "thread-follow-handshake"
  );

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-following-changed",
    sourceClientId: "desktop-follower",
    version: 1,
    params: {
      hostId: "local",
      conversationId: "thread-follow-handshake",
      following: true,
    },
  });

  await waitFor(() => followerChanges.length === 1);
  assert.deepEqual(followerChanges, [{
    threadId: "thread-follow-handshake",
    following: true,
  }]);
  await waitForMessage(
    frames,
    (frame) => frame.method === "thread-stream-state-changed"
      && frame.params?.conversationId === "thread-follow-handshake"
  );

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-following-changed",
    sourceClientId: "desktop-follower",
    version: 1,
    params: {
      hostId: "local",
      conversationId: "thread-follow-handshake",
      following: false,
    },
  });

  await waitFor(() => followerChanges.length === 2);
  assert.deepEqual(followerChanges[1], {
    threadId: "thread-follow-handshake",
    following: false,
  });
});

test("live owner routes Desktop follower turns to Codex", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-live-owner-router-");
  const codexRequests = [];
  const desktopFrames = [];
  let desktopSocket = null;

  const owner = createDesktopIpcLiveOwner({
    socketPath,
    snapshotDebounceMs: 1,
    reconnectMs: 10,
    requestTimeoutMs: 500,
    async sendCodexRequest(method, params) {
      codexRequests.push({ method, params });
      return { turn: { id: "turn-desktop-start" } };
    },
    sendRawCodexMessage() {},
  });

  t.after(() => {
    owner.stopAll();
    desktopSocket?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  owner.observeInbound(JSON.stringify({
    method: "turn/start",
    params: { threadId: "thread-router-owned", input: [] },
  }));
  await waitFor(() => fs.existsSync(socketPath));

  desktopSocket = net.createConnection(socketPath);
  attachFrameReader(desktopSocket, (frame) => desktopFrames.push(frame));
  await new Promise((resolve) => desktopSocket.once("connect", resolve));
  writeFrame(desktopSocket, {
    type: "request",
    requestId: "desktop-init-1",
    sourceClientId: "initializing-client",
    version: 1,
    method: "initialize",
    params: { clientType: "vscode" },
  });
  await waitFor(() => desktopFrames.some((frame) => frame.requestId === "desktop-init-1"));

  writeFrame(desktopSocket, {
    type: "request",
    requestId: "desktop-start-1",
    sourceClientId: "desktop-client",
    version: 2,
    method: "thread-follower-start-turn",
    params: {
      conversationId: "thread-router-owned",
      turnStart: {
        request: {
          input: [{ type: "text", text: "continue from desktop" }],
          cwd: "/tmp/router-project",
          clientUserMessageId: "desktop-message-1",
        },
        context: {
          inheritThreadSettings: true,
        },
      },
    },
  });

  const response = await waitForMessage(
    desktopFrames,
    (frame) => frame.type === "response" && frame.requestId === "desktop-start-1"
  );
  assert.equal(response.resultType, "success");
  assert.deepEqual(codexRequests.filter((request) => request.method === "turn/start"), [{
    method: "turn/start",
    params: {
      threadId: "thread-router-owned",
      input: [{ type: "text", text: "continue from desktop" }],
      cwd: "/tmp/router-project",
      clientUserMessageId: "desktop-message-1",
    },
  }]);
});

test("live owner handles current start-turn and interrupt follower contracts", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-live-owner-follower-contracts-");
  const codexRequests = [];
  let goalPauseError = null;
  let desktopSocket = null;
  const desktopFrames = [];

  const owner = createDesktopIpcLiveOwner({
    socketPath,
    snapshotDebounceMs: 1,
    reconnectMs: 10,
    requestTimeoutMs: 500,
    async sendCodexRequest(method, params) {
      codexRequests.push({ method, params });
      if (method === "thread/goal/set" && goalPauseError) {
        throw goalPauseError;
      }
      return {
        turn: {
          id: "turn-from-follower",
          items: [],
          status: "inProgress",
        },
      };
    },
    sendRawCodexMessage() {},
  });

  t.after(() => {
    owner.stopAll();
    desktopSocket?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  owner.observeInbound(JSON.stringify({
    method: "turn/start",
    params: { threadId: "thread-owned", input: [] },
  }));
  await waitFor(() => fs.existsSync(socketPath));

  desktopSocket = net.createConnection(socketPath);
  attachFrameReader(desktopSocket, (frame) => desktopFrames.push(frame));
  await new Promise((resolve) => desktopSocket.once("connect", resolve));
  writeFrame(desktopSocket, {
    type: "request",
    requestId: "desktop-init-contracts",
    sourceClientId: "initializing-client",
    version: 1,
    method: "initialize",
    params: { clientType: "vscode" },
  });
  await waitFor(() => desktopFrames.some((frame) => frame.requestId === "desktop-init-contracts"));

  writeFrame(desktopSocket, {
    type: "request",
    requestId: "start-turn-1",
    sourceClientId: "desktop",
    version: 2,
    method: "thread-follower-start-turn",
    params: {
      conversationId: "thread-owned",
      turnStart: {
        request: {
          threadId: "thread-owned",
          input: [
            { type: "input_text", text: "continue" },
          ],
          model: "gpt-test",
          clientUserMessageId: "desktop-message-1",
          additionalContext: {
            desktop: { kind: "application", value: "window-1" },
          },
          permissions: "workspace-write",
          runtimeWorkspaceRoots: ["/tmp/project"],
          responsesapiClientMetadata: { surface: "desktop" },
          serviceTierForTurn: "priority",
          turnTrigger: "desktop-follower",
        },
        context: {
          attachments: [{ id: "display-only" }],
          inheritThreadSettings: true,
        },
      },
    },
  });

  const startResponse = await waitForMessage(
    desktopFrames,
    (frame) => frame.type === "response" && frame.requestId === "start-turn-1"
  );
  assert.equal(startResponse.resultType, "success");
  assert.deepEqual(codexRequests.filter((request) => request.method === "turn/start"), [{
    method: "turn/start",
    params: {
      threadId: "thread-owned",
      input: [
        { type: "input_text", text: "continue" },
      ],
      model: "gpt-test",
      clientUserMessageId: "desktop-message-1",
      additionalContext: {
        desktop: { kind: "application", value: "window-1" },
      },
      permissions: "workspace-write",
      runtimeWorkspaceRoots: ["/tmp/project"],
      responsesapiClientMetadata: { surface: "desktop" },
      serviceTierForTurn: "priority",
      turnTrigger: "desktop-follower",
    },
  }]);

  owner.observeOutbound(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-owned",
      turn: {
        id: "turn-from-follower",
        items: [],
        status: "inProgress",
      },
    },
  }));

  writeFrame(desktopSocket, {
    type: "request",
    requestId: "interrupt-turn-1",
    sourceClientId: "desktop",
    version: 4,
    method: "thread-follower-interrupt-turn",
    params: {
      conversationId: "thread-owned",
      mode: "user-stop",
      expectedTurnId: "turn-from-follower",
    },
  });
  const interruptResponse = await waitForMessage(
    desktopFrames,
    (frame) => frame.type === "response" && frame.requestId === "interrupt-turn-1"
  );
  assert.equal(interruptResponse.resultType, "success");
  assert.deepEqual(interruptResponse.result, {
    interruptedTurnId: "turn-from-follower",
    ok: true,
  });
  assert.deepEqual(codexRequests.filter((request) => request.method === "turn/interrupt"), [{
    method: "turn/interrupt",
    params: {
      threadId: "thread-owned",
      turnId: "turn-from-follower",
    },
  }]);

  owner.observeOutbound(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-owned",
      turn: {
        id: "turn-with-goal",
        items: [],
        status: "inProgress",
      },
    },
  }));
  owner.observeOutbound(JSON.stringify({
    method: "thread/goal/updated",
    params: {
      threadId: "thread-owned",
      goal: {
        threadId: "thread-owned",
        objective: "Finish the task",
        status: "active",
      },
    },
  }));

  const requestCountBeforeStaleInterrupt = codexRequests.length;
  writeFrame(desktopSocket, {
    type: "request",
    requestId: "interrupt-turn-stale",
    sourceClientId: "desktop",
    version: 4,
    method: "thread-follower-interrupt-turn",
    params: {
      conversationId: "thread-owned",
      mode: "user-stop",
      expectedTurnId: "turn-already-finished",
    },
  });
  const staleInterruptResponse = await waitForMessage(
    desktopFrames,
    (frame) => frame.type === "response" && frame.requestId === "interrupt-turn-stale"
  );
  assert.deepEqual(staleInterruptResponse.result, {
    interruptedTurnId: null,
    ok: true,
  });
  assert.equal(codexRequests.length, requestCountBeforeStaleInterrupt);

  writeFrame(desktopSocket, {
    type: "request",
    requestId: "interrupt-turn-with-goal",
    sourceClientId: "desktop",
    version: 4,
    method: "thread-follower-interrupt-turn",
    params: {
      conversationId: "thread-owned",
      mode: "user-stop",
    },
  });
  const goalInterruptResponse = await waitForMessage(
    desktopFrames,
    (frame) => frame.type === "response" && frame.requestId === "interrupt-turn-with-goal"
  );
  assert.deepEqual(goalInterruptResponse.result, {
    interruptedTurnId: "turn-with-goal",
    ok: true,
  });
  assert.deepEqual(codexRequests.slice(-2), [
    {
      method: "thread/goal/set",
      params: {
        threadId: "thread-owned",
        status: "paused",
      },
    },
    {
      method: "turn/interrupt",
      params: {
        threadId: "thread-owned",
        turnId: "turn-with-goal",
      },
    },
  ]);

  owner.observeOutbound(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-owned",
      turn: {
        id: "turn-with-goal-pause-error",
        items: [],
        status: "inProgress",
      },
    },
  }));
  goalPauseError = new Error("goal pause failed");
  writeFrame(desktopSocket, {
    type: "request",
    requestId: "interrupt-turn-goal-pause-error",
    sourceClientId: "desktop",
    version: 4,
    method: "thread-follower-interrupt-turn",
    params: {
      conversationId: "thread-owned",
      mode: "user-stop",
    },
  });
  const goalPauseErrorResponse = await waitForMessage(
    desktopFrames,
    (frame) => frame.type === "response" && frame.requestId === "interrupt-turn-goal-pause-error"
  );
  assert.deepEqual(goalPauseErrorResponse.result, {
    interruptedTurnId: "turn-with-goal-pause-error",
    goalPauseError: "goal pause failed",
    ok: true,
  });
  assert.equal(codexRequests.at(-1).method, "turn/interrupt");
});

test("live owner replays a pending sidebar announcement when Desktop joins its fallback router", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-live-owner-sidebar-replay-");
  const desktopFrames = [];
  let desktopSocket = null;

  const owner = createDesktopIpcLiveOwner({
    socketPath,
    sidebarRefreshDelayMs: 5,
    snapshotDebounceMs: 1,
    reconnectMs: 10,
    requestTimeoutMs: 500,
    sendCodexRequest: async () => ({ ok: true }),
    sendRawCodexMessage() {},
  });
  t.after(() => {
    owner.stopAll();
    desktopSocket?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  owner.observeInbound(JSON.stringify({
    method: "turn/start",
    params: {
      threadId: "thread-sidebar-replay",
      input: [],
    },
  }));

  await waitFor(() => fs.existsSync(socketPath));
  // Let the first announcement attempt run while only the bridge-owned router
  // is present. It must remain pending rather than count that write as delivery.
  await wait(30);
  owner.observeInbound(JSON.stringify({
    method: "thread/unsubscribe",
    params: { threadId: "thread-sidebar-replay" },
  }));
  assert.equal(
    owner.isThreadOwned("thread-sidebar-replay"),
    false,
    "sidebar metadata must outlive released stream ownership"
  );

  desktopSocket = net.createConnection(socketPath);
  attachFrameReader(desktopSocket, (frame) => desktopFrames.push(frame));
  await new Promise((resolve) => desktopSocket.once("connect", resolve));
  writeFrame(desktopSocket, {
    type: "request",
    requestId: "desktop-sidebar-replay-init",
    sourceClientId: "initializing-client",
    version: 1,
    method: "initialize",
    params: { clientType: "vscode" },
  });
  await waitFor(() => desktopFrames.some(
    (frame) => frame.type === "response"
      && frame.requestId === "desktop-sidebar-replay-init"
  ));

  const announcement = await waitForMessage(
    desktopFrames,
    (frame) => frame.type === "broadcast"
      && frame.method === "thread-unarchived"
      && frame.params?.conversationId === "thread-sidebar-replay"
  );
  assert.equal(announcement.version, 1);
  assert.equal(announcement.params.hostId, "local");
});

test("live owner replays an early sidebar announcement after rollout materialization", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-live-owner-sidebar-materialized-");
  const frames = [];
  let serverSocket = null;

  const server = net.createServer((socket) => {
    serverSocket = socket;
    attachFrameReader(socket, (frame) => {
      frames.push(frame);
      if (frame.method === "initialize") {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: "initialize",
          handledByClientId: "router",
          result: { clientId: "agnt-owner-test" },
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const owner = createDesktopIpcLiveOwner({
    socketPath,
    snapshotDebounceMs: 1,
    sidebarRefreshDelayMs: 5,
    sendCodexRequest: async () => ({ ok: true }),
    sendRawCodexMessage() {},
  });
  t.after(() => {
    owner.stopAll();
    server.close();
    serverSocket?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const announcementCount = () => frames.filter((frame) => (
    frame.type === "broadcast"
      && frame.method === "thread-unarchived"
      && frame.params?.conversationId === "thread-sidebar-race"
  )).length;

  owner.observeInbound(JSON.stringify({
    id: "sidebar-race-turn-1",
    method: "turn/start",
    params: {
      threadId: "thread-sidebar-race",
      input: [{ type: "text", text: "hi" }],
    },
  }));
  await waitForMessage(
    frames,
    (frame) => frame.type === "broadcast"
      && frame.method === "thread-unarchived"
      && frame.params?.conversationId === "thread-sidebar-race"
  );
  assert.equal(announcementCount(), 1);

  owner.observeOutbound(JSON.stringify({
    method: "item/started",
    params: {
      threadId: "thread-sidebar-race",
      turnId: "turn-sidebar-race",
      item: { id: "user-sidebar-race", type: "userMessage", content: [{ type: "text", text: "hi" }] },
    },
  }));
  await waitFor(() => announcementCount() === 2);

  // item/completed for the same persisted user item must not create an
  // unbounded refresh loop.
  owner.observeOutbound(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-sidebar-race",
      turnId: "turn-sidebar-race",
      item: { id: "user-sidebar-race", type: "userMessage", content: [{ type: "text", text: "hi" }] },
    },
  }));
  await wait(20);
  assert.equal(announcementCount(), 2);

  // Completion is the final bounded fallback for app-server/catalog write races.
  owner.observeOutbound(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-sidebar-race",
      turn: { id: "turn-sidebar-race", items: [], status: "completed" },
    },
  }));
  await waitFor(() => announcementCount() === 3);

  owner.observeInbound(JSON.stringify({
    id: "sidebar-race-turn-2",
    method: "turn/start",
    params: {
      threadId: "thread-sidebar-race",
      input: [{ type: "text", text: "again" }],
    },
  }));
  await wait(20);
  assert.equal(announcementCount(), 3);
});

function attachFrameReader(socket, onFrame) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const frameLength = buffer.readUInt32LE(0);
      if (buffer.length < 4 + frameLength) {
        return;
      }
      const payload = buffer.slice(4, 4 + frameLength).toString("utf8");
      buffer = buffer.slice(4 + frameLength);
      onFrame(JSON.parse(payload));
    }
  });
}

function writeFrame(socket, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  socket.write(Buffer.concat([header, body]));
}

async function waitForMessage(messages, predicate, timeoutMs = 1_000) {
  await waitFor(() => messages.find(predicate), timeoutMs);
  return messages.find(predicate);
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await wait(5);
  }
}

function createIpcTestSocket(prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\${path.basename(tempDir)}-ipc`
    : path.join(tempDir, "ipc.sock");
  return { tempDir, socketPath };
}
