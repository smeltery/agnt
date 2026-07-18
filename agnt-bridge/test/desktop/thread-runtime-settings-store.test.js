// FILE: thread-runtime-settings-store.test.js
// Purpose: Unit tests for persisted phone runtime settings.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, fs, os, path, ../../src/desktop/thread-runtime-settings-store

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createThreadRuntimeSettingsStore,
  runtimeSettingsFromTurnParams,
} = require("../../src/desktop/thread-runtime-settings-store");

function tempStoreFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agnt-runtime-settings-")), "state.json");
}

test("runtimeSettingsFromTurnParams preserves previous values when turn omits them", () => {
  assert.deepEqual(
    runtimeSettingsFromTurnParams({
      collaborationMode: { settings: { model: "gpt-5.1", reasoning_effort: "high" } },
      serviceTier: "fast",
    }),
    { model: "gpt-5.1", reasoningEffort: "high", serviceTier: "fast" }
  );

  assert.deepEqual(
    runtimeSettingsFromTurnParams({ serviceTier: "normal" }, {
      model: "gpt-5",
      reasoningEffort: "medium",
    }),
    { model: "gpt-5", reasoningEffort: "medium", serviceTier: "normal" }
  );
});

test("store persists phone settings and attaches them to conversation state", () => {
  const storeFile = tempStoreFile();
  const store = createThreadRuntimeSettingsStore({ storeFile, now: () => 1000 });

  const first = store.commit("thread-a", {
    model: "gpt-5.1",
    effort: "high",
    serviceTier: "fast",
  }, { source: "phone", turnId: "turn-a" });

  assert.deepEqual(first, {
    model: "gpt-5.1",
    reasoningEffort: "high",
    serviceTier: "fast",
    revision: 1,
    updatedAt: 1000,
    source: "phone",
    turnId: "turn-a",
  });

  const restored = createThreadRuntimeSettingsStore({ storeFile, now: () => 2000 });
  const conversation = { latestModel: "fallback", latestThreadSettings: { personality: "direct" } };
  restored.attachToConversation("thread-a", conversation);

  assert.equal(conversation.latestModel, "gpt-5.1");
  assert.equal(conversation.latestReasoningEffort, "high");
  assert.equal(conversation.latestServiceTier, "fast");
  assert.deepEqual(conversation.latestThreadSettings, {
    personality: "direct",
    model: "gpt-5.1",
    effort: "high",
    serviceTier: "fast",
  });
  assert.equal(conversation.agntRuntimeSettings.revision, 1);
});

test("store enriches thread responses with persisted runtime metadata", () => {
  const store = createThreadRuntimeSettingsStore({ storeFile: tempStoreFile(), now: () => 1234 });
  store.commit("thread-list-a", {
    model: "gpt-5.2",
    effort: "medium",
    serviceTier: "fast",
  }, { source: "phone", turnId: "turn-list" });

  const envelope = {
    result: {
      data: [
        { id: "thread-list-a", model: "fallback" },
        { id: "thread-list-b", model: "other" },
      ],
    },
  };
  store.enrichResponse("thread/list", envelope);

  assert.deepEqual(envelope.result.data[0], {
    id: "thread-list-a",
    model: "gpt-5.2",
    reasoningEffort: "medium",
    serviceTier: "fast",
    runtimeSettingsRevision: 1,
    runtimeSettingsUpdatedAt: 1234,
    runtimeSettingsSource: "phone",
  });
  assert.deepEqual(envelope.result.data[1], { id: "thread-list-b", model: "other" });
});

test("store ignores desktop-origin settings and drops legacy desktop records", () => {
  const storeFile = tempStoreFile();
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify({
    version: 1,
    threads: {
      "thread-desktop": {
        model: "desktop-model",
        reasoningEffort: "high",
        source: "desktop",
        revision: 1,
        updatedAt: 100,
      },
    },
  }));

  const store = createThreadRuntimeSettingsStore({ storeFile, now: () => 200 });
  assert.equal(store.get("thread-desktop"), null);
  assert.equal(store.commit("thread-desktop", { model: "desktop-next" }, { source: "desktop" }), null);
  assert.equal(store.get("thread-desktop"), null);
});
