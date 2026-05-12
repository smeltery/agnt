// FILE: contracts/bridge-managed-codex-client.test.js
// Purpose: Pins the promise-based request/response wrapper around the codex
//          transport. Load-bearing invariants:
//          1. sendRequest builds a unique request id, serialises {id, method,
//             params}, calls send(), and resolves on a matching response.
//          2. Response routing strips the waiter from the in-flight Map and
//             clears the timeout — no leaks on success or failure.
//          3. handleResponse returns false when there's no matching waiter
//             so bridge.js's caller can fall through to phone-bound routing.
//          4. Timeout rejects the promise + cleans up the Map.
//          5. failAll rejects every in-flight waiter (codex transport closed
//             while requests were outstanding).
//          6. {payload} responses unwrap to .payload; {result} unwraps to
//             .result; neither present → null.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createBridgeManagedCodexClient,
  DEFAULT_TIMEOUT_MS,
} = require("../../src/bridge/bridge-managed-codex-client");

function makeFakeTimerEnv() {
  const handles = [];
  return {
    setTimeoutImpl(fn, ms) {
      const handle = { fn, ms, cleared: false };
      handles.push(handle);
      return handle;
    },
    clearTimeoutImpl(handle) {
      if (handle) handle.cleared = true;
    },
    fireAll() {
      for (const h of handles) {
        if (!h.cleared) h.fn();
      }
    },
    active: () => handles.filter((h) => !h.cleared),
  };
}

function fakeRandomBytes(seed) {
  let counter = 0;
  return () => {
    counter += 1;
    return Buffer.from(`${seed}${counter}`.padEnd(12, "0"));
  };
}

// ─── constructor + guards ───────────────────────────────────────────────────

test("createBridgeManagedCodexClient requires a send() function", () => {
  assert.throws(() => createBridgeManagedCodexClient({}), /send/);
});

test("createBridgeManagedCodexClient exposes the default 20s timeout", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 20_000);
});

// ─── sendRequest + handleResponse round-trip ────────────────────────────────

test("sendRequest serialises {id, method, params} and resolves with .result on match", async () => {
  const env = makeFakeTimerEnv();
  const sent = [];
  const client = createBridgeManagedCodexClient({
    send: (payload) => sent.push(payload),
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    randomBytesImpl: fakeRandomBytes("req"),
  });

  const promise = client.sendRequest("thread/read", { threadId: "t1" });
  // exactly one frame should have been sent
  assert.equal(sent.length, 1);
  const parsed = JSON.parse(sent[0]);
  assert.equal(parsed.method, "thread/read");
  assert.deepEqual(parsed.params, { threadId: "t1" });
  assert.match(parsed.id, /^bridge-managed-/);

  const consumed = client.handleResponse(JSON.stringify({
    id: parsed.id,
    result: { ok: true },
  }));
  assert.equal(consumed, true);

  const value = await promise;
  assert.deepEqual(value, { ok: true });
  // timeout must have been cleared, waiter map drained
  assert.equal(client.pendingCount(), 0);
  assert.equal(env.active().length, 0);
});

test("handleResponse falls back to .payload when .result is absent", async () => {
  const env = makeFakeTimerEnv();
  const sent = [];
  const client = createBridgeManagedCodexClient({
    send: (payload) => sent.push(payload),
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    randomBytesImpl: fakeRandomBytes("p"),
  });

  const promise = client.sendRequest("m", {});
  const id = JSON.parse(sent[0]).id;
  client.handleResponse(JSON.stringify({ id, payload: { kind: "app-server" } }));
  assert.deepEqual(await promise, { kind: "app-server" });
});

test("handleResponse resolves with null when neither result nor payload is present", async () => {
  const env = makeFakeTimerEnv();
  const sent = [];
  const client = createBridgeManagedCodexClient({
    send: (payload) => sent.push(payload),
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    randomBytesImpl: fakeRandomBytes("n"),
  });

  const promise = client.sendRequest("m", {});
  const id = JSON.parse(sent[0]).id;
  client.handleResponse(JSON.stringify({ id }));
  assert.equal(await promise, null);
});

test("handleResponse rejects with a richer error when the response carries .error", async () => {
  const env = makeFakeTimerEnv();
  const sent = [];
  const client = createBridgeManagedCodexClient({
    send: (payload) => sent.push(payload),
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    randomBytesImpl: fakeRandomBytes("e"),
  });

  const promise = client.sendRequest("m", {});
  const id = JSON.parse(sent[0]).id;
  client.handleResponse(JSON.stringify({
    id,
    error: { code: -32600, message: "bad", data: { detail: "x" } },
  }));

  await assert.rejects(promise, (err) => {
    assert.equal(err.message, "bad");
    assert.equal(err.code, -32600);
    assert.deepEqual(err.data, { detail: "x" });
    return true;
  });
});

test("handleResponse returns false when message has no id or no matching waiter", () => {
  const env = makeFakeTimerEnv();
  const client = createBridgeManagedCodexClient({
    send: () => {},
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
  });
  assert.equal(client.handleResponse("not json"), false);
  assert.equal(client.handleResponse(JSON.stringify({})), false);
  assert.equal(
    client.handleResponse(JSON.stringify({ id: "unknown", result: {} })),
    false,
  );
});

// ─── send() errors + timeout ────────────────────────────────────────────────

test("sendRequest rejects + cleans up when send() throws", async () => {
  const env = makeFakeTimerEnv();
  const client = createBridgeManagedCodexClient({
    send: () => { throw new Error("transport down"); },
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
  });

  await assert.rejects(client.sendRequest("m", {}), /transport down/);
  assert.equal(client.pendingCount(), 0);
  assert.equal(env.active().length, 0);
});

test("sendRequest rejects with a timeout error when no response arrives in time", async () => {
  const env = makeFakeTimerEnv();
  const client = createBridgeManagedCodexClient({
    send: () => {},
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    timeoutMs: 5,
  });

  const promise = client.sendRequest("m/slow", {});
  env.fireAll();
  await assert.rejects(promise, /timed out: m\/slow/);
  assert.equal(client.pendingCount(), 0);
});

// ─── failAll ────────────────────────────────────────────────────────────────

test("failAll rejects every in-flight waiter and clears the map", async () => {
  const env = makeFakeTimerEnv();
  const client = createBridgeManagedCodexClient({
    send: () => {},
    setTimeoutImpl: env.setTimeoutImpl,
    clearTimeoutImpl: env.clearTimeoutImpl,
    randomBytesImpl: fakeRandomBytes("f"),
  });

  const p1 = client.sendRequest("m1", {});
  const p2 = client.sendRequest("m2", {});
  assert.equal(client.pendingCount(), 2);

  client.failAll(new Error("transport closed"));

  await assert.rejects(p1, /transport closed/);
  await assert.rejects(p2, /transport closed/);
  assert.equal(client.pendingCount(), 0);
  assert.equal(env.active().length, 0);
});
