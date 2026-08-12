const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canonicalThreadTurnsListRequest,
  createThreadTurnsListFastPageCoordinator,
} = require("../../src/bridge/turns-list-pager");

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
  let jsonlReads = 0;
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
    readJsonl: async () => {
      jsonlReads += 1;
      return {
        response: {
          id: "req-fast-canonical",
          result: {
            data: [{ id: "turn-jsonl", items: [] }],
            nextCursor: "agnt-jsonl-fallback-older-unavailable",
          },
        },
        usesJsonl: true,
      };
    },
  });

  assert.equal(deadlineWasScheduled, true);
  assert.equal(jsonlReads, 0);
  assert.equal(selection.source, "canonical");
  assert.equal(selection.response.result.data[0].id, "turn-canonical");
});

test("thread turns-list fast page does not build JSONL when canonical wins the deadline", async () => {
  let jsonlReads = 0;
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
    readJsonl: async () => {
      jsonlReads += 1;
      return {
        response: {
          id: "req-newer-jsonl",
          result: {
            data: [{ id: "turn-jsonl-running", status: "running", items: [] }],
            nextCursor: "agnt-jsonl-fallback-older-unavailable",
          },
        },
        usesJsonl: true,
      };
    },
  });

  assert.equal(jsonlReads, 0);
  assert.equal(selection.source, "canonical");
  assert.equal(selection.response.result.data[0].id, "turn-canonical-older");
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
