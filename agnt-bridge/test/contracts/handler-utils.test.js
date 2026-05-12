// FILE: contracts/handler-utils.test.js
// Purpose: Locks the dispatch contract for createJsonRpcRequestHandler.
//          Six handlers depend on it preserving:
//            (1) JSON parse failure → return false (pass through)
//            (2) match=false → return false (pass through)
//            (3) success path wraps dispatch result in {id, result}
//            (4) error path wraps in {id, error:{code:-32000, message, data:{errorCode}}}
//                with err.errorCode / err.userMessage / err.message taking
//                precedence over the configured defaults
//            (5) onError fires before sendResponse (logging hook)
// Layer: Unit test (contract)
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const { createJsonRpcRequestHandler } = require("../../src/handlers/handler-utils");

function build(overrides = {}) {
  const sent = [];
  const defaults = {
    match: () => true,
    dispatch: async () => ({ ok: true }),
    defaultErrorCode: "test_error",
    defaultErrorMessage: "Test failure",
  };
  const handle = createJsonRpcRequestHandler({ ...defaults, ...overrides });
  const sendResponse = (line) => sent.push(line);
  return { handle, sendResponse, sent };
}

test("invalid JSON causes the handler to return false without responding", () => {
  const { handle, sent } = build();
  const claimed = handle("not-json{", () => sent.push("oops"));
  assert.equal(claimed, false);
  assert.equal(sent.length, 0);
});

test("match=false causes the handler to return false without responding", () => {
  const { handle, sent } = build({ match: () => false });
  const claimed = handle(JSON.stringify({ method: "other/method", id: 1 }), (line) => sent.push(line));
  assert.equal(claimed, false);
  assert.equal(sent.length, 0);
});

test("success path wraps dispatch result in {id, result}", async () => {
  const { handle, sendResponse, sent } = build({
    dispatch: async () => ({ value: 42 }),
  });
  const claimed = handle(JSON.stringify({ method: "x/y", id: "req-1" }), sendResponse);
  assert.equal(claimed, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  const response = JSON.parse(sent[0]);
  assert.deepEqual(response, { id: "req-1", result: { value: 42 } });
});

test("dispatch receives method, params, and options", async () => {
  let received = null;
  const { handle, sendResponse } = build({
    dispatch: async (method, params, options) => {
      received = { method, params, options };
      return {};
    },
  });
  handle(JSON.stringify({ method: "x/y", id: 1, params: { a: 1 } }), sendResponse, { extra: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(received, { method: "x/y", params: { a: 1 }, options: { extra: true } });
});

test("missing params defaults to empty object so dispatch never sees null/undefined", async () => {
  let received = null;
  const { handle, sendResponse } = build({
    dispatch: async (_method, params) => { received = params; return {}; },
  });
  handle(JSON.stringify({ method: "x/y", id: 1 }), sendResponse);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(received, {});
});

test("synchronous throw in dispatch is wrapped in the JSON-RPC error envelope", async () => {
  const { handle, sendResponse, sent } = build({
    dispatch: () => { throw new Error("boom"); },
  });
  handle(JSON.stringify({ method: "x/y", id: "req-1" }), sendResponse);
  await new Promise((r) => setImmediate(r));
  const response = JSON.parse(sent[0]);
  assert.equal(response.id, "req-1");
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.message, "boom");
  assert.equal(response.error.data.errorCode, "test_error");
});

test("rejected promise is wrapped in the JSON-RPC error envelope", async () => {
  const { handle, sendResponse, sent } = build({
    dispatch: async () => { throw new Error("async boom"); },
  });
  handle(JSON.stringify({ method: "x/y", id: 1 }), sendResponse);
  await new Promise((r) => setImmediate(r));
  const response = JSON.parse(sent[0]);
  assert.equal(response.error.message, "async boom");
});

test("err.errorCode and err.userMessage take precedence over the configured defaults", async () => {
  const { handle, sendResponse, sent } = build({
    dispatch: async () => {
      const err = new Error("internal");
      err.errorCode = "specific_code";
      err.userMessage = "Friendly version";
      throw err;
    },
  });
  handle(JSON.stringify({ method: "x/y", id: 1 }), sendResponse);
  await new Promise((r) => setImmediate(r));
  const response = JSON.parse(sent[0]);
  assert.equal(response.error.message, "Friendly version");
  assert.equal(response.error.data.errorCode, "specific_code");
});

test("error with neither message nor userMessage falls back to defaultErrorMessage", async () => {
  const { handle, sendResponse, sent } = build({
    dispatch: async () => {
      // Reject with a non-Error so message resolution falls through.
      // eslint-disable-next-line no-throw-literal
      throw { errorCode: "x" };
    },
  });
  handle(JSON.stringify({ method: "x/y", id: 1 }), sendResponse);
  await new Promise((r) => setImmediate(r));
  const response = JSON.parse(sent[0]);
  assert.equal(response.error.message, "Test failure");
  assert.equal(response.error.data.errorCode, "x");
});

test("onError fires with the thrown error before the response is sent", async () => {
  const seen = [];
  const { handle, sendResponse } = build({
    dispatch: async () => { throw new Error("noted"); },
    onError: (err) => seen.push(["onError", err.message]),
  });
  const sentLog = [];
  handle(JSON.stringify({ method: "x/y", id: 1 }), (line) => {
    sentLog.push(["response", JSON.parse(line).error?.message]);
  });
  await new Promise((r) => setImmediate(r));
  // onError must run before sendResponse so logs reflect the failure
  // before the wire response is observed.
  assert.deepEqual(seen, [["onError", "noted"]]);
  assert.deepEqual(sentLog, [["response", "noted"]]);
});

test("onError that itself throws does not mask the JSON-RPC response", async () => {
  const { handle, sendResponse, sent } = build({
    dispatch: async () => { throw new Error("inner"); },
    onError: () => { throw new Error("logger blew up"); },
  });
  handle(JSON.stringify({ method: "x/y", id: 1 }), sendResponse);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1, "response must still be sent even if onError throws");
  const response = JSON.parse(sent[0]);
  assert.equal(response.error.message, "inner");
});

test("constructor rejects bad inputs eagerly", () => {
  assert.throws(() => createJsonRpcRequestHandler({}), TypeError);
  assert.throws(() => createJsonRpcRequestHandler({
    match: () => true,
    dispatch: async () => ({}),
    defaultErrorCode: "",
    defaultErrorMessage: "x",
  }), TypeError);
  assert.throws(() => createJsonRpcRequestHandler({
    match: "not a fn",
    dispatch: async () => ({}),
    defaultErrorCode: "x",
    defaultErrorMessage: "y",
  }), TypeError);
});
