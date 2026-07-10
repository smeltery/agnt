// FILE: contracts/turns-list-pager.test.js
// Purpose: Pins the adaptive `thread/turns/list` pagination contract that
//          bridge.js delegates to. The load-bearing invariants are:
//          1. parseAdaptiveThreadTurnsListRequest only matches well-formed
//             thread/turns/list requests — anything else is rejected so
//             bridge.js falls through to the normal forward path.
//          2. fetchAdaptiveThreadTurnsListForRelay is bounded by both byte
//             and time budgets — never blows past the relay's payload cap,
//             never spends more than ~5.5 s wall-clock chasing pages.
//          3. The empty/empty-cursor fallback returns a well-formed response
//             so the iPhone doesn't crash on a missing turns key.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES,
  parseAdaptiveThreadTurnsListRequest,
  fetchAdaptiveThreadTurnsListForRelay,
  createThreadTurnsListFastPageCoordinator,
  canonicalThreadTurnsListRequest,
  buildEmptyTurnsListResponse,
  isEmptyTurnsListResponse,
} = require("../../src/bridge/turns-list-pager");

const PASSTHROUGH = (raw) => raw;

// ─── parseAdaptiveThreadTurnsListRequest ────────────────────────────────────

test("parseAdaptiveThreadTurnsListRequest accepts a well-formed request", () => {
  const raw = JSON.stringify({
    id: "r1",
    method: "thread/turns/list",
    params: { threadId: "t", limit: 5 },
  });
  const out = parseAdaptiveThreadTurnsListRequest(raw);
  assert.ok(out);
  assert.equal(out.id, "r1");
  assert.equal(out.params.limit, 5);
});

test("parseAdaptiveThreadTurnsListRequest rejects the wrong method", () => {
  const raw = JSON.stringify({
    id: "r1",
    method: "thread/something-else",
    params: { limit: 5 },
  });
  assert.equal(parseAdaptiveThreadTurnsListRequest(raw), null);
});

test("parseAdaptiveThreadTurnsListRequest rejects missing/non-positive limit", () => {
  for (const params of [{}, { limit: 0 }, { limit: -1 }, { limit: "5" }, { limit: 1.5 }]) {
    const raw = JSON.stringify({ id: "r1", method: "thread/turns/list", params });
    assert.equal(
      parseAdaptiveThreadTurnsListRequest(raw),
      null,
      `params=${JSON.stringify(params)} must be rejected`,
    );
  }
});

test("parseAdaptiveThreadTurnsListRequest rejects malformed input without throwing", () => {
  for (const input of [
    "not json",
    "",
    JSON.stringify("string-payload"),
    JSON.stringify([1, 2, 3]),
    JSON.stringify({ method: "thread/turns/list" }), // no id
    JSON.stringify({ id: "r", method: "thread/turns/list" }), // no params
    JSON.stringify({ id: "r", method: "thread/turns/list", params: [] }), // params array
  ]) {
    assert.doesNotThrow(() => parseAdaptiveThreadTurnsListRequest(input));
    assert.equal(parseAdaptiveThreadTurnsListRequest(input), null, `should reject ${input.slice(0, 40)}`);
  }
});

// ─── fetchAdaptiveThreadTurnsListForRelay ───────────────────────────────────

test("fetchAdaptiveThreadTurnsListForRelay requires fetchPage", async () => {
  await assert.rejects(
    () => fetchAdaptiveThreadTurnsListForRelay({ id: "r", params: { limit: 1 } }, {}),
    /fetchPage is required/,
  );
});

test("fetchAdaptiveThreadTurnsListForRelay requires sanitizeForRelay", async () => {
  await assert.rejects(
    () => fetchAdaptiveThreadTurnsListForRelay({ id: "r", params: { limit: 1 } }, {
      fetchPage: async () => ({ data: [{ id: "t1" }] }),
    }),
    /sanitizeForRelay is required/,
  );
});

