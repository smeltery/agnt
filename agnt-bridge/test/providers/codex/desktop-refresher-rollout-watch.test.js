// FILE: desktop-refresher-rollout-watch.test.js
// Purpose: Verifies rollout watcher retry behavior used by desktop refresh.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../../../src/desktop/rollout-watch

const test = require("node:test");
const assert = require("node:assert/strict");
const { createThreadRolloutActivityWatcher } = require("../../../src/desktop/rollout-watch");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("rollout watcher retries transient filesystem errors before succeeding", async () => {
  const events = [];
  const errors = [];
  let readdirCalls = 0;

  const watcher = createThreadRolloutActivityWatcher({
    threadId: "thread-watch-ok",
    intervalMs: 5,
    lookupTimeoutMs: 100,
    idleTimeoutMs: 100,
    transientErrorRetryLimit: 2,
    fsModule: {
      existsSync: () => true,
      readdirSync: () => {
        readdirCalls += 1;
        if (readdirCalls === 1) {
          const error = new Error("temporary missing dir");
          error.code = "ENOENT";
          throw error;
        }

        return [{
          name: "rollout-thread-watch-ok.jsonl",
          isDirectory: () => false,
          isFile: () => true,
        }];
      },
      statSync: () => ({ size: 12, mtimeMs: Date.now() }),
      openSync: () => 1,
      readSync: (_fd, buffer) => {
        buffer.write('{"x":1}\n', 0, "utf8");
        return 8;
      },
      closeSync: () => {},
    },
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
  });

  await wait(25);
  watcher.stop();

  assert.equal(errors.length, 0);
  assert.equal(events[0]?.reason, "materialized");
});

test("rollout watcher stops after repeated transient filesystem failures", async () => {
  const errors = [];
  let currentTime = 0;

  const watcher = createThreadRolloutActivityWatcher({
    threadId: "thread-watch-fail",
    intervalMs: 5,
    lookupTimeoutMs: 100,
    idleTimeoutMs: 100,
    transientErrorRetryLimit: 1,
    now: () => {
      currentTime += 5;
      return currentTime;
    },
    fsModule: {
      existsSync: () => true,
      readdirSync: () => {
        const error = new Error("still missing");
        error.code = "ENOENT";
        throw error;
      },
    },
    onError: (error) => errors.push(error),
  });

  await wait(25);
  watcher.stop();

  assert.equal(errors.length, 1);
});
