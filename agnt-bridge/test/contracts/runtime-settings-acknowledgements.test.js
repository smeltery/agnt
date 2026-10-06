const test = require("node:test");
const assert = require("node:assert/strict");
const { createFollowerRuntimeState } = require("../../src/desktop/desktop-ipc-live-owner-runtime");
const { createRuntimeSettingsHandler } = require("../../src/handlers/runtime-settings-handler");

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Desktop settings mutate mirror state only after runtime acknowledgement", async () => {
  let acknowledge;
  const calls = [];
  const conversation = { latestModel: "before" };
  const state = createFollowerRuntimeState({
    conversations: new Map([["task", conversation]]),
    followerRuntimeOverridesByThreadId: new Map(),
    scheduleSnapshot: () => calls.push("snapshot"),
    sendCodexRequest: async (method, params) => {
      calls.push([method, params]);
      await new Promise((resolve) => { acknowledge = resolve; });
    },
  });
  const edit = state.applyThreadSettings("task", { model: "after", serviceTier: null });
  await settle();
  assert.equal(conversation.latestModel, "before");
  assert.deepEqual(calls, [["thread/settings/update", { threadId: "task", model: "after", serviceTier: null }]]);
  acknowledge();
  await edit;
  assert.equal(conversation.latestModel, "after");
  assert.equal(conversation.latestServiceTier, null);
  assert.equal(calls.at(-1), "snapshot");
});

test("a failed settings edit preserves the prior mirror and explicit speed overrides", async () => {
  const conversation = { latestModel: "before" };
  const state = createFollowerRuntimeState({
    conversations: new Map([["task", conversation]]),
    followerRuntimeOverridesByThreadId: new Map([["task", { model: "before", serviceTier: "priority" }]]),
    scheduleSnapshot: () => assert.fail("failed update must not publish a snapshot"),
    sendCodexRequest: async () => { throw new Error("rejected"); },
  });
  await assert.rejects(state.applyModelAndReasoning("task", { model: "after" }), /rejected/);
  assert.equal(conversation.latestModel, "before");
  assert.equal(state.mergeOverrides("task", {}).serviceTier, "priority");
  assert.equal(state.mergeOverrides("task", { serviceTier: null }).serviceTier, null);
});

test("local settings handler rejects unknown ownership without contacting the runtime", async () => {
  const responses = [];
  const handler = createRuntimeSettingsHandler({
    getLiveOwner: () => ({ isThreadOwned: () => false }),
    getFollower: () => null,
    sendRequest: () => assert.fail("unknown owner must not acquire the task"),
    runtimeSettingsStore: {},
  });
  assert.equal(handler(JSON.stringify({ id: 1, method: "thread/settings/update", params: { threadId: "task", model: "model" } }), (raw) => responses.push(JSON.parse(raw))), true);
  await settle();
  assert.match(responses[0].error.message, /confirm this task's owner/);
});

test("local settings handler returns acknowledged canonical settings", async () => {
  const responses = [];
  const events = [];
  const handler = createRuntimeSettingsHandler({
    getLiveOwner: () => null,
    getFollower: () => null,
    sendRequest: async (method, params) => events.push([method, params]),
    runtimeSettingsStore: { commit: (_threadId, settings) => { events.push("commit"); return settings; } },
  });
  handler(JSON.stringify({ id: 2, method: "thread/settings/update", params: { threadId: "task", serviceTier: "fast", unknown: true } }), (raw) => responses.push(JSON.parse(raw)));
  await settle();
  assert.deepEqual(events, [["thread/settings/update", { threadId: "task", serviceTier: "priority" }], "commit"]);
  assert.deepEqual(responses[0].result.runtimeSettings, { serviceTier: "priority" });
});
