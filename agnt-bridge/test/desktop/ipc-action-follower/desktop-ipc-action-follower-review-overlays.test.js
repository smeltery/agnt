// FILE: desktop-ipc-action-follower-review-overlays.test.js
// Purpose: Verifies Desktop IPC guardian auto-approval-review overlays drain from
//   normalized-only history into item/autoApprovalReview/* notifications.
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
  desktopConversationSnapshot,
  normalizedConversationState,
} = require("../desktop-ipc-action-follower-test-helpers");

const {
  createDesktopIpcActionFollower,
} = require("../../../src/desktop/desktop-ipc-action-follower");

function startServer(t, prefix) {
  const { tempDir, socketPath } = createIpcTestSocket(prefix);
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
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      t.after(() => {
        server.close();
        serverSocket?.destroy();
        fs.rmSync(tempDir, { recursive: true, force: true });
      });
      resolve({ socketPath, getServerSocket: () => serverSocket });
    });
  });
}

function reviewItem({
  id,
  reviewId,
  status,
  targetItemId = "command-review",
  startedAtMs = 100,
  completedAtMs = null,
  riskLevel = null,
  decisionSource = null,
  command = "pwd",
}) {
  return {
    id: id || `automatic-approval-review:${reviewId}`,
    type: "automaticApprovalReview",
    reviewId,
    targetItemId,
    startedAtMs,
    completedAtMs,
    review: { status, riskLevel },
    ...(decisionSource ? { event: { decision_source: decisionSource } } : {}),
    action: { type: "command", source: "shell", command, cwd: "/tmp" },
  };
}

test("desktop IPC follower delivers normalized guardian reviews when an idle background thread is opened", async (t) => {
  const { socketPath, getServerSocket } = await startServer(t, "agnt-ipc-review-overlay-bg-open-");
  const outbound = [];
  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  const threadId = "thread-review-overlay-bg-open";

  // Sidebar refresh connects the Desktop bus without opening any thread, so the
  // snapshot below lands while the thread is still background-only.
  follower.observeInbound(JSON.stringify({ method: "thread/list", params: {} }));
  await waitFor(() => getServerSocket());
  writeFrame(getServerSocket(), desktopConversationSnapshot(
    threadId,
    normalizedConversationState([{
      id: "turn-review-overlay-bg-open",
      status: "completed",
      items: [reviewItem({
        reviewId: "review-bg-open",
        status: "denied",
        riskLevel: "high",
        decisionSource: "agent",
        command: "rm -rf build",
        completedAtMs: 200,
      })],
    }], {
      turns: [],
      threadRuntimeStatus: { type: "idle", activeFlags: [] },
    })
  ));
  await wait(100);
  assert.equal(
    outbound.some((message) => message.method?.startsWith("item/autoApprovalReview/")),
    false,
    "background-only threads must not stream review rows before the phone opens them"
  );

  follower.observeInbound(JSON.stringify({
    id: "open-review-overlay-bg-open",
    method: "thread/read",
    params: { threadId },
  }));
  await waitFor(() => outbound.some((message) => message.method === "item/autoApprovalReview/completed"));

  assert.equal(
    outbound.some((message) => message.method === "thread/replaced"),
    true,
    "opening a canonical-history background thread announces a replacement"
  );
  const notification = outbound.find((message) => message.method === "item/autoApprovalReview/completed");
  assert.equal(notification.params.threadId, threadId);
  assert.equal(notification.params.turnId, "turn-review-overlay-bg-open");
  assert.equal(notification.params.reviewId, "review-bg-open");
  assert.equal(notification.params.targetItemId, "command-review");
  assert.equal(notification.params.completedAtMs, 200);
  assert.equal(notification.params.review.status, "denied");
  assert.equal(notification.params.decisionSource, "agent", "overlay decisionSource falls back to event.decision_source");
  assert.equal(notification.params.action.command, "rm -rf build");
  assert.equal(notification.params.agntDesktopMirror, true);
  assert.equal(notification.params.agntDesktopIpcMirror, true);
  assert.equal(notification.params.agntGuardianRetrySupported, false);
});

