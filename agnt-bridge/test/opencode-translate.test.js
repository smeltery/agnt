// FILE: opencode-translate.test.js
// Purpose: Verify the opencode SSE/REST <-> Codex JSON-RPC translator handles
//          thread/start (POST /session), turn/start (POST /session/{id}/message),
//          and the SSE event family (message.updated, message.part.updated text/
//          reasoning/tool, session.status busy/idle, session.diff).
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/providers/opencode/translate

const test = require("node:test");
const assert = require("node:assert/strict");

const { createOpencodeTranslator } = require("../src/providers/opencode/translate");

function setupTranslator({ httpHandler } = {}) {
  const injected = [];
  const httpCalls = [];
  const transport = {
    describe: () => "fake-opencode",
    send() {},
    httpRequest(method, pathName, body) {
      httpCalls.push({ method, pathName, body });
      if (httpHandler) return Promise.resolve(httpHandler(method, pathName, body));
      return Promise.resolve({ status: 200, json: null, raw: "" });
    },
  };
  const translator = createOpencodeTranslator({
    injectInbound: (line) => injected.push(line),
    transport,
    env: process.env,
  });
  return { translator, injected, httpCalls };
}

function parseInjected(injected) {
  return injected.map((line) => JSON.parse(line));
}

test("thread/start posts to /session and synthesizes a thread response", async () => {
  const { translator, injected, httpCalls } = setupTranslator({
    httpHandler(method, pathName) {
      if (method === "POST" && pathName === "/session") {
        return {
          status: 200,
          json: {
            id: "ses_test123",
            slug: "kind-squid",
            directory: "/tmp/work",
            title: "New session",
            time: { created: 1, updated: 2 },
          },
        };
      }
      return { status: 404, json: null };
    },
  });

  translator.outbound(JSON.stringify({ id: "req-1", method: "thread/start", params: {} }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(httpCalls[0], { method: "POST", pathName: "/session", body: {} });
  const events = parseInjected(injected);
  const ack = events.find((e) => e.id === "req-1");
  const started = events.find((e) => e.method === "thread/started");
  assert.equal(ack.result.thread.id, "ses_test123");
  assert.equal(ack.result.thread.cwd, "/tmp/work");
  assert.equal(started.params.threadId, "ses_test123");
});

test("turn/start posts a message body and emits turn/started immediately", async () => {
  const { translator, injected, httpCalls } = setupTranslator();

  translator.outbound(JSON.stringify({
    id: "tu-1",
    method: "turn/start",
    params: {
      threadId: "ses_x",
      input: [{ type: "text", text: "hi" }],
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(httpCalls[0].method, "POST");
  assert.equal(httpCalls[0].pathName, "/session/ses_x/message");
  assert.equal(httpCalls[0].body.providerID, "anthropic");
  assert.equal(httpCalls[0].body.modelID, "claude-haiku-4-5");
  assert.deepEqual(httpCalls[0].body.parts, [{ type: "text", text: "hi" }]);

  const events = parseInjected(injected);
  const ack = events.find((e) => e.id === "tu-1");
  const turnStarted = events.find((e) => e.method === "turn/started");
  assert.match(ack.result.turnId, /^turn_/);
  assert.equal(turnStarted.params.threadId, "ses_x");
  assert.equal(turnStarted.params.turnId, ack.result.turnId);
});

test("message.updated assistant + message.part.updated text emit item/started + agent delta", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_a", input: [{ type: "text", text: "hi" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.updated",
    properties: {
      sessionID: "ses_a",
      info: { id: "msg_1", role: "assistant" },
    },
  }));
  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_a",
      part: { type: "text", text: "Hello", id: "prt_1", messageID: "msg_1" },
    },
  }));
  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_a",
      part: { type: "text", text: "Hello world", id: "prt_1", messageID: "msg_1" },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  assert.equal(events[0].method, "item/started");
  assert.equal(events[0].params.itemId, "msg_1");
  assert.equal(events[1].method, "item/agentMessage/delta");
  assert.equal(events[1].params.delta, "Hello");
  assert.equal(events[2].method, "item/agentMessage/delta");
  // Differential delta: only the new suffix.
  assert.equal(events[2].params.delta, " world");
});

test("message.part.updated with reasoning emits item/reasoning/textDelta", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_r", input: [{ type: "text", text: "?" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_r",
      part: { type: "reasoning", text: "thinking...", id: "prt_r1", messageID: "msg_r" },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method === "item/reasoning/textDelta");
  assert.equal(events[0].params.delta, "thinking...");
});

