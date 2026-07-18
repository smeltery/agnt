// FILE: desktop-ipc-action-follower-patch-recovery.test.js
// Purpose: Verifies Desktop IPC patch-only recovery behavior for pending actions.
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
