const assert = require("node:assert/strict");
const test = require("node:test");
const { setupTranslator, parseInjected } = require("./translate-test-helpers");
const { pageByAnchor } = require("../../../src/providers/opencode/pagination");
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("catalog spans projects and paginates archived sessions without mixing active chats", async () => {
  const { translator, injected, httpCalls } = setupTranslator({ httpHandler(method, route) {
    if (route === "/project") return { status: 200, json: [{ worktree: "/one" }, { worktree: "/two" }] };
    const second = route.includes("%2Ftwo");
    return { status: 200, json: second
      ? [{ id: "archived-b", directory: "/two", time: { archived: 1, updated: 20 } }]
      : [{ id: "active", time: { updated: 30 } }, { id: "archived-a", directory: "/one", time: { archived: 1, updated: 10 } }] };
  } });
  translator.outbound(JSON.stringify({ id: 1, method: "thread/list", params: { archived: true, limit: 1 } })); await tick();
  const first = parseInjected(injected).find((e) => e.id === 1).result;
  assert.equal(first.data[0].id, "archived-b"); assert.ok(first.nextCursor);
  translator.outbound(JSON.stringify({ id: 2, method: "thread/list", params: { archived: true, limit: 1, cursor: first.nextCursor } })); await tick();
  const next = parseInjected(injected).find((e) => e.id === 2).result;
  assert.equal(next.data[0].id, "archived-a"); assert.equal(next.hasMore, false);
  assert.ok(httpCalls.some((call) => call.pathName.includes("directory=%2Fone")));
  assert.ok(httpCalls.some((call) => call.pathName.includes("directory=%2Ftwo")));
});

test("history pagination stays anchored when new turns arrive and rejects deleted anchors", () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({ id: `turn_${i}` }));
  const first = pageByAnchor(turns, { limit: 2 });
  assert.deepEqual(first.data.map((item) => item.id), ["turn_4", "turn_3"]);
  const next = pageByAnchor([...turns, { id: "turn_5" }], { cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(next.data.map((item) => item.id), ["turn_2", "turn_1"]);
  assert.throws(() => pageByAnchor(turns.filter((turn) => turn.id !== "turn_3"), { cursor: first.nextCursor }), /History changed/);
});
