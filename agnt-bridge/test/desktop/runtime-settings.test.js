const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyRuntimeSettingsToConversation, createThreadMutationQueue,
  runtimeSettingsPatch, runtimeSettingsFromConversation,
} = require("../../src/desktop/runtime/settings");
const { synchronizeDesktopConversationCompatibility } = require("../../src/desktop/conversation-adapter/conversation-compatibility");

test("runtime patch distinguishes inherit, Standard and selected tier, including legacy Fast", () => {
  assert.deepEqual(runtimeSettingsPatch({}), {});
  assert.deepEqual(runtimeSettingsPatch({ effort: null }), {});
  assert.deepEqual(runtimeSettingsPatch({ effort: null }, { authoritative: true }), { reasoningEffort: null });
  assert.deepEqual(runtimeSettingsPatch({ collaborationMode: { settings: { reasoning_effort: null } } }), { reasoningEffort: null });
  assert.deepEqual(runtimeSettingsPatch({ serviceTier: null, service_tier: "fast" }), { serviceTier: null });
  assert.deepEqual(runtimeSettingsPatch({ serviceTierForTurn: "default" }), {});
  assert.deepEqual(runtimeSettingsPatch({ serviceTier: null }), { serviceTier: null });
  assert.deepEqual(runtimeSettingsPatch({ serviceTier: "default" }), { serviceTier: null });
  assert.deepEqual(runtimeSettingsPatch({ serviceTier: "fast" }), { serviceTier: "priority" });
  assert.deepEqual(runtimeSettingsPatch({ serviceTier: "ultrafast" }), { serviceTier: "ultrafast" });
  assert.deepEqual(runtimeSettingsPatch({ effort: null, collaborationMode: { settings: { model: "gpt-6-astra", reasoning_effort: "ultra" } } }), { model: "gpt-6-astra", reasoningEffort: "ultra" });
});





test("next-turn Standard and Auto survive Desktop snapshot normalization without rewriting an active turn", () => {
  const conversation = { id: "task", turns: [{ id: "turn", status: "inProgress", params: { model: "gpt-5.5", effort: "high", serviceTier: "priority" }, items: [] }], latestThreadSettings: { model: "gpt-5.5", effort: "high", serviceTier: "priority" } };
  applyRuntimeSettingsToConversation(conversation, { model: "gpt-6-astra", effort: null, serviceTier: null }, { authoritative: true });
  synchronizeDesktopConversationCompatibility(conversation);
  assert.deepEqual(runtimeSettingsFromConversation(conversation), { model: "gpt-6-astra", reasoningEffort: null, serviceTier: null });
  assert.equal(conversation.turns[0].params.serviceTier, "priority");
  assert.equal(conversation.turns[0].params.effort, "high");
});





test("mutations serialize by task, continue after failure, and do not block other tasks", async () => {
  const enqueue = createThreadMutationQueue();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = enqueue("task", async () => { order.push("settings"); await gate; throw new Error("rejected"); });
  const rejection = assert.rejects(first, /rejected/);
  const second = enqueue("task", () => { order.push("turn"); });
  await enqueue("other", () => { order.push("other"); });
  assert.deepEqual(order, ["settings", "other"]);
  release();
  await Promise.all([rejection, second]);
  assert.deepEqual(order, ["settings", "other", "turn"]);
});
