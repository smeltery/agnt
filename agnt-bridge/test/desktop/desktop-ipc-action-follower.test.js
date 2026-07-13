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

test("desktop IPC follower backs off baseline recovery instead of hot-looping", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-recovery-backoff-");
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
  let readAttempts = 0;
  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    async readConversationState() {
      readAttempts += 1;
      throw new Error("thread not loaded");
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-backoff" },
  }));
  await waitFor(() => serverSocket);

  const patchBroadcast = (value) => ({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-backoff",
      change: {
        type: "patches",
        patches: [{ op: "replace", path: ["turns", 0, "items", 0, "text"], value }],
      },
    },
  });

  // A burst of patch-only broadcasts must trigger at most one immediate read
  // attempt; retries wait for the backoff window instead of running per patch.
  for (let index = 0; index < 5; index += 1) {
    writeFrame(serverSocket, patchBroadcast(`delta ${index}`));
  }
  await wait(100);
  assert.equal(readAttempts, 1);

  // Failed recovery must not leak speculative timeline rows to the phone.
  assert.deepEqual(
    outbound.filter((message) => typeof message.method === "string"
      && (message.method.startsWith("item/") || message.method.startsWith("turn/"))),
    []
  );
});

test("desktop IPC follower announces thread replacement when synthetic turn ids become real", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-follower-full-replace-");
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
    params: { threadId: "thread-full-replace" },
  }));
  await waitFor(() => serverSocket);

  // First snapshot carries a turn without any id, so the projector synthesizes one.
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-full-replace",
      change: {
        type: "snapshot",
        conversationState: {
          turns: [{
            status: "inProgress",
            items: [{ id: "assistant-replace", type: "agentMessage", text: "partial" }],
          }],
          requests: [],
        },
      },
    },
  });
  await waitFor(() => outbound.some((message) => message.method === "turn/started"));

  // The next snapshot has the canonical turn id: the phone must be told to rebuild.
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-full-replace",
      change: {
        type: "snapshot",
        conversationState: {
          turns: [{
            turnId: "turn-real-id",
            status: "inProgress",
            items: [{ id: "assistant-replace", type: "agentMessage", text: "partial" }],
          }],
          requests: [],
        },
      },
    },
  });

  await waitFor(() => outbound.some((message) => message.method === "thread/replaced"));
  const replaced = outbound.find((message) => message.method === "thread/replaced");
  assert.equal(replaced.params.threadId, "thread-full-replace");
  assert.equal(replaced.params.agntDesktopMirror, true);
  assert.equal(replaced.params.agntDesktopIpcMirror, true);
  // No embedded thread: the phone rebuilds from canonical history, and heavy
  // threads must not ship as one oversized relay frame.
  assert.equal(replaced.params.thread, undefined);

  // The replacement bootstrap follows the announcement with the real turn id.
  const replacedIndex = outbound.indexOf(replaced);
  const followUpTurnStarted = outbound.slice(replacedIndex + 1)
    .find((message) => message.method === "turn/started");
  assert.equal(followUpTurnStarted.params.turnId, "turn-real-id");
});

test("uses the Codex Desktop named pipe as the default Windows IPC path", (t) => {
  useProcessPlatform(t, "win32");
  assert.equal(resolveDefaultIpcSocketPath(), "\\\\.\\pipe\\codex-ipc");
});

test("desktop IPC follower projects first add patch-only action updates without a baseline read", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-recovery-");
  let baselineReads = 0;
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
    async readConversationState() {
      baselineReads += 1;
      await wait(30);
      return { requests: [] };
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-patch" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-patch",
      change: {
        type: "patches",
        patches: [{
          op: "add",
          path: ["requests", 0],
          value: {
            id: "req-patch",
            method: "item/tool/requestUserInput",
            params: {
              threadId: "thread-patch",
              turnId: "turn-patch",
              itemId: "item-patch",
              questions: [{ id: "q1", question: "Continue?" }],
            },
          },
        }],
      },
    },
  });
  await wait(25);

  assert.equal(baselineReads, 0);
  assert.equal(outbound[0].id, "req-patch");
  assert.equal(outbound[0].method, "item/tool/requestUserInput");
});