test("Bash tool part emits exec_command_begin then exec_command_end on completion", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_t", input: [{ type: "text", text: "ls" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_t",
      part: {
        type: "tool", tool: "bash", id: "prt_b1",
        state: { input: { command: "ls -la", cwd: "/tmp" }, status: "running" },
      },
    },
  }));
  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_t",
      part: {
        type: "tool", tool: "bash", id: "prt_b1",
        state: { input: { command: "ls -la", cwd: "/tmp" }, status: "completed", output: "file1\nfile2" },
      },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const begin = events.find((e) => e.method === "codex/event/exec_command_begin");
  const end = events.find((e) => e.method === "codex/event/exec_command_end");
  const outDelta = events.find((e) => e.method === "codex/event/exec_command_output_delta");
  assert.ok(begin);
  assert.equal(begin.params.command, "ls -la");
  assert.equal(outDelta.params.chunk, "file1\nfile2");
  assert.equal(end.params.status, "completed");
});

test("session.status idle finalizes the active turn with agent_message + item/completed + turn/completed", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_i", input: [{ type: "text", text: "hi" }] },
  }));
  // Simulate streaming text.
  translator.inbound(JSON.stringify({
    type: "message.updated",
    properties: { sessionID: "ses_i", info: { id: "msg_i", role: "assistant" } },
  }));
  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_i",
      part: { type: "text", text: "Hi!", id: "prt_i", messageID: "msg_i" },
    },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "session.status",
    properties: { sessionID: "ses_i", status: { type: "idle" } },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const agent = events.find((e) => e.method === "codex/event/agent_message");
  const completed = events.find((e) => e.method === "item/completed");
  const turnDone = events.find((e) => e.method === "turn/completed");
  assert.equal(agent.params.message, "Hi!");
  assert.equal(completed.params.item.text, "Hi!");
  assert.ok(turnDone);
});

test("session.status retry emits turn/failed but does not finalize the turn", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_r2", input: [{ type: "text", text: "x" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "session.status",
    properties: { sessionID: "ses_r2", status: { type: "retry", message: "rate limited" } },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const failed = events.find((e) => e.method === "turn/failed");
  const completed = events.find((e) => e.method === "turn/completed");
  assert.equal(failed.params.error.message, "rate limited");
  // turn/completed should fire later via the eventual idle status, not here.
  assert.equal(completed, undefined);
});

test("turn/interrupt POSTs to /session/{id}/abort", async () => {
  const { translator, httpCalls } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_int", input: [{ type: "text", text: "go" }] },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  httpCalls.length = 0;

  translator.outbound(JSON.stringify({
    id: "int", method: "turn/interrupt", params: { threadId: "ses_int" },
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(httpCalls[0], { method: "POST", pathName: "/session/ses_int/abort", body: {} });
});

test("thread/turns/list maps message GET response into turns", async () => {
  const { translator, injected } = setupTranslator({
    httpHandler(method, pathName) {
      if (method === "GET" && pathName === "/session/ses_list/message") {
        return {
          status: 200,
          json: [
            { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
            {
              info: { id: "msg_2", role: "assistant" },
              parts: [{ type: "text", text: "hello", id: "prt_2" }],
            },
          ],
        };
      }
      return { status: 404, json: null };
    },
  });

  translator.outbound(JSON.stringify({
    id: "list-1",
    method: "thread/turns/list",
    params: { threadId: "ses_list" },
  }));
  await new Promise((resolve) => setImmediate(resolve));

  const events = parseInjected(injected);
  const ack = events.find((e) => e.id === "list-1");
  assert.equal(ack.result.turns.length, 1);
  assert.equal(ack.result.turns[0].input[0].text, "hi");
  assert.equal(ack.result.turns[0].items[0].text, "hello");
});

test("session.diff emits turn/diff/updated", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_d", input: [{ type: "text", text: "x" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "session.diff",
    properties: { sessionID: "ses_d", diff: [{ file: "a.txt" }] },
  }));

  const events = parseInjected(injected).filter((e) => e.method === "turn/diff/updated");
  assert.equal(events[0].params.diff[0].file, "a.txt");
});

test("turn/start without thread fails fast", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "no-thread",
    method: "turn/start",
    params: { input: [{ type: "text", text: "x" }] },
  }));
  const events = parseInjected(injected);
  assert.equal(events[0].id, "no-thread");
  assert.equal(events[0].error.code, -32602);
});

