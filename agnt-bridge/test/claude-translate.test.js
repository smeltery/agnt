// FILE: claude-translate.test.js
// Purpose: Verify the Claude stream-json <-> Codex JSON-RPC translator handles
//          the full happy-path turn:
//          - thread/start synthesizes a thread response
//          - turn/start writes a stream-json user message and emits turn/started
//          - system.init binds session_id and respawns are wired via setResumeSessionId
//          - stream_event content_block_delta events emit the right deltas
//          - consolidated `assistant` frame is the source of truth for tool_use
//          - rate_limit_event surfaces as thread/status/changed
//          - turn/interrupt calls transport.interruptTurn and synthesizes events
//          - thread/read & thread/turns/list reconstruct from disk rollout
// Layer: Unit test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createClaudeTranslator } = require("../src/providers/claude/translate");

function setupTranslator() {
  const injected = [];
  const transportCalls = [];
  const transport = {
    send() {},
    describe: () => "fake",
    setResumeSessionId(id) { transportCalls.push(["resume", id]); },
    setCwd(cwd) { transportCalls.push(["cwd", cwd]); },
    interruptTurn() { transportCalls.push(["interrupt"]); },
  };
  const translator = createClaudeTranslator({
    injectInbound: (line) => injected.push(line),
    transport,
    env: process.env,
  });
  return { translator, injected, transport, transportCalls };
}

function parseInjected(injected) {
  return injected.map((line) => JSON.parse(line));
}

test("thread/start synthesizes a thread response and emits thread/started", () => {
  const { translator, injected, transportCalls } = setupTranslator();
  const result = translator.outbound(JSON.stringify({
    id: "req-1",
    method: "thread/start",
    params: { cwd: "/tmp/work" },
  }));
  assert.equal(result, null);

  const events = parseInjected(injected);
  assert.equal(events.length, 2);
  assert.equal(events[0].id, "req-1");
  assert.match(events[0].result.thread.id, /^thr_/);
  assert.equal(events[0].result.thread.cwd, "/tmp/work");
  assert.equal(events[1].method, "thread/started");
  // The translator must publish the cwd to the transport so respawns honor it.
  assert.deepEqual(transportCalls[0], ["cwd", "/tmp/work"]);
});

test("turn/start emits a Claude user line, acks the request, and emits turn/started", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts-1", method: "thread/start", params: {} }));
  injected.length = 0;

  const out = translator.outbound(JSON.stringify({
    id: "tu-1",
    method: "turn/start",
    params: { threadId: "thr_test", input: [{ type: "text", text: "hi there" }] },
  }));
  assert.ok(Array.isArray(out));
  const claudeLine = JSON.parse(out[0]);
  assert.equal(claudeLine.type, "user");
  assert.equal(claudeLine.message.role, "user");
  assert.equal(claudeLine.message.content, "hi there");

  const events = parseInjected(injected);
  assert.equal(events[0].id, "tu-1");
  assert.match(events[0].result.turnId, /^turn_/);
  assert.equal(events[1].method, "turn/started");
});

test("turn/start with image attachment emits structured content array", () => {
  const { translator } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));

  const out = translator.outbound(JSON.stringify({
    id: "tu-img",
    method: "turn/start",
    params: {
      threadId: "thr_img",
      input: [
        { type: "image", image_url: "data:image/png;base64,AAAA" },
        { type: "text", text: "describe this" },
      ],
    },
  }));

  const claudeLine = JSON.parse(out[0]);
  assert.ok(Array.isArray(claudeLine.message.content));
  assert.equal(claudeLine.message.content[0].type, "text");
  assert.equal(claudeLine.message.content[1].type, "image");
  assert.deepEqual(claudeLine.message.content[1].source, {
    type: "base64", media_type: "image/png", data: "AAAA",
  });
});

test("system.init publishes session_id to transport for respawn", () => {
  const { translator, injected, transportCalls } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  injected.length = 0;
  transportCalls.length = 0;

  translator.inbound(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-abc",
    cwd: "/tmp/x",
  }));
  assert.deepEqual(transportCalls[0], ["resume", "sess-abc"]);
  // thread/started already fired during thread/start; init must not duplicate.
  assert.equal(injected.length, 0);
});

test("stream_event content_block_delta text → item/started + item/agentMessage/delta", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_x", input: [{ type: "text", text: "hi" }] },
  }));
  injected.length = 0;

  // Simulate the canonical stream:
  //   message_start → content_block_start(text) → 2x content_block_delta → content_block_stop → message_stop
  translator.inbound(JSON.stringify({
    type: "stream_event",
    event: { type: "message_start", message: { id: "msg-1", role: "assistant" } },
  }));
  translator.inbound(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  }));
  translator.inbound(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
  }));
  translator.inbound(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world!" } },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  assert.equal(events[0].method, "item/started");
  assert.equal(events[0].params.item.type, "assistant_message");
  assert.equal(events[1].method, "item/agentMessage/delta");
  assert.equal(events[1].params.delta, "Hello ");
  assert.equal(events[2].method, "item/agentMessage/delta");
  assert.equal(events[2].params.delta, "world!");
  assert.equal(events[1].params.itemId, events[2].params.itemId);
});

