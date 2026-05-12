// FILE: contracts/application-message-router.test.js
// Purpose: Locks the dispatch contract for createApplicationMessageRouter.
//          The bridge depends on three guarantees: (1) stages run in array
//          order, (2) the first truthy return claims the message and stops
//          walking, (3) the fallback runs only when no stage claims.
// Layer: Unit test (contract)
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const { createApplicationMessageRouter } = require("../../src/bridge/application-message-router");

test("stages run in order until one returns truthy", () => {
  const calls = [];
  const fallback = () => calls.push("fallback");
  const route = createApplicationMessageRouter({
    stages: [
      () => { calls.push("a"); return false; },
      () => { calls.push("b"); return true; },
      () => { calls.push("c"); return true; },
    ],
    fallback,
  });

  route({ id: 1 });
  assert.deepEqual(calls, ["a", "b"]);
});

test("fallback runs only if no stage returns truthy", () => {
  const calls = [];
  const route = createApplicationMessageRouter({
    stages: [
      () => { calls.push("a"); return false; },
      () => { calls.push("b"); return false; },
    ],
    fallback: (msg) => { calls.push(["fallback", msg]); },
  });

  route({ id: 42 });
  assert.deepEqual(calls, ["a", "b", ["fallback", { id: 42 }]]);
});

test("stages receive the original message reference", () => {
  let received = null;
  const message = { method: "x" };
  const route = createApplicationMessageRouter({
    stages: [(msg) => { received = msg; return true; }],
    fallback: () => {},
  });
  route(message);
  assert.equal(received, message);
});

test("observation-only stages that return falsy do not stop dispatch", () => {
  const calls = [];
  const route = createApplicationMessageRouter({
    stages: [
      (msg) => { msg.observedA = true; return false; },
      (msg) => { msg.observedB = true; return false; },
      () => { calls.push("claimed"); return true; },
    ],
    fallback: () => calls.push("fallback"),
  });
  const msg = {};
  route(msg);
  assert.equal(msg.observedA, true);
  assert.equal(msg.observedB, true);
  assert.deepEqual(calls, ["claimed"]);
});

test("constructor rejects bad inputs eagerly", () => {
  assert.throws(() => createApplicationMessageRouter({ stages: null, fallback: () => {} }), TypeError);
  assert.throws(() => createApplicationMessageRouter({ stages: [], fallback: "not a fn" }), TypeError);
});