test("session.status idle emits thread/tokenUsage/updated from latest message tokens", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_tok", input: [{ type: "text", text: "hi" }] },
  }));
  translator.inbound(JSON.stringify({
    type: "message.updated",
    properties: {
      sessionID: "ses_tok",
      info: {
        id: "msg_tok", role: "assistant",
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 80, write: 10 } },
      },
    },
  }));
  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_tok",
      part: { type: "text", text: "ok", id: "prt_tok", messageID: "msg_tok" },
    },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "session.status",
    properties: { sessionID: "ses_tok", status: { type: "idle" } },
  }));

  const events = parseInjected(injected).filter((e) => e.method === "thread/tokenUsage/updated");
  assert.equal(events.length, 1);
  assert.equal(events[0].params.tokenUsage.inputTokens, 100);
  assert.equal(events[0].params.tokenUsage.outputTokens, 20);
  assert.equal(events[0].params.tokenUsage.cachedInputTokens, 80);
});

test("thread/contextWindow/read GETs messages and surfaces token snapshot", async () => {
  const { translator, injected } = setupTranslator({
    httpHandler(method, pathName) {
      if (method === "GET" && pathName === "/session/ses_ctx/message") {
        return {
          status: 200,
          json: [
            { info: { id: "msg_u", role: "user" }, parts: [] },
            {
              info: {
                id: "msg_a", role: "assistant",
                tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
              },
              parts: [],
            },
          ],
        };
      }
      return { status: 404, json: null };
    },
  });

  translator.outbound(JSON.stringify({
    id: "ctx-1",
    method: "thread/contextWindow/read",
    params: { threadId: "ses_ctx" },
  }));
  await new Promise((r) => setImmediate(r));

  const events = parseInjected(injected);
  const ack = events.find((e) => e.id === "ctx-1");
  assert.equal(ack.result.contextWindow.inputTokens, 7);
  assert.equal(ack.result.contextWindow.outputTokens, 3);
});

test("session.status retry with next-resets-at emits thread/status/changed rateLimited", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_rl", input: [{ type: "text", text: "x" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "session.status",
    properties: {
      sessionID: "ses_rl",
      status: { type: "retry", attempt: 1, next: 1778105124680, message: "Quota exceeded" },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method === "thread/status/changed");
  assert.equal(events.length, 1);
  assert.equal(events[0].params.status.type, "rateLimited");
  assert.equal(events[0].params.status.rateLimit.resetsAt, 1778105124680);
  assert.equal(events[0].params.status.rateLimit.attempt, 1);
});

test("thread/list applies a 200-row pagination cap and reports hasMore", async () => {
  const sessions = Array.from({ length: 350 }, (_, i) => ({
    id: `ses_${i.toString().padStart(3, "0")}`,
    title: `s${i}`,
    directory: "/tmp",
    time: { created: 0, updated: i },
  }));
  const { translator, injected } = setupTranslator({
    httpHandler(method, pathName) {
      if (method === "GET" && pathName === "/session") {
        return { status: 200, json: sessions };
      }
      return { status: 404, json: null };
    },
  });

  translator.outbound(JSON.stringify({ id: "list-cap", method: "thread/list", params: {} }));
  await new Promise((r) => setImmediate(r));

  const events = parseInjected(injected);
  const ack = events.find((e) => e.id === "list-cap");
  assert.equal(ack.result.data.length, 200);
  assert.equal(ack.result.hasMore, true);
  // Sorted descending by updated, so first is sessions[349].
  assert.equal(ack.result.data[0].id, "ses_349");
});

test("thread/list honors a smaller requested limit", async () => {
  const sessions = Array.from({ length: 50 }, (_, i) => ({
    id: `ses_${i}`, time: { updated: i },
  }));
  const { translator, injected } = setupTranslator({
    httpHandler() { return { status: 200, json: sessions }; },
  });
  translator.outbound(JSON.stringify({
    id: "list-limit", method: "thread/list", params: { limit: 10 },
  }));
  await new Promise((r) => setImmediate(r));

  const ack = parseInjected(injected).find((e) => e.id === "list-limit");
  assert.equal(ack.result.data.length, 10);
});

test("inbound events for a different sessionID are ignored once a turn is active", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_mine", input: [{ type: "text", text: "x" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_other",
      part: { type: "text", text: "leak", id: "prt_l", messageID: "msg_l" },
    },
  }));

  assert.equal(injected.length, 0);
});
