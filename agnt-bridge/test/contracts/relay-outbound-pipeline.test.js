// FILE: contracts/relay-outbound-pipeline.test.js
// Purpose: Locks the phase contract for createRelayOutboundPipeline.
//          bridge.js relies on four guarantees: (1) shortCircuit runs first
//          and skips the rest when truthy, (2) observers run in array order
//          on the raw message after a non-short-circuit, (3) sanitize maps
//          raw->wire (or drops by returning null), (4) forward fires only
//          when sanitize returns a non-null payload.
// Layer: Unit test (contract)
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRelayOutboundPipeline } = require("../../src/bridge/relay-outbound-pipeline");

function build(overrides = {}) {
  const calls = [];
  const defaults = {
    shortCircuit: () => false,
    observers: [],
    sanitize: (msg) => JSON.stringify(msg),
    forward: (payload) => calls.push(["forward", payload]),
  };
  const dispatch = createRelayOutboundPipeline({ ...defaults, ...overrides });
  return { dispatch, calls };
}

test("shortCircuit truthy skips observers, sanitize, and forward", () => {
  const seen = [];
  const dispatch = createRelayOutboundPipeline({
    shortCircuit: (msg) => { seen.push(["short", msg]); return true; },
    observers: [() => seen.push(["observer"])],
    sanitize: () => { seen.push(["sanitize"]); return "x"; },
    forward: () => seen.push(["forward"]),
  });
  dispatch({ id: 1 });
  assert.deepEqual(seen, [["short", { id: 1 }]]);
});

test("observers run in array order on the raw message before sanitize", () => {
  const seen = [];
  const dispatch = createRelayOutboundPipeline({
    shortCircuit: () => false,
    observers: [
      (msg) => seen.push(["a", msg]),
      (msg) => seen.push(["b", msg]),
      (msg) => seen.push(["c", msg]),
    ],
    sanitize: (msg) => { seen.push(["sanitize", msg]); return "wire"; },
    forward: (payload) => seen.push(["forward", payload]),
  });
  dispatch({ method: "x" });
  assert.deepEqual(seen, [
    ["a", { method: "x" }],
    ["b", { method: "x" }],
    ["c", { method: "x" }],
    ["sanitize", { method: "x" }],
    ["forward", "wire"],
  ]);
});

test("sanitize returning null drops the message — forward is not called", () => {
  const seen = [];
  const dispatch = createRelayOutboundPipeline({
    shortCircuit: () => false,
    observers: [(msg) => seen.push(["observer", msg])],
    sanitize: () => null,
    forward: () => seen.push(["forward"]),
  });
  dispatch({ id: 7 });
  // Observers still ran even though forward was skipped — they're
  // tracking side-effects, not gating on relay delivery.
  assert.deepEqual(seen, [["observer", { id: 7 }]]);
});

test("forward receives the sanitize return value, not the raw message", () => {
  const { dispatch, calls } = build({
    sanitize: () => "TRANSFORMED",
  });
  dispatch({ id: "raw" });
  assert.deepEqual(calls, [["forward", "TRANSFORMED"]]);
});

test("constructor rejects bad inputs eagerly", () => {
  assert.throws(() => createRelayOutboundPipeline({}), TypeError);
  assert.throws(() => createRelayOutboundPipeline({
    shortCircuit: () => false,
    observers: "not-an-array",
    sanitize: () => null,
    forward: () => {},
  }), TypeError);
  assert.throws(() => createRelayOutboundPipeline({
    shortCircuit: () => false,
    observers: [],
    sanitize: "not-a-fn",
    forward: () => {},
  }), TypeError);
});
