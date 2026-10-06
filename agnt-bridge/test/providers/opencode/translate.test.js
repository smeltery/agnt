// FILE: translate.test.js
// Purpose: Verify core opencode translator thread, turn, status, and history flows.
// Layer: Unit test

const test = require("node:test");
const assert = require("node:assert/strict");

const { setupTranslator, parseInjected } = require("./translate-test-helpers");

test("thread/start emits thread/initialized with the opencode tool list", async () => {
  const { translator, injected } = setupTranslator({
    httpHandler(method, pathName) {
      if (method === "POST" && pathName === "/session") {
        return { status: 200, json: { id: "ses_init", directory: "/tmp/p" } };
      }
      return { status: 404, json: null };
    },
  });
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  await new Promise((r) => setImmediate(r));
  const events = parseInjected(injected).filter((e) => e.method);
  const initialized = events.find((e) => e.method === "thread/initialized");
  assert.ok(initialized);
  assert.equal(initialized.params.provider, "opencode");
  assert.ok(initialized.params.tools.includes("bash"));
  assert.ok(initialized.params.tools.includes("read"));
  assert.ok(initialized.params.tools.includes("edit"));
});

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
  assert.equal(httpCalls[0].pathName, "/session/ses_x/prompt_async");
  assert.equal(httpCalls[0].body.model.providerID, "anthropic");
  assert.equal(httpCalls[0].body.model.modelID, "claude-haiku-4-5");
  assert.deepEqual(httpCalls[0].body.parts, [{ type: "text", text: "hi" }]);

  const events = parseInjected(injected);
  const ack = events.find((e) => e.id === "tu-1");
  const turnStarted = events.find((e) => e.method === "turn/started");
  assert.match(ack.result.turnId, /^turn_/);
  assert.equal(turnStarted.params.threadId, "ses_x");
  assert.equal(turnStarted.params.turnId, ack.result.turnId);
});

test("turn/start accepts `params.model` as a fallback for `modelID` (Android wire shape)", async () => {
  // Android always sends `params.model` (parity with how it talks to Claude /
  // Cursor / Codex); opencode upstream prefers `modelID` but the translator
  // already falls back. This pins the fallback so a future opencode upstream
  // rename doesn't quietly break per-turn model overrides on Android.
  const { translator, httpCalls } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu-model-fallback",
    method: "turn/start",
    params: {
      threadId: "ses_x",
      input: [{ type: "text", text: "hi" }],
      providerID: "anthropic",
      model: "claude-haiku-4-5",
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(httpCalls[0].body.model.modelID, "claude-haiku-4-5");
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

test("session.status retry preserves the active turn without reporting failure", () => {
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
  assert.equal(failed, undefined);
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

test("second turn/start while one is active is rejected", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu-1", method: "turn/start",
    params: { threadId: "ses_x", input: [{ type: "text", text: "first" }] },
  }));
  injected.length = 0;

  translator.outbound(JSON.stringify({
    id: "tu-2", method: "turn/start",
    params: { threadId: "ses_x", input: [{ type: "text", text: "second" }] },
  }));
  const events = parseInjected(injected);
  assert.equal(events[0].id, "tu-2");
  assert.equal(events[0].error.code, -32003);
});

test("thread/compact POSTs to /session/{id}/summarize and returns ok:true", async () => {
  const { translator, injected, httpCalls } = setupTranslator({
    httpHandler(method, pathName) {
      if (method === "POST" && pathName === "/session/ses_c/summarize") {
        return { status: 200, json: { ok: true } };
      }
      return { status: 404, json: null };
    },
  });
  translator.outbound(JSON.stringify({
    id: "c-1", method: "thread/compact", params: { threadId: "ses_c" },
  }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(httpCalls[0], { method: "POST", pathName: "/session/ses_c/summarize", body: {} });
  const ack = parseInjected(injected).find((e) => e.id === "c-1");
  assert.equal(ack.result.compacted, true);
});

test("thread/fork POSTs to /session/{id}/fork and returns the new thread", async () => {
  const { translator, injected, httpCalls } = setupTranslator({
    httpHandler(method, pathName) {
      if (method === "POST" && pathName === "/session/ses_src/fork") {
        return {
          status: 200,
          json: { id: "ses_forked", title: "Forked", directory: "/tmp", time: { created: 1, updated: 1 } },
        };
      }
      return { status: 404, json: null };
    },
  });
  translator.outbound(JSON.stringify({
    id: "fork-1", method: "thread/fork",
    params: { threadId: "ses_src", messageId: "msg_pivot" },
  }));
  await new Promise((r) => setImmediate(r));
  assert.equal(httpCalls[0].body.messageID, "msg_pivot");
  const ack = parseInjected(injected).find((e) => e.id === "fork-1");
  assert.equal(ack.result.thread.id, "ses_forked");
});