test("desktop IPC follower uses baseline recovery for patch-only updates that need existing state", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-replace-recovery-");
  let baselineReads = 0;
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
    async readConversationState() {
      baselineReads += 1;
      return {
        requests: [{
          id: "req-recovered",
          method: "item/tool/requestUserInput",
          completed: true,
          params: {
            threadId: "thread-replace",
            turnId: "turn-replace",
            itemId: "item-replace",
            questions: [{ id: "q1", question: "Continue?" }],
          },
        }],
      };
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-replace" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-replace",
      change: {
        type: "patches",
        patches: [{
          op: "replace",
          path: ["requests", 0, "completed"],
          value: false,
        }],
      },
    },
  });
  await wait(40);

  assert.equal(baselineReads, 1);
  assert.equal(outbound[0].id, "req-recovered");
  assert.equal(outbound[0].method, "item/tool/requestUserInput");
});

test("desktop IPC follower does not issue baseline reads just because a chat opens", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-lazy-recovery-");
  let baselineReads = 0;
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
    async readConversationState() {
      baselineReads += 1;
      return { requests: [] };
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-open" },
  }));
  await waitFor(() => serverSocket);
  await wait(40);

  assert.equal(baselineReads, 0);
});

test("desktop IPC follower waits for a usable snapshot when a first patch needs missing state", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-wait-snapshot-");
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
    params: { threadId: "thread-wait-snapshot" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-wait-snapshot",
      change: {
        type: "patches",
        patches: [{
          op: "replace",
          path: ["requests", 0, "completed"],
          value: false,
        }],
      },
    },
  });
  await wait(25);
  assert.equal(outbound.length, 0);

  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-wait-snapshot",
      change: {
        type: "snapshot",
        conversationState: {
          requests: [{
            id: "req-after-snapshot",
            method: "item/tool/requestUserInput",
            params: {
              threadId: "thread-wait-snapshot",
              turnId: "turn-after-snapshot",
              itemId: "item-after-snapshot",
              questions: [{ id: "q1", question: "Continue?" }],
            },
          }],
        },
      },
    },
  });
  await wait(25);

  assert.equal(outbound[0].id, "req-after-snapshot");
  assert.equal(outbound[0].method, "item/tool/requestUserInput");
});

