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

test("permission.asked emits item/commandExecution/requestApproval and reply POSTs to /permissions", async () => {
  const httpCalls = [];
  const injected = [];
  const transport = {
    describe: () => "fake",
    send() {},
    httpRequest(method, pathName, body) {
      httpCalls.push({ method, pathName, body });
      return Promise.resolve({ status: 200, json: { ok: true }, raw: "" });
    },
  };
  const translator = createOpencodeTranslator({
    injectInbound: (line) => injected.push(line),
    transport,
    env: process.env,
  });
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_perm", input: [{ type: "text", text: "do it" }] },
  }));
  injected.length = 0;
  httpCalls.length = 0;

  // opencode SSE: permission.asked
  translator.inbound(JSON.stringify({
    type: "permission.asked",
    properties: {
      sessionID: "ses_perm",
      info: {
        id: "perm_abc",
        sessionID: "ses_perm",
        permission: "edit",
        metadata: { filepath: "/tmp/y.txt", diff: "+ b" },
        title: "Approve edit?",
      },
    },
  }));

  const requestEnvelope = parseInjected(injected).find((e) => e.method?.endsWith("requestApproval"));
  assert.ok(requestEnvelope, "expected an approval request to be injected");
  assert.equal(requestEnvelope.method, "item/fileChange/requestApproval");
  assert.equal(requestEnvelope.params.permissionID, "perm_abc");
  assert.equal(requestEnvelope.params.file_path, "/tmp/y.txt");
  const approvalRequestId = requestEnvelope.id;

  // iOS replies via the bridge: outbound JSON-RPC response with decision:"accept"
  translator.outbound(JSON.stringify({
    id: approvalRequestId,
    result: { decision: "accept" },
  }));
  await new Promise((r) => setImmediate(r));

  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].method, "POST");
  assert.equal(httpCalls[0].pathName, "/session/ses_perm/permissions/perm_abc");
  assert.equal(httpCalls[0].body.response, "once");
});

test("permission decline maps decision:'decline' to opencode response:'reject'", async () => {
  const httpCalls = [];
  const injected = [];
  const transport = {
    describe: () => "fake",
    send() {},
    httpRequest(method, pathName, body) {
      httpCalls.push({ method, pathName, body });
      return Promise.resolve({ status: 200, json: { ok: true } });
    },
  };
  const translator = createOpencodeTranslator({
    injectInbound: (line) => injected.push(line),
    transport,
    env: process.env,
  });
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_decline", input: [{ type: "text", text: "go" }] },
  }));
  translator.inbound(JSON.stringify({
    type: "permission.asked",
    properties: { sessionID: "ses_decline", info: { id: "perm_x", sessionID: "ses_decline", permission: "command" } },
  }));
  const env = parseInjected(injected).find((e) => e.method?.endsWith("requestApproval"));
  translator.outbound(JSON.stringify({ id: env.id, result: { decision: "decline" } }));
  await new Promise((r) => setImmediate(r));
  assert.equal(httpCalls[httpCalls.length - 1].body.response, "reject");
});

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

test("opencode read tool emits item/started + item/completed with file_path", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_read", input: [{ type: "text", text: "read it" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_read",
      part: {
        type: "tool", tool: "read", id: "prt_r", messageID: "msg_r",
        state: { input: { file_path: "/tmp/x.txt" }, status: "running" },
      },
    },
  }));
  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_read",
      part: {
        type: "tool", tool: "read", id: "prt_r", messageID: "msg_r",
        state: { input: { file_path: "/tmp/x.txt" }, status: "completed", output: "hello" },
      },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const started = events.find((e) => e.method === "item/started");
  const delta = events.find((e) => e.method === "item/toolCall/outputDelta");
  const completed = events.find((e) => e.method === "item/completed");
  assert.equal(started.params.item.type, "file_read");
  assert.equal(started.params.item.file_path, "/tmp/x.txt");
  assert.equal(delta.params.delta, "hello");
  assert.equal(completed.params.item.status, "completed");
});

test("opencode edit tool emits file_change with output delta", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_edit", input: [{ type: "text", text: "edit it" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_edit",
      part: {
        type: "tool", tool: "edit", id: "prt_e", messageID: "msg_e",
        state: {
          input: { file_path: "/tmp/y.txt", old_string: "a", new_string: "b" },
          status: "completed", output: "updated y.txt",
        },
      },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const started = events.find((e) => e.method === "item/started");
  const fileDelta = events.find((e) => e.method === "item/fileChange/outputDelta");
  const completed = events.find((e) => e.method === "item/completed");
  assert.equal(started.params.item.type, "file_change");
  assert.equal(started.params.item.tool, "edit");
  assert.equal(fileDelta.params.delta, "updated y.txt");
  assert.equal(completed.params.item.status, "completed");
});