test("desktop IPC follower filters detached approved reviews outside the projected tail on background open", async (t) => {
  const { socketPath, getServerSocket } = await startServer(t, "agnt-ipc-review-overlay-detached-");
  const outbound = [];
  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  const threadId = "thread-review-overlay-detached";

  follower.observeInbound(JSON.stringify({ method: "thread/list", params: {} }));
  await waitFor(() => getServerSocket());
  writeFrame(getServerSocket(), desktopConversationSnapshot(
    threadId,
    normalizedConversationState([
      {
        id: "turn-review-overlay-older",
        status: "completed",
        items: [reviewItem({
          reviewId: "review-older-approved",
          status: "approved",
          riskLevel: "low",
          completedAtMs: 75,
        })],
      },
      {
        id: "turn-review-overlay-newer",
        status: "completed",
        items: [reviewItem({
          reviewId: "review-newer-denied",
          status: "denied",
          riskLevel: "high",
          completedAtMs: 200,
        })],
      },
    ], {
      turns: [],
      threadRuntimeStatus: { type: "idle", activeFlags: [] },
    })
  ));
  await wait(100);

  follower.observeInbound(JSON.stringify({
    id: "open-review-overlay-detached",
    method: "thread/read",
    params: { threadId },
  }));
  await waitFor(() => outbound.some((message) => message.method === "item/autoApprovalReview/completed"));

  assert.equal(
    outbound.some((message) => message.params?.reviewId === "review-older-approved"),
    false,
    "an approved review whose turn fell outside the projected tail must not replay as a detached row"
  );
  const denied = outbound.find((message) => message.params?.reviewId === "review-newer-denied");
  assert.ok(denied, "the newer denied review on the projected tail still delivers");
  assert.equal(denied.method, "item/autoApprovalReview/completed");
  assert.equal(denied.params.turnId, "turn-review-overlay-newer");
});

test("desktop IPC follower mirrors normalized guardian review lifecycle for an already-open thread", async (t) => {
  const { socketPath, getServerSocket } = await startServer(t, "agnt-ipc-review-overlay-open-");
  const outbound = [];
  const follower = createDesktopIpcActionFollower({
    socketPath,
    sendApplicationResponse(message) {
      outbound.push(JSON.parse(message));
    },
    requestTimeoutMs: 500,
  });
  t.after(() => follower.stopAll());

  const threadId = "thread-review-overlay-open";
  const turnKey = "turn:turn-review-overlay-live";

  follower.observeInbound(JSON.stringify({ method: "thread/resume", params: { threadId } }));
  await waitFor(() => getServerSocket());

  writeFrame(getServerSocket(), desktopConversationSnapshot(
    threadId,
    normalizedConversationState([{
      id: "turn-review-overlay-live",
      status: "inProgress",
      items: [reviewItem({ reviewId: "review-live", status: "inProgress" })],
    }], {
      turns: [],
      threadRuntimeStatus: { type: "active", activeFlags: [] },
    })
  ));
  await waitFor(() => outbound.some((message) => message.method === "item/autoApprovalReview/started"));
  assert.equal(
    outbound.filter((message) => message.method?.startsWith("item/autoApprovalReview/")).length,
    1
  );
  outbound.length = 0;

  writeFrame(getServerSocket(), {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop",
    version: 11,
    params: {
      conversationId: threadId,
      change: {
        type: "patches",
        patches: [
          {
            op: "replace",
            path: ["turnHistory", "history", "entitiesByKey", turnKey, "items", 0, "review", "status"],
            value: "denied",
          },
          {
            op: "replace",
            path: ["turnHistory", "history", "entitiesByKey", turnKey, "items", 0, "completedAtMs"],
            value: 250,
          },
        ],
      },
    },
  });
  await waitFor(() => outbound.some((message) => message.method === "item/autoApprovalReview/completed"));
  const completed = outbound.find((message) => message.method === "item/autoApprovalReview/completed");
  assert.equal(completed.params.reviewId, "review-live");
  assert.equal(completed.params.completedAtMs, 250);
  assert.equal(completed.params.review.status, "denied");
  outbound.length = 0;

  // Resending the same (now unchanged) snapshot must not re-emit the review;
  // the per-thread fingerprint cache dedupes it across projection syncs.
  writeFrame(getServerSocket(), desktopConversationSnapshot(
    threadId,
    normalizedConversationState([{
      id: "turn-review-overlay-live",
      status: "inProgress",
      items: [reviewItem({
        reviewId: "review-live",
        status: "denied",
        completedAtMs: 250,
      })],
    }], {
      turns: [],
      threadRuntimeStatus: { type: "active", activeFlags: [] },
    })
  ));
  await wait(75);
  assert.equal(
    outbound.some((message) => message.method?.startsWith("item/autoApprovalReview/")),
    false,
    "an unchanged review must not be replayed on a later full snapshot"
  );
});
