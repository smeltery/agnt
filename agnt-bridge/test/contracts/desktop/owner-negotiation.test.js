const assert = require("node:assert/strict");
const test = require("node:test");
const { createOwnerNegotiation } = require("../../../src/desktop/action-follower/owner-negotiation");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const resume = { id: 1, method: "thread/resume", params: { threadId: "task", excludeTurns: true } };
const mutation = { id: 2, method: "turn/start", params: { threadId: "task" } };
function setup(overrides = {}) {
  const sent = [], calls = [], forwarded = [];
  const runtime = createOwnerNegotiation({
    ipc: { clientId: "bridge", async sendRequest(method, params, options) {
      calls.push({ method, params, options });
      return method === "thread-owner-discovery" ? { handledByClientId: "desktop" } : { revision: 1 };
    } },
    readThreadMetadata: async () => ({ thread: { id: "task" } }),
    resumeThreadLocally: async () => { throw new Error("Must not acquire a Desktop task"); },
    hasDesktopState: () => false, isLocallyOwnedThread: () => false,
    releaseDesktopThreadState() {}, sendApplicationResponse: (raw) => sent.push(JSON.parse(raw)),
    dispatch: (raw) => forwarded.push(JSON.parse(raw)), ...overrides,
  });
  return { runtime, calls, sent, forwarded };
}

test("resume confirms the discovery claimant with a targeted read before releasing mutations", async () => {
  const { runtime, calls, sent, forwarded } = setup();
  assert.equal(runtime.handle(resume, JSON.stringify(resume), false), true);
  assert.equal(runtime.handle(mutation, JSON.stringify(mutation), true), true);
  assert.equal(forwarded.length, 0);
  await tick();
  assert.deepEqual(calls.map((call) => call.method), ["thread-owner-discovery", "thread-follower-load-complete-history"]);
  assert.equal(calls[1].options.targetClientId, "desktop");
  assert.equal(calls[0].params.hostId, "local");
  assert.equal(sent[0].result.agntDesktopIpcMirror, true);
  assert.equal(forwarded.length, 1);
  assert.equal(runtime.targetClientId("task"), "desktop");
});

test("stale Desktop discovery can yield to a successful local resume", async () => {
  let resumed = 0, released = 0;
  const { runtime, sent } = setup({
    ipc: { clientId: "bridge", sendRequest: async () => { throw new Error("no owner"); } },
    resumeThreadLocally: async () => { resumed += 1; return { thread: { id: "task" } }; },
    releaseDesktopThreadState: () => { released += 1; },
  });
  runtime.handle(resume, JSON.stringify(resume), false); await tick();
  assert.equal(resumed, 1); assert.equal(released, 1);
  assert.equal(sent[0].result.thread.id, "task");
  assert.equal(sent[0].result.agntDesktopIpcMirror, undefined);
});

test("unavailable active writers reject held and later mutations instead of replaying locally", async () => {
  const { runtime, sent, forwarded } = setup({
    ipc: { clientId: "bridge", sendRequest: async () => { throw new Error("offline"); } },
    resumeThreadLocally: async () => { throw Object.assign(new Error("already has a writer"), { code: -32600 }); },
  });
  runtime.handle(resume, JSON.stringify(resume), false);
  runtime.handle(mutation, JSON.stringify(mutation), true); await tick();
  runtime.handle({ ...mutation, id: 3 }, JSON.stringify(mutation), true);
  assert.equal(forwarded.length, 0);
  assert.equal(sent.filter((response) => response.error).length, 3);
  assert.match(sent.find((response) => response.id === 1).error.message, /active writer/);
});

test("disconnect invalidates an in-flight confirmation without claiming the old client", async () => {
  let complete;
  const { runtime, sent, forwarded } = setup({ ipc: { clientId: "bridge", sendRequest: async (method) => {
    if (method === "thread-owner-discovery") return { handledByClientId: "old-client" };
    return new Promise((resolve) => { complete = resolve; });
  } } });
  runtime.handle(resume, JSON.stringify(resume), false); await tick();
  runtime.handle(mutation, JSON.stringify(mutation), true);
  runtime.reset(); complete({ revision: 3 }); await tick();
  assert.equal(runtime.hasOwner("task"), false);
  assert.equal(sent.length, 0); assert.equal(forwarded.length, 0);
});

test("turn-state probes use normalized live state while transcript paging stays canonical", () => {
  const { createDesktopReadServer } = require("../../../src/desktop/action-follower/read-serving");
  const { normalizedConversationState } = require("../../desktop/desktop-ipc-action-follower-test-helpers");
  const sent = [];
  const reader = createDesktopReadServer({
    activeThreads: { remember() {} }, canonicalHistoryThreadIds: new Set(),
    isLocallyOwnedThread: () => false, liveOwnerThreadIds: new Set(), now: () => 100,
    rawStateUpdatedAtByThreadId: new Map([["task", 100]]),
    rawStatesByThreadId: new Map([["task", normalizedConversationState([
      { id: "older", status: "completed", items: [] }, { id: "active", status: "inProgress", items: [] },
    ], { turns: [] })]]),
    sendApplicationResponse: (raw) => sent.push(JSON.parse(raw)), staleActiveReadMaxAgeMs: 20_000,
    staleYieldedThreadIds: new Set(), stateReadMethods: new Set(["thread/turns/list"]),
  });
  const message = { id: 1, method: "thread/turns/list", params: { threadId: "task", agntTurnStateOnly: true } };
  assert.equal(reader.tryServeDesktopOwnedRead(message), true);
  assert.equal(sent[0].result.agntDesktopLiveState, true);
  assert.ok(sent[0].result.data.some((turn) => turn.id === "active" && turn.status === "inProgress"));
  assert.equal(reader.tryServeDesktopOwnedRead({ ...message, params: { ...message.params, agntRequireCanonical: true } }), false);
});