test("fetchAdaptiveThreadTurnsListForRelay returns the upstream page when it fits", async () => {
  const request = { id: "r1", params: { threadId: "t", limit: 3 } };
  const response = await fetchAdaptiveThreadTurnsListForRelay(request, {
    fetchPage: async () => ({ data: [{ id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" }] }),
    sanitizeForRelay: PASSTHROUGH,
  });
  assert.equal(response.id, "r1");
  assert.equal(response.result.data.length, 3);
});

test("fetchAdaptiveThreadTurnsListForRelay shrinks to fit when sanitized response would exceed the soft cap", async () => {
  // sanitizeForRelay reports a fake huge size for the first call so the pager
  // hits the cap branch and shrinks; then reports a small size on retry.
  let callCount = 0;
  const sanitizeForRelay = (raw) => {
    callCount += 1;
    if (callCount === 1) {
      // pretend the response was way over the cap so the pager has to shrink
      return raw + "X".repeat(RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES);
    }
    return raw;
  };

  const request = { id: "r2", params: { threadId: "t", limit: 5 } };
  const response = await fetchAdaptiveThreadTurnsListForRelay(request, {
    fetchPage: async () => ({ data: [
      { id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" },
      { id: "turn-4" }, { id: "turn-5" },
    ] }),
    sanitizeForRelay,
  });
  // pager should still return a valid response with at least one turn
  assert.equal(response.id, "r2");
  const turns = response.result.data || response.result.items || response.result.turns;
  assert.ok(Array.isArray(turns));
  assert.ok(turns.length >= 1, "must return at least one turn");
});

test("fetchAdaptiveThreadTurnsListForRelay returns empty response when fetchPage throws", async () => {
  const request = { id: "r3", params: { threadId: "t", limit: 3 } };
  const response = await fetchAdaptiveThreadTurnsListForRelay(request, {
    fetchPage: async () => { throw new Error("upstream is down"); },
    sanitizeForRelay: PASSTHROUGH,
  });
  // The pager swallows the error via the safe fallback and returns an empty response.
  assert.equal(response.id, "r3");
  assert.ok(isEmptyTurnsListResponse(response));
});

test("fetchAdaptiveThreadTurnsListForRelay stops paging once requestedLimit is met", async () => {
  let calls = 0;
  const request = { id: "r4", params: { threadId: "t", limit: 2 } };
  await fetchAdaptiveThreadTurnsListForRelay(request, {
    fetchPage: async () => {
      calls += 1;
      return { data: [{ id: `turn-${calls}` }, { id: `turn-${calls}b` }], nextCursor: "more" };
    },
    sanitizeForRelay: PASSTHROUGH,
  });
  // First page already supplies >= requestedLimit turns, so we should not fetch again.
  assert.equal(calls, 1);
});

test("fetchAdaptiveThreadTurnsListForRelay respects targetBudgetMs", async () => {
  // Simulate a slow upstream and a tight budget — pager should bail after the first page.
  let nowValue = 0;
  let calls = 0;
  const request = { id: "r5", params: { threadId: "t", limit: 10 } };
  await fetchAdaptiveThreadTurnsListForRelay(request, {
    now: () => nowValue,
    targetBudgetMs: 100,
    budgetReserveMs: 10,
    fetchPage: async () => {
      calls += 1;
      // advance virtual clock to consume the budget
      nowValue += 200;
      return { data: [{ id: `turn-${calls}` }], nextCursor: "more" };
    },
    sanitizeForRelay: PASSTHROUGH,
  });
  // Budget blown after the first page, so we must not have fetched again.
  assert.equal(calls, 1);
});

// ─── buildEmptyTurnsListResponse / isEmptyTurnsListResponse ─────────────────

test("buildEmptyTurnsListResponse echoes the request id with an empty data array", () => {
  const resp = buildEmptyTurnsListResponse({ id: "r-empty" });
  assert.equal(resp.id, "r-empty");
  assert.deepEqual(resp.result.data, []);
  assert.equal(resp.result.nextCursor, null);
});

test("isEmptyTurnsListResponse round-trips with buildEmptyTurnsListResponse", () => {
  assert.equal(isEmptyTurnsListResponse(buildEmptyTurnsListResponse({ id: "r" })), true);
});

test("isEmptyTurnsListResponse returns false when at least one turn is present", () => {
  assert.equal(
    isEmptyTurnsListResponse({ result: { data: [{ id: "t1" }] } }),
    false,
  );
});

test("isEmptyTurnsListResponse returns false when no recognized turns key is present", () => {
  assert.equal(isEmptyTurnsListResponse({ result: { somethingElse: [] } }), false);
});

// ─── createThreadTurnsListFastPageCoordinator ────────────────────────────────

test("thread turns-list fast page returns JSONL once and reuses the late canonical page", async () => {
  let releaseDeadline = null;
  let resolveCanonical = null;
  let canonicalFetches = 0;
  const canonicalResponse = new Promise((resolve) => {
    resolveCanonical = resolve;
  });
  const coordinator = createThreadTurnsListFastPageCoordinator({
    createToken: () => "handoff-token",
    setTimeoutImpl(callback) {
      releaseDeadline = callback;
      return 1;
    },
    clearTimeoutImpl() {},
  });
  const request = {
    id: "req-fast-jsonl",
    method: "thread/turns/list",
    params: { threadId: "thread-fast-jsonl", limit: 1 },
  };
  const resolveOptions = {
    fetchCanonical: async () => {
      canonicalFetches += 1;
      return canonicalResponse;
    },
    readJsonl: async () => ({
      response: {
        id: request.id,
        result: {
          data: [{ id: "turn-jsonl", items: [{ id: "item-jsonl" }] }],
          nextCursor: "agnt-jsonl-fallback-older-unavailable",
          agntJsonlFallback: true,
        },
      },
      usesJsonl: true,
    }),
  };

  const fastSelectionPromise = coordinator.resolve(request, resolveOptions);
  for (let attempt = 0; attempt < 10 && !releaseDeadline; attempt += 1) {
    await Promise.resolve();
  }
  assert.ok(releaseDeadline);
  releaseDeadline();
  const fastSelection = await fastSelectionPromise;

  assert.equal(fastSelection.source, "jsonl");
  assert.equal(fastSelection.usesJsonl, true);
  assert.equal(fastSelection.response.result.data[0].id, "turn-jsonl");
  assert.equal(
    fastSelection.response.result.nextCursor,
    "agnt-jsonl-handoff-v1:turn-jsonl:handoff-token"
  );
  assert.equal(fastSelection.response.result.agntCanonicalHandoff, true);

  const canonicalSelectionPromise = coordinator.resolve({
    ...request,
    id: "req-canonical-reconcile",
    params: {
      ...request.params,
      agntRequireCanonical: true,
    },
  }, resolveOptions);
  resolveCanonical({
    id: "bridge-internal-request",
    result: {
      data: [{ id: "turn-jsonl", items: [{ id: "item-canonical" }] }],
      nextCursor: "canonical-cursor",
    },
  });
  const canonicalSelection = await canonicalSelectionPromise;

  assert.equal(canonicalFetches, 1);
  assert.equal(canonicalSelection.source, "canonical");
  assert.equal(canonicalSelection.response.id, "req-canonical-reconcile");
  assert.equal(canonicalSelection.response.result.data[0].items[0].id, "item-canonical");
  assert.equal(canonicalSelection.response.result.nextCursor, "canonical-cursor");
});

test("thread turns-list first-page singleflight isolates request shapes and rebinds response ids", async () => {
  const coordinator = createThreadTurnsListFastPageCoordinator();
  const canonicalFetches = [];
  const canonicalResolversByLimit = new Map();
  const options = {
    fetchCanonical: (canonicalRequest) => new Promise((resolve) => {
      const limit = canonicalRequest.params.limit;
      canonicalFetches.push({ id: canonicalRequest.id, limit });
      canonicalResolversByLimit.set(limit, resolve);
    }),
    readJsonl: async () => null,
  };
  const request = {
    id: "req-shape-limit-1-a",
    method: "thread/turns/list",
    params: { threadId: "thread-shared-shape", limit: 1 },
  };

  const limitOneFirst = coordinator.resolve(request, options);
  const limitEight = coordinator.resolve({
    ...request,
    id: "req-shape-limit-8",
    params: { ...request.params, limit: 8 },
  }, options);
  const limitOneSecond = coordinator.resolve({
    ...request,
    id: "req-shape-limit-1-b",
  }, options);

  assert.deepEqual(canonicalFetches, [
    { id: "req-shape-limit-1-a", limit: 1 },
    { id: "req-shape-limit-8", limit: 8 },
  ]);

  canonicalResolversByLimit.get(1)({
    id: "canonical-limit-1",
    result: {
      data: [{ id: "turn-limit-1", items: [] }],
      nextCursor: "cursor-after-limit-1",
    },
  });
  canonicalResolversByLimit.get(8)({
    id: "canonical-limit-8",
    result: {
      data: [
        { id: "turn-limit-8-a", items: [] },
        { id: "turn-limit-8-b", items: [] },
      ],
      nextCursor: "cursor-after-limit-8",
    },
  });

  const [firstSelection, eightSelection, secondSelection] = await Promise.all([
    limitOneFirst,
    limitEight,
    limitOneSecond,
  ]);
  assert.equal(firstSelection.response.id, "req-shape-limit-1-a");
  assert.equal(eightSelection.response.id, "req-shape-limit-8");
  assert.equal(secondSelection.response.id, "req-shape-limit-1-b");
  assert.equal(firstSelection.response.result.data.length, 1);
  assert.equal(secondSelection.response.result.data.length, 1);
  assert.equal(eightSelection.response.result.data.length, 2);
});

test("thread turns-list fast page keeps an immediate canonical response authoritative", async () => {
  let deadlineWasScheduled = false;
  const coordinator = createThreadTurnsListFastPageCoordinator({
    setTimeoutImpl() {
      deadlineWasScheduled = true;
      return 1;
    },
    clearTimeoutImpl() {},
  });
  const selection = await coordinator.resolve({
    id: "req-fast-canonical",
    method: "thread/turns/list",
    params: { threadId: "thread-fast-canonical", limit: 1 },
  }, {
    fetchCanonical: async () => ({
      id: "req-fast-canonical",
      result: {
        data: [{ id: "turn-canonical", items: [] }],
        nextCursor: null,
      },
    }),
    readJsonl: async () => ({
      response: {
        id: "req-fast-canonical",
        result: {
          data: [{ id: "turn-jsonl", items: [] }],
          nextCursor: "agnt-jsonl-fallback-older-unavailable",
        },
      },
      usesJsonl: true,
    }),
  });

  assert.equal(deadlineWasScheduled, true);
  assert.equal(selection.source, "canonical");
  assert.equal(selection.response.result.data[0].id, "turn-canonical");
});

test("thread turns-list fast page prefers a newer running JSONL turn over stale canonical history", async () => {
  const coordinator = createThreadTurnsListFastPageCoordinator({
    createToken: () => "newer-jsonl-token",
    setTimeoutImpl: () => 1,
    clearTimeoutImpl() {},
  });
  const selection = await coordinator.resolve({
    id: "req-newer-jsonl",
    method: "thread/turns/list",
    params: { threadId: "thread-newer-jsonl", limit: 1 },
  }, {
    fetchCanonical: async () => ({
      id: "req-newer-jsonl",
      result: {
        data: [{ id: "turn-canonical-older", status: "completed", items: [] }],
        nextCursor: "cursor-after-canonical-older",
      },
    }),
    readJsonl: async () => ({
      response: {
        id: "req-newer-jsonl",
        result: {
          data: [{ id: "turn-jsonl-running", status: "running", items: [] }],
          nextCursor: "agnt-jsonl-fallback-older-unavailable",
        },
      },
      usesJsonl: true,
    }),
  });

  assert.equal(selection.source, "jsonl");
  assert.equal(selection.response.result.data[0].id, "turn-jsonl-running");
  assert.equal(selection.response.result.agntCanonicalHandoff, true);
});

test("thread turns-list handoff never returns newer canonical turns as older history", async () => {
  let releaseDeadline = null;
  let resolveCanonical = null;
  const canonicalResponse = new Promise((resolve) => {
    resolveCanonical = resolve;
  });
  const coordinator = createThreadTurnsListFastPageCoordinator({
    createToken: () => "anchor-token",
    setTimeoutImpl(callback) {
      releaseDeadline = callback;
      return 1;
    },
    clearTimeoutImpl() {},
  });
  const request = {
    id: "req-anchor-fast",
    method: "thread/turns/list",
    params: { threadId: "thread-anchor", limit: 1 },
  };
  const options = {
    fetchCanonical: async () => canonicalResponse,
    readJsonl: async () => ({
      response: {
        id: request.id,
        result: {
          data: [{ id: "turn-anchor", items: [{ id: "anchor-item" }] }],
          nextCursor: "agnt-jsonl-fallback-older-unavailable",
        },
      },
      usesJsonl: true,
    }),
  };

  const firstSelectionPromise = coordinator.resolve(request, options);
  for (let attempt = 0; attempt < 10 && !releaseDeadline; attempt += 1) {
    await Promise.resolve();
  }
  releaseDeadline();
  const firstSelection = await firstSelectionPromise;
  const olderSelectionPromise = coordinator.resolve({
    ...request,
    id: "req-anchor-older",
    params: { ...request.params, cursor: firstSelection.response.result.nextCursor },
  }, options);

  resolveCanonical({
    id: "bridge-internal-anchor",
    result: {
      data: [
        { id: "turn-newer", items: [] },
        { id: "turn-anchor", items: [{ id: "canonical-anchor-item" }] },
        { id: "turn-older", items: [] },
      ],
      nextCursor: "cursor-after-older",
    },
  });
  const olderSelection = await olderSelectionPromise;

  assert.deepEqual(
    olderSelection.response.result.data.map((turn) => turn.id),
    ["turn-anchor", "turn-older"]
  );
  assert.equal(olderSelection.response.id, "req-anchor-older");
});

test("canonical turns-list requests strip bridge-only handoff state", () => {
  const request = canonicalThreadTurnsListRequest({
    id: "req-handoff-strip",
    method: "thread/turns/list",
    params: {
      threadId: "thread-handoff-strip",
      limit: 1,
      cursor: "agnt-jsonl-handoff-v1:turn-a:token-a",
      agntRequireCanonical: true,
    },
  });

  assert.deepEqual(request, {
    id: "req-handoff-strip",
    method: "thread/turns/list",
    params: {
      threadId: "thread-handoff-strip",
      limit: 1,
    },
  });
});
