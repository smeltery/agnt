// FILE: desktop-ipc-action-follower-test-helpers.js
// Purpose: Shared frame/socket helpers for desktop IPC action follower tests.
// Layer: Test support
// Exports: frame encoding, socket setup, and conversation fixture helpers
// Depends on: node:assert/strict, node:fs, node:os, node:path, node:timers/promises

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");

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
  socket.write(encodeFrame(payload));
}

function emitFrame(socket, payload) {
  socket.emit("data", encodeFrame(payload));
}

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function parseFrameBuffer(buffer) {
  const frameLength = buffer.readUInt32LE(0);
  return JSON.parse(buffer.slice(4, 4 + frameLength).toString("utf8"));
}

async function waitFor(predicate, timeoutMs = 500) {
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

function desktopConversationSnapshot(threadId, conversationState) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 11,
    params: {
      conversationId: threadId,
      change: {
        type: "snapshot",
        conversationState,
      },
    },
  };
}

function normalizedConversationState(turns, overrides = {}) {
  const entitiesByKey = {};
  const entries = [];
  for (const turn of turns) {
    const entityKey = `turn:${turn.id}`;
    entries.push({ key: entityKey, value: entityKey });
    entitiesByKey[entityKey] = {
      id: turn.id,
      turnId: turn.id,
      status: turn.status,
      ...(turn.input ? { params: { input: turn.input } } : {}),
      items: turn.items || [{
        id: turn.itemId || `assistant-${turn.id}`,
        type: "assistant_message",
        text: turn.text,
      }],
    };
  }
  return {
    turns: turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      items: entitiesByKey[`turn:${turn.id}`].items,
    })),
    requests: [],
    ...overrides,
    turnHistory: {
      history: {
        entitiesByKey,
        islands: [{ entries }],
      },
    },
  };
}

function useProcessPlatform(t, platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    ...descriptor,
    value: platform,
  });
  t.after(() => {
    Object.defineProperty(process, "platform", descriptor);
  });
}

module.exports = {
  attachFrameReader,
  writeFrame,
  emitFrame,
  parseFrameBuffer,
  waitFor,
  createIpcTestSocket,
  desktopConversationSnapshot,
  normalizedConversationState,
  useProcessPlatform,
};