test("tui.toast.show emits system/notice with severity + title", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_t", input: [{ type: "text", text: "x" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "tui.toast.show",
    properties: {
      title: "MCP Authentication Required",
      message: "Server linear requires auth",
      variant: "warning",
      duration: 8000,
    },
  }));

  const ev = parseInjected(injected).find((e) => e.method === "system/notice");
  assert.ok(ev);
  assert.equal(ev.params.severity, "warning");
  assert.equal(ev.params.title, "MCP Authentication Required");
});

test("patch part emits turn/diff/updated and file_change item", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_p", input: [{ type: "text", text: "patch" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_p",
      part: {
        type: "patch", id: "prt_p", messageID: "msg_p",
        file_path: "/tmp/z.txt",
        diff: "@@ -1 +1 @@\n-old\n+new",
      },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const diff = events.find((e) => e.method === "turn/diff/updated");
  const started = events.find((e) => e.method === "item/started");
  const out = events.find((e) => e.method === "item/fileChange/outputDelta");
  assert.equal(diff.params.diff[0].file, "/tmp/z.txt");
  assert.equal(started.params.item.type, "file_change");
  assert.match(out.params.delta, /\+new/);
});

test("opencode webfetch tool emits a background_event with descriptive message", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_wf", input: [{ type: "text", text: "fetch" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_wf",
      part: {
        type: "tool", tool: "webfetch", id: "prt_wf", messageID: "msg_wf",
        state: { input: { url: "https://example.com" }, status: "running" },
      },
    },
  }));

  const ev = parseInjected(injected).find((e) => e.method === "codex/event/background_event");
  assert.equal(ev.params.message, "Fetching https://example.com");
});

test("turn/start image attachment uses opencode {type:'file', mediaType, url} schema", () => {
  const { translator, httpCalls } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu-img", method: "turn/start",
    params: {
      threadId: "ses_img",
      input: [
        { type: "image", image_url: "data:image/jpeg;base64,/9j/" },
        { type: "text", text: "describe" },
      ],
    },
  }));

  const body = httpCalls[0].body;
  const filePart = body.parts.find((p) => p.type === "file");
  assert.ok(filePart);
  assert.equal(filePart.mediaType, "image/jpeg");
  assert.equal(filePart.url, "data:image/jpeg;base64,/9j/");
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

test("assistant deltas continue to flow while an approval request is pending", () => {
  // Race scenario: iOS may take seconds/minutes to respond to permission.asked.
  // During that window, opencode's SSE keeps pushing assistant deltas
  // (model is still talking) and other events. The translator must keep
  // forwarding them — blocking would freeze the UI until the user decides.
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_ar", input: [{ type: "text", text: "do" }] },
  }));
  injected.length = 0;

  // 1) Assistant emits some text before the permission ask.
  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_ar",
      part: { type: "text", text: "Reading", id: "prt_1", messageID: "msg_1" },
    },
  }));

  // 2) opencode asks for permission mid-flight.
  translator.inbound(JSON.stringify({
    type: "permission.asked",
    properties: {
      sessionID: "ses_ar",
      info: { id: "perm_1", sessionID: "ses_ar", permission: "edit", metadata: { filepath: "/tmp/z" } },
    },
  }));

  // 3) Without iOS responding yet, more assistant text arrives.
  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_ar",
      part: { type: "text", text: "Reading file...", id: "prt_1", messageID: "msg_1" },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const approval = events.find((e) => e.method?.endsWith("requestApproval"));
  const deltas = events.filter((e) => e.method === "item/agentMessage/delta");
  assert.ok(approval, "approval request must still be emitted");
  assert.equal(deltas.length, 2, "both pre- and post-approval deltas must propagate");
  assert.equal(deltas[0].params.delta, "Reading");
  // Differential delta: only the new suffix after the first chunk.
  assert.equal(deltas[1].params.delta, " file...");
});

test("an approval reply with an unknown id is dropped, not POSTed", async () => {
  // Defensive: if iOS sends a stale or misrouted approval response (e.g. an
  // id from a prior thread that the translator never issued), the shim
  // must NOT forward it to opencode's /permissions endpoint — that would
  // act on the wrong permission record on the server side.
  const { translator, httpCalls } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_drop", input: [{ type: "text", text: "go" }] },
  }));
  httpCalls.length = 0;

  translator.outbound(JSON.stringify({
    id: "approval_unknown_999",
    result: { decision: "accept" },
  }));
  await new Promise((r) => setImmediate(r));

  const permPosts = httpCalls.filter((c) => c.pathName.includes("/permissions/"));
  assert.equal(permPosts.length, 0, "unknown approval id must not POST to /permissions");
});
