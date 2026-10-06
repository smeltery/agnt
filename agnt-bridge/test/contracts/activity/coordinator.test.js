const assert = require("node:assert/strict");
const test = require("node:test");
const { createThreadActivityCoordinator } = require("../../../src/bridge/activity/coordinator");

function fixture(t) {
  const outbound = [];
  let locallyOwned = false;
  const activity = createThreadActivityCoordinator({
    sendApplicationResponse: (raw) => outbound.push(JSON.parse(raw)),
    isLocallyOwnedThread: () => locallyOwned,
  });
  t.after(() => activity.dispose());
  return { activity, outbound, acquire: () => { locallyOwned = true; }, snapshot() {
    activity.handleRequest(JSON.stringify({ id: "snapshot", method: "agnt/activity/subscribe", params: { schemaVersion: 1 } }));
    return outbound.at(-1).result;
  } };
}

test("activity retains Desktop ownership until a local writer acquires the thread", (t) => {
  const { activity, outbound, snapshot, acquire } = fixture(t);
  activity.observeDesktop({ type: "state", threadId: "task", sourceGeneration: 1,
    state: { title: "Desktop", turns: [{ turnId: "desktop-turn", status: "inProgress" }] } });
  activity.observe(JSON.stringify({ method: "thread/started", params: { thread: { id: "task", title: "Renamed", status: { type: "idle" } } } }));
  assert.equal(outbound.length, 0);
  let entry = snapshot().entries[0];
  assert.equal(entry.source, "desktop-ipc");
  assert.equal(entry.title, "Renamed");
  assert.equal(entry.runtime, "active");
  activity.observeDesktop({ type: "disconnected", sourceGeneration: 1 });
  entry = snapshot().entries[0];
  assert.equal(entry.freshness, "stale");
  assert.equal(entry.runtime, "active");
  acquire();
  activity.observe({ method: "turn/started", params: { threadId: "task", turn: { id: "local-turn", status: "inProgress" } } });
  assert.equal(snapshot().entries[0].source, "app-server");
});

test("relay reconnect drops activity subscriptions without discarding observed state", (t) => {
  const { activity, outbound, snapshot } = fixture(t);
  activity.observe({ method: "turn/started", params: { threadId: "task", turn: { id: "turn" } } });
  const initial = snapshot();
  activity.resetSubscriber();
  activity.observe({ method: "turn/completed", params: { threadId: "task", turn: { id: "turn", status: "completed" } } });
  assert.equal(outbound.length, 1);
  const resumed = snapshot();
  assert.equal(resumed.epoch, initial.epoch);
  assert.ok(resumed.revision > initial.revision);
  assert.equal(resumed.entries[0].lastOutcome.outcome, "completed");
});

test("activity requests are handled before provider routing for every provider", (t) => {
  const { createBridgeApplicationHandler } = require("../../../src/bridge/bridge-application-handler");
  for (const id of ["codex", "claude", "opencode", "cursor"]) {
    const { activity, outbound } = fixture(t);
    const route = createBridgeApplicationHandler({
      activeProvider: { id },
      handshakeHandler: { handlePhoneMessage: () => false },
      handleActivity: activity.handleRequest,
      handleFallbackMessage: () => assert.fail("activity must not reach an agent CLI"),
    });
    route(JSON.stringify({ id: 7, method: "agnt/activity/subscribe", params: { schemaVersion: 1 } }));
    assert.equal(outbound[0].id, 7);
    assert.deepEqual(outbound[0].result.entries, []);
  }
});
