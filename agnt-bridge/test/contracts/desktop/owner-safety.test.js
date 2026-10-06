const assert = require("node:assert/strict");
const test = require("node:test");
const { buildThreadReadStateContext } = require("../../../src/desktop/live-owner/read-state-context");
const { createLiveOwnerThreadState } = require("../../../src/desktop/live-owner/thread-state");
const { createLiveOwnerFollowerRequestHandler } = require("../../../src/desktop/live-owner/follower-requests");
const { normalizeDesktopItemCompatibility, normalizeDesktopInputEntries } = require("../../../src/desktop/conversation-adapter/item-normalization");

test("Desktop input normalization preserves whitespace and byte-offset spans", () => {
  const spans = [{ start: 0, end: 3, placeholder: "file" }];
  const input = [{ type: "text", text: "  text\n", text_elements: spans }, { type: "text", text: "next" }];
  const normalized = normalizeDesktopInputEntries(input);
  assert.deepEqual(normalized[0], input[0]);
  assert.deepEqual(normalized[1].text_elements, []);
  assert.equal(input[1].text_elements, undefined);
  for (const [type, key] of [["userMessage", "content"], ["steeringUserMessage", "input"]]) {
    assert.deepEqual(normalizeDesktopItemCompatibility({ type, [key]: input })[key], normalized);
  }
});

test("Desktop read receipts contain scoped identity without bearer tokens", () => {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "account", user_id: "user" } };
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const context = buildThreadReadStateContext({ authMethod: "chatgpt", authToken: token });
  assert.deepEqual(context.identity, { kind: "chatgpt", accountId: "account", userId: "user" });
  assert.match(context.executionHostKey, /^local:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(context).includes(token), false);
  assert.equal(buildThreadReadStateContext({ authMethod: "chatgpt", authToken: "invalid" }), null);
  assert.equal(buildThreadReadStateContext({ authMethod: null, requiresOpenaiAuth: true }), null);
  assert.equal(buildThreadReadStateContext({ authMethod: "apikey" }, "remote"), null);
});

test("read receipt identity lookup is coalesced and cannot clear newly unread work", async () => {
  const pending = new Map();
  const announced = new Set();
  const conversation = { hasUnreadTurn: true, unreadMessageCount: 1 };
  const broadcasts = [];
  const replies = [];
  const state = createLiveOwnerThreadState({
    hostId: "local", ownedThreadIds: new Set(["task"]),
    conversations: new Map([["task", conversation]]),
    announcedReadStateThreadIds: announced, pendingReadStateByThreadId: pending,
    scheduleSnapshot() {},
    sendCodexRequest: (method, params) => {
      assert.equal(method, "getAuthStatus");
      assert.deepEqual(params, { includeToken: true, refreshToken: false });
      return new Promise((resolve) => replies.push(resolve));
    },
    ipc: { sendBroadcast: (method, params) => { broadcasts.push({ method, params }); return true; } },
  });
  state.markThreadReadByPhone("task");
  state.markThreadReadByPhone("task");
  await new Promise(setImmediate);
  assert.equal(replies.length, 1);
  conversation.hasUnreadTurn = true;
  replies[0]({ authMethod: "apikey" });
  await new Promise(setImmediate);
  assert.equal(broadcasts.length, 0);
  state.markThreadReadByPhone("task");
  await new Promise(setImmediate);
  replies[1]({ authMethod: "apikey" });
  await new Promise(setImmediate);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].params.hostId, "local");
  assert.equal(broadcasts[0].params.context.identity.kind, "execution-storage");
  assert.ok(announced.has("task"));
});

test("Desktop owner discovery validates host and rejects unsupported application context", async () => {
  const handler = createLiveOwnerFollowerRequestHandler({
    hostId: "local", ownedThreadIds: new Set(["task"]),
    followerRuntimeState: { enqueueMutation: (_id, operation) => operation() },
    sendCodexRequest: () => assert.fail("unsupported input must never reach runtime"),
  });
  const request = (hostId) => ({ method: "thread-owner-discovery", params: { conversationId: "task", hostId } });
  assert.equal(handler.canHandleFollowerRequest(request()), false);
  assert.equal(handler.canHandleFollowerRequest(request("remote")), false);
  assert.equal(handler.canHandleFollowerRequest(request("local")), true);
  assert.deepEqual(await handler.handleFollowerRequest(request("local")), { supportsUntrustedAppInput: false });
  await assert.rejects(handler.handleFollowerRequest(request("remote")), /conversation-not-owned/);
  await assert.rejects(handler.handleFollowerRequest({ method: "thread-follower-start-turn", params: {
    conversationId: "task", hostId: "local", turnStart: { context: { responseItems: [{ type: "message" }] } },
  } }), /Untrusted application input/);
});