test("stream_event content_block_delta thinking → item/reasoning/textDelta", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_y", input: [{ type: "text", text: "?" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "stream_event",
    event: { type: "message_start", message: { id: "msg-2", role: "assistant" } },
  }));
  translator.inbound(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
  }));
  translator.inbound(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "considering options" } },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  assert.equal(events[0].method, "item/started");
  assert.equal(events[0].params.item.type, "reasoning");
  assert.equal(events[1].method, "item/reasoning/textDelta");
  assert.equal(events[1].params.delta, "considering options");
});

test("consolidated assistant frame is a fallback delta when stream_events are missing", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_z", input: [{ type: "text", text: "hi" }] },
  }));
  injected.length = 0;

  // No stream_event frames — only the consolidated assistant snapshot.
  translator.inbound(JSON.stringify({
    type: "assistant",
    message: { id: "msg-3", content: [{ type: "text", text: "Hi!" }] },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  assert.equal(events[0].method, "item/started");
  assert.equal(events[1].method, "item/agentMessage/delta");
  assert.equal(events[1].params.delta, "Hi!");
});

test("Bash tool_use (consolidated) + tool_result → exec_command_begin/end", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_b", input: [{ type: "text", text: "ls" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "assistant",
    message: {
      id: "msg-4",
      content: [{
        type: "tool_use",
        id: "toolu-1",
        name: "Bash",
        input: { command: "ls -la", cwd: "/tmp" },
      }],
    },
  }));
  translator.inbound(JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "file1\nfile2\n" }],
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const begin = events.find((e) => e.method === "codex/event/exec_command_begin");
  const outDelta = events.find((e) => e.method === "codex/event/exec_command_output_delta");
  const end = events.find((e) => e.method === "codex/event/exec_command_end");
  assert.equal(begin.params.command, "ls -la");
  assert.equal(outDelta.params.chunk, "file1\nfile2\n");
  assert.equal(end.params.status, "completed");
});

test("rate_limit_event surfaces as thread/status/changed", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 1778069400,
      rateLimitType: "five_hour",
      isUsingOverage: false,
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method === "thread/status/changed");
  assert.equal(events[0].params.status.type, "rateLimited");
  assert.equal(events[0].params.status.rateLimit.type, "five_hour");
  assert.equal(events[0].params.status.rateLimit.resetsAt, 1778069400);
});

test("result frame emits final agent_message + item/completed + turn/completed", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_q", input: [{ type: "text", text: "say hi" }] },
  }));
  // Simulate the canonical text stream.
  translator.inbound(JSON.stringify({
    type: "stream_event",
    event: { type: "message_start", message: { id: "msg-5", role: "assistant" } },
  }));
  translator.inbound(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  }));
  translator.inbound(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi!" } },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Hi!",
    session_id: "sess-q",
    duration_ms: 500,
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 6,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 100,
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const agent = events.find((e) => e.method === "codex/event/agent_message");
  const completed = events.find((e) => e.method === "item/completed");
  const tokenUsage = events.find((e) => e.method === "thread/tokenUsage/updated");
  const turnDone = events.find((e) => e.method === "turn/completed");
  assert.equal(agent.params.message, "Hi!");
  assert.equal(completed.params.item.type, "assistant_message");
  assert.equal(tokenUsage.params.tokenUsage.inputTokens, 6);
  assert.ok(turnDone);
});

test("thread/turns/list reconstructs from disk rollout under CLAUDE_HOME", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-claude-shim-"));
  const projectsDir = path.join(tmpHome, "projects", "-tmp-test");
  fs.mkdirSync(projectsDir, { recursive: true });
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const sessionFile = path.join(projectsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: "user", message: { role: "user", content: "hello" }, uuid: "u-1" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi back" }] }, uuid: "u-2" }),
  ].join("\n"));

  const injected = [];
  const translator = createClaudeTranslator({
    injectInbound: (line) => injected.push(line),
    transport: { send() {}, describe: () => "fake" },
    env: { ...process.env, CLAUDE_HOME: tmpHome },
  });

  translator.outbound(JSON.stringify({
    id: "list-1",
    method: "thread/turns/list",
    params: { threadId: sessionId },
  }));

  const events = injected.map((line) => JSON.parse(line));
  assert.equal(events[0].id, "list-1");
  assert.equal(events[0].result.turns.length, 1);
  assert.equal(events[0].result.turns[0].input[0].text, "hello");
  assert.equal(events[0].result.turns[0].items[0].text, "hi back");

  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("turn/interrupt calls transport.interruptTurn() AND emits synthetic events", () => {
  const { translator, injected, transportCalls } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_int", input: [{ type: "text", text: "go" }] },
  }));
  injected.length = 0;
  transportCalls.length = 0;

  translator.outbound(JSON.stringify({
    id: "int-1",
    method: "turn/interrupt",
    params: { threadId: "thr_int" },
  }));

  const events = injected.map((line) => JSON.parse(line));
  const ack = events.find((e) => e.id === "int-1");
  const failed = events.find((e) => e.method === "turn/failed");
  const completed = events.find((e) => e.method === "turn/completed");
  assert.ok(ack);
  assert.equal(failed.params.error.message, "interrupted by user");
  assert.ok(completed);
  // Critical: the transport must actually be told to kill the active child.
  assert.deepEqual(transportCalls[0], ["interrupt"]);
});

test("unsupported methods get a JSON-RPC error response", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "steer-1",
    method: "turn/steer",
    params: { threadId: "thr_x" },
  }));
  const events = injected.map((line) => JSON.parse(line));
  assert.equal(events[0].id, "steer-1");
  assert.equal(events[0].error.code, -32601);
});