test("desktop IPC follower does not block add patch-only actions on a failing baseline reader", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-recovery-fallback-");
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

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  t.after(() => {
    console.warn = originalWarn;
  });

  const outbound = [];
  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    async readConversationState() {
      throw new Error("Codex request timed out: thread/read");
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  follower.observeInbound(JSON.stringify({
    method: "thread/resume",
    params: { threadId: "thread-patch-fallback" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 5,
    params: {
      conversationId: "thread-patch-fallback",
      change: {
        type: "patches",
        patches: [{
          op: "add",
          path: ["requests", 0],
          value: {
            id: "req-fallback",
            method: "item/tool/requestUserInput",
            params: {
              threadId: "thread-patch-fallback",
              turnId: "turn-fallback",
              itemId: "item-fallback",
              questions: [{ id: "q1", question: "Continue?" }],
            },
          },
        }],
      },
    },
  });
  await wait(40);

  assert.equal(outbound[0].id, "req-fallback");
  assert.equal(outbound[0].method, "item/tool/requestUserInput");
  assert.equal(warnings.length, 0);
});

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

test("desktop IPC follower routes phone turns to Desktop-owned threads", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-follower-turn-start-");
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
      } else if (frame.method?.startsWith("thread-follower-")) {
        writeFrame(socket, {
          type: "response",
          requestId: frame.requestId,
          resultType: "success",
          method: frame.method,
          handledByClientId: "desktop",
          result: frame.method === "thread-follower-start-turn"
            ? { result: { turn: { id: "turn-from-phone" } } }
            : { turn: { id: "turn-from-phone" } },
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
    params: { threadId: "thread-desktop-owned" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-desktop-owned",
      change: {
        type: "snapshot",
        conversationState: {
          turns: [],
          requests: [],
        },
      },
    },
  });
  await wait(25);

  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-turn-start-1",
    method: "turn/start",
    params: {
      threadId: "thread-desktop-owned",
      input: [{ type: "input_text", text: "continue from phone" }],
      cwd: "/repo",
      model: "gpt-test",
    },
  }));
  assert.equal(handled, true);

  await waitFor(() => serverFrames.find((frame) => frame.method === "thread-follower-start-turn"));
  const turnStartFrame = serverFrames.find((frame) => frame.method === "thread-follower-start-turn");
  assert.equal(turnStartFrame.version, 1);
  assert.deepEqual(turnStartFrame.params, {
    conversationId: "thread-desktop-owned",
    senderRequestId: "phone-turn-start-1",
    turnStartParams: {
      threadId: "thread-desktop-owned",
      input: [{ type: "input_text", text: "continue from phone" }],
      cwd: "/repo",
      model: "gpt-test",
    },
  });

  await waitFor(() => outbound.find((message) => message.id === "phone-turn-start-1"));
  assert.deepEqual(outbound.find((message) => message.id === "phone-turn-start-1"), {
    id: "phone-turn-start-1",
    result: { turn: { id: "turn-from-phone" } },
  });

  const routedRequests = [
    {
      id: "phone-steer-1",
      method: "turn/steer",
      params: {
        threadId: "thread-desktop-owned",
        input: [{ type: "input_text", text: "steer from phone" }],
        expectedTurnId: "turn-from-phone",
      },
      expectedMethod: "thread-follower-steer-turn",
      expectedParams: {
        conversationId: "thread-desktop-owned",
        input: [{ type: "input_text", text: "steer from phone" }],
        expectedTurnId: "turn-from-phone",
      },
    },
    {
      id: "phone-interrupt-1",
      method: "turn/interrupt",
      params: {
        threadId: "thread-desktop-owned",
        turnId: "turn-from-phone",
      },
      expectedMethod: "thread-follower-interrupt-turn",
      expectedParams: {
        conversationId: "thread-desktop-owned",
        turnId: "turn-from-phone",
      },
    },
    {
      id: "phone-compact-1",
      method: "thread/compact/start",
      params: {
        threadId: "thread-desktop-owned",
      },
      expectedMethod: "thread-follower-compact-thread",
      expectedParams: {
        conversationId: "thread-desktop-owned",
      },
    },
  ];

  for (const request of routedRequests) {
    const handledRoute = follower.observeInbound(JSON.stringify({
      id: request.id,
      method: request.method,
      params: request.params,
    }));
    assert.equal(handledRoute, true);
    await waitFor(() => serverFrames.find((frame) => frame.method === request.expectedMethod));
    const routedFrame = serverFrames.find((frame) => frame.method === request.expectedMethod);
    // Versions mirror Codex Desktop's bundled method map (interrupt is v2).
    assert.equal(
      routedFrame.version,
      request.expectedMethod === "thread-follower-interrupt-turn" ? 2 : 1
    );
    assert.deepEqual(routedFrame.params, request.expectedParams);
    await waitFor(() => outbound.find((message) => message.id === request.id));
    assert.deepEqual(outbound.find((message) => message.id === request.id), {
      id: request.id,
      result: { turn: { id: "turn-from-phone" } },
    });
  }
});

test("desktop IPC follower serves thread goal reads from Desktop state", async (t) => {
  const { tempDir, socketPath } = createIpcTestSocket("agnt-ipc-goal-read-");
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
    params: { threadId: "thread-desktop-goal" },
  }));
  await waitFor(() => serverSocket);
  writeFrame(serverSocket, {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 6,
    params: {
      conversationId: "thread-desktop-goal",
      change: {
        type: "snapshot",
        conversationState: {
          title: "Desktop Goal",
          threadGoal: {
            objective: "Finish the desktop-owned run",
            status: "paused",
            tokenBudget: 8000,
            tokensUsed: 2000,
            timeUsedSeconds: 120,
            createdAt: 10,
            updatedAt: 30,
          },
          turns: [],
          requests: [],
        },
      },
    },
  });
  await wait(25);

  const handled = follower.observeInbound(JSON.stringify({
    id: "phone-goal-get-1",
    method: "thread/goal/get",
    params: { threadId: "thread-desktop-goal" },
  }));

  assert.equal(handled, true);
  await waitFor(() => outbound.find((message) => message.id === "phone-goal-get-1"));
  assert.deepEqual(outbound.find((message) => message.id === "phone-goal-get-1"), {
    id: "phone-goal-get-1",
    result: {
      goal: {
        threadId: "thread-desktop-goal",
        objective: "Finish the desktop-owned run",
        status: "paused",
        tokenBudget: 8000,
        tokensUsed: 2000,
        timeUsedSeconds: 120,
        createdAt: 10,
        updatedAt: 30,
      },
    },
  });
});
