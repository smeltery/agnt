// FILE: contracts/context-usage-watcher.test.js
// Purpose: Pins the keyed-replace semantics of the per-thread rollout watcher
//          so the bridge keeps surfacing live context-window usage as turns
//          progress, and never lets a stale watcher tear down its successor.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWatcherKey,
  createContextUsageWatcher,
} = require("../../src/context-usage-watcher");

function makeFakeWatcherFactory() {
  const created = [];
  function factory(opts) {
    let stopped = false;
    const watcher = {
      opts,
      stop() { stopped = true; watcher.stopped = true; },
      get stopped() { return stopped; },
    };
    Object.defineProperty(watcher, "stopped", { get() { return stopped; }, configurable: true });
    created.push(watcher);
    return watcher;
  }
  return { factory, created };
}

test("buildWatcherKey distinguishes thread/turn pairs and defaults a missing turn", () => {
  assert.equal(buildWatcherKey("thr_a", "turn_1"), "thr_a|turn_1");
  assert.equal(buildWatcherKey("thr_a", ""), "thr_a|pending-turn");
  assert.notEqual(
    buildWatcherKey("thr_a", "turn_1"),
    buildWatcherKey("thr_a", "turn_2"),
  );
});

test("ensure() with the same (thread, turn) tuple does NOT churn the file handle", () => {
  const out = [];
  const { factory, created } = makeFakeWatcherFactory();
  const watcher = createContextUsageWatcher({
    sendApplicationResponse: (line) => out.push(line),
    createWatcher: factory,
  });

  watcher.ensure({ threadId: "thr_x", turnId: "turn_1" });
  watcher.ensure({ threadId: "thr_x", turnId: "turn_1" });
  assert.equal(created.length, 1, "second ensure() with the same key must not spawn a new watcher");
  assert.equal(watcher.isWatching(), true);
});

test("ensure() with a new turnId replaces the prior watcher (stop + create)", () => {
  const { factory, created } = makeFakeWatcherFactory();
  const watcher = createContextUsageWatcher({
    sendApplicationResponse: () => {},
    createWatcher: factory,
  });

  watcher.ensure({ threadId: "thr_x", turnId: "turn_1" });
  watcher.ensure({ threadId: "thr_x", turnId: "turn_2" });
  assert.equal(created.length, 2);
  assert.equal(created[0].stopped, true, "prior watcher must be stopped on replace");
  assert.equal(created[1].stopped, false);
});

test("ensure() with no threadId is a no-op", () => {
  const { factory, created } = makeFakeWatcherFactory();
  const watcher = createContextUsageWatcher({
    sendApplicationResponse: () => {},
    createWatcher: factory,
  });

  watcher.ensure({ threadId: "", turnId: "turn_1" });
  watcher.ensure({});
  watcher.ensure();
  assert.equal(created.length, 0);
  assert.equal(watcher.isWatching(), false);
});

test("onUsage forwards a thread/tokenUsage/updated notification", () => {
  const out = [];
  const { factory, created } = makeFakeWatcherFactory();
  const watcher = createContextUsageWatcher({
    sendApplicationResponse: (line) => out.push(line),
    createWatcher: factory,
  });

  watcher.ensure({ threadId: "thr_x", turnId: "turn_1" });
  created[0].opts.onUsage({ threadId: "thr_x", usage: { input: 100, output: 50 } });
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0]), {
    method: "thread/tokenUsage/updated",
    params: { threadId: "thr_x", usage: { input: 100, output: 50 } },
  });
});

test("onUsage drops frames with no threadId or no usage payload", () => {
  const out = [];
  const { factory, created } = makeFakeWatcherFactory();
  const watcher = createContextUsageWatcher({
    sendApplicationResponse: (line) => out.push(line),
    createWatcher: factory,
  });

  watcher.ensure({ threadId: "thr_x", turnId: "turn_1" });
  created[0].opts.onUsage({ threadId: "", usage: { input: 1 } });
  created[0].opts.onUsage({ threadId: "thr_x", usage: null });
  assert.equal(out.length, 0);
});

test("onIdle / onTimeout / onError stop the active watcher", () => {
  for (const lifecycle of ["onIdle", "onTimeout", "onError"]) {
    const { factory, created } = makeFakeWatcherFactory();
    const watcher = createContextUsageWatcher({
      sendApplicationResponse: () => {},
      createWatcher: factory,
    });

    watcher.ensure({ threadId: "thr_x", turnId: "turn_1" });
    assert.equal(watcher.isWatching(), true, `[${lifecycle}] precondition`);
    created[0].opts[lifecycle]();
    assert.equal(watcher.isWatching(), false, `[${lifecycle}] should stop the watcher`);
  }
});

test("lifecycle callbacks from a STALE watcher do not tear down its successor", () => {
  // This is the keyed-replace invariant: when ensure() replaces a watcher
  // mid-flight, the prior watcher's late onIdle/onTimeout/onError callbacks
  // must not stop the successor. Otherwise a quick turn-1 idle could cancel
  // turn-2's tracking.
  const { factory, created } = makeFakeWatcherFactory();
  const watcher = createContextUsageWatcher({
    sendApplicationResponse: () => {},
    createWatcher: factory,
  });

  watcher.ensure({ threadId: "thr_x", turnId: "turn_1" });
  const turn1 = created[0];
  watcher.ensure({ threadId: "thr_x", turnId: "turn_2" });
  assert.equal(watcher.isWatching(), true);
  // Stale callback from the replaced watcher fires AFTER the new watcher started.
  turn1.opts.onIdle();
  assert.equal(watcher.isWatching(), true, "successor must survive a stale onIdle");
  turn1.opts.onError();
  assert.equal(watcher.isWatching(), true, "successor must survive a stale onError");
  turn1.opts.onTimeout();
  assert.equal(watcher.isWatching(), true, "successor must survive a stale onTimeout");
});

test("stop() is idempotent and clears the active watcher", () => {
  const { factory, created } = makeFakeWatcherFactory();
  const watcher = createContextUsageWatcher({
    sendApplicationResponse: () => {},
    createWatcher: factory,
  });

  watcher.ensure({ threadId: "thr_x", turnId: "turn_1" });
  watcher.stop();
  assert.equal(watcher.isWatching(), false);
  assert.equal(created[0].stopped, true);
  // Repeated stop() must not throw.
  watcher.stop();
  assert.equal(watcher.isWatching(), false);
});
