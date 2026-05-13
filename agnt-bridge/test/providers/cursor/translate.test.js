// FILE: cursor-translate.test.js
// Purpose: Verify the Cursor stream-json <-> Codex JSON-RPC translator handles
//          the full happy-path turn:
//          - thread/start synthesizes a thread response and emits thread/started
//          - turn/start emits a {type:"prompt",text} frame for the transport,
//            acks the JSON-RPC request, and emits turn/started
//          - system.init seeds session_id + emits thread/initialized
//          - any inbound session_id is published to setResumeSessionId so the
//            next spawn can --resume
//          - assistant frames produce stable item/agentMessage/delta deltas
//            (cumulative text → diffed against the running accumulator)
//          - tool_call.started + tool_call.completed for shell, read, write,
//            edit, grep, glob, ls map to the right Codex events
//          - result frame finalizes agent_message + item/completed + turn/completed
//          - turn/interrupt calls transport.interruptTurn AND synthesizes events
//          - thread/turns/list reconstructs from ~/.cursor/chats/*.jsonl
//          - turn/start.params.model becomes --model X via setTurnArgs
//          - overlapping turn/start is rejected with JSON-RPC code -32003
// Layer: Unit test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createCursorTranslator } = require("../../../src/providers/cursor/translate");

function setupTranslator(envOverride = {}) {
  const injected = [];
  const transportCalls = [];
  const transport = {
    send() {},
    describe: () => "fake",
    setResumeSessionId(id) { transportCalls.push(["resume", id]); },
    setCwd(cwd) { transportCalls.push(["cwd", cwd]); },
    setTurnArgs(args) { transportCalls.push(["turnArgs", args.slice()]); },
    interruptTurn() { transportCalls.push(["interrupt"]); },
  };
  const translator = createCursorTranslator({
    injectInbound: (line) => injected.push(line),
    transport,
    env: { ...process.env, ...envOverride },
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
  // The translator must publish the cwd to the transport so the next spawn
  // honors it.
  assert.deepEqual(transportCalls[0], ["cwd", "/tmp/work"]);
});

test("turn/start emits a {type:'prompt',text} frame, acks the request, and emits turn/started", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  injected.length = 0;

  const out = translator.outbound(JSON.stringify({
    id: "tu-1",
    method: "turn/start",
    params: { threadId: "thr_test", input: [{ type: "text", text: "hi there" }] },
  }));
  assert.ok(Array.isArray(out));
  const frame = JSON.parse(out[0]);
  assert.equal(frame.type, "prompt");
  assert.equal(frame.text, "hi there");

  const events = parseInjected(injected);
  assert.equal(events[0].id, "tu-1");
  assert.match(events[0].result.turnId, /^turn_/);
  assert.equal(events[1].method, "turn/started");
});

test("turn/start joins multi-text input items with newlines", () => {
  const { translator } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));

  const out = translator.outbound(JSON.stringify({
    id: "tu-multi",
    method: "turn/start",
    params: {
      threadId: "thr_multi",
      input: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    },
  }));
  const frame = JSON.parse(out[0]);
  assert.equal(frame.type, "prompt");
  assert.equal(frame.text, "line one\nline two");
});

test("turn/start with empty input does not crash and finalizes the turn", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  injected.length = 0;

  const out = translator.outbound(JSON.stringify({
    id: "tu-empty",
    method: "turn/start",
    params: { threadId: "thr_empty", input: [] },
  }));
  assert.equal(out, null);

  const events = parseInjected(injected).filter((e) => e.method);
  assert.ok(events.some((e) => e.method === "turn/failed"));
  assert.ok(events.some((e) => e.method === "turn/completed"));
});

test("overlapping turn/start is rejected with JSON-RPC error -32003", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu-1", method: "turn/start",
    params: { threadId: "thr_x", input: [{ type: "text", text: "hi" }] },
  }));
  injected.length = 0;

  translator.outbound(JSON.stringify({
    id: "tu-2", method: "turn/start",
    params: { threadId: "thr_x", input: [{ type: "text", text: "hi again" }] },
  }));
  const events = parseInjected(injected);
  const errorAck = events.find((e) => e.id === "tu-2");
  assert.ok(errorAck.error);
  assert.equal(errorAck.error.code, -32003);
});

test("any inbound session_id is published to transport.setResumeSessionId", () => {
  const { translator, injected, transportCalls } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  injected.length = 0;
  transportCalls.length = 0;

  translator.inbound(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-abc",
    cwd: "/tmp/x",
    model: "gpt-5",
    permissionMode: "default",
  }));
  // Find the resume call — there may also be a thread/started suppression.
  const resumeCall = transportCalls.find((c) => c[0] === "resume");
  assert.deepEqual(resumeCall, ["resume", "sess-abc"]);

  // A subsequent assistant frame with the same session_id should NOT republish.
  transportCalls.length = 0;
  translator.inbound(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    session_id: "sess-abc",
  }));
  assert.equal(transportCalls.find((c) => c[0] === "resume"), undefined);

  // But a NEW session_id must republish.
  translator.inbound(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "more" }] },
    session_id: "sess-xyz",
  }));
  const second = transportCalls.find((c) => c[0] === "resume");
  assert.deepEqual(second, ["resume", "sess-xyz"]);
});

test("system.init emits thread/started + thread/initialized with provider=cursor", () => {
  const { translator, injected } = setupTranslator();
  // No prior thread/start, so system.init is the first signal.
  translator.inbound(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "sess-init",
    cwd: "/tmp/work",
    model: "gpt-5",
    permissionMode: "default",
    apiKeySource: "login",
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const started = events.find((e) => e.method === "thread/started");
  const initialized = events.find((e) => e.method === "thread/initialized");
  assert.ok(started);
  assert.ok(initialized);
  assert.equal(initialized.params.provider, "cursor");
  assert.equal(initialized.params.model, "gpt-5");
  assert.equal(initialized.params.cwd, "/tmp/work");
  // cursor-agent's init does not list tools, so the shim seeds a default set.
  assert.ok(Array.isArray(initialized.params.tools));
  assert.ok(initialized.params.tools.includes("shell"));
});

test("assistant frames produce a stable item id and incremental deltas", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_a", input: [{ type: "text", text: "hi" }] },
  }));
  injected.length = 0;

  // cursor emits cumulative assistant snapshots; the shim slices off the
  // running accumulator so the bridge sees stable deltas.
  translator.inbound(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    session_id: "sess-1",
  }));
  translator.inbound(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Hello world!" }] },
    session_id: "sess-1",
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const started = events.find((e) => e.method === "item/started");
  const deltas = events.filter((e) => e.method === "item/agentMessage/delta");
  assert.ok(started);
  assert.equal(started.params.item.type, "assistant_message");
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].params.delta, "Hello");
  assert.equal(deltas[1].params.delta, " world!");
  assert.equal(deltas[0].params.itemId, deltas[1].params.itemId);
});

test("shellToolCall start+complete maps to exec_command_begin/output_delta/end", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_sh", input: [{ type: "text", text: "ls" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "call-1",
    tool_call: {
      shellToolCall: {
        args: { command: "ls -la", cwd: "/tmp" },
      },
    },
    session_id: "sess-sh",
  }));
  translator.inbound(JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: "call-1",
    tool_call: {
      shellToolCall: {
        args: { command: "ls -la", cwd: "/tmp" },
        result: "file1\nfile2\n",
      },
    },
    session_id: "sess-sh",
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const begin = events.find((e) => e.method === "codex/event/exec_command_begin");
  const outDelta = events.find((e) => e.method === "codex/event/exec_command_output_delta");
  const end = events.find((e) => e.method === "codex/event/exec_command_end");
  assert.equal(begin.params.command, "ls -la");
  assert.equal(begin.params.cwd, "/tmp");
  assert.equal(outDelta.params.chunk, "file1\nfile2\n");
  assert.equal(end.params.status, "completed");
});

test("readToolCall maps to item/started + item/completed (file_read)", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_r", input: [{ type: "text", text: "read it" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "call-r",
    tool_call: {
      readToolCall: { args: { path: "/tmp/x.txt" } },
    },
    session_id: "sess-r",
  }));
  translator.inbound(JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: "call-r",
    tool_call: {
      readToolCall: { args: { path: "/tmp/x.txt" }, result: "hello world" },
    },
    session_id: "sess-r",
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const started = events.find((e) => e.method === "item/started");
  const completed = events.find((e) => e.method === "item/completed");
  assert.equal(started.params.item.type, "file_read");
  assert.equal(started.params.item.file_path, "/tmp/x.txt");
  assert.equal(completed.params.item.output, "hello world");
  assert.equal(completed.params.item.status, "completed");
});

test("writeToolCall and editToolCall map to file_change items", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_w", input: [{ type: "text", text: "write it" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "call-w",
    tool_call: {
      writeToolCall: { args: { path: "/tmp/new.txt", fileText: "body" } },
    },
    session_id: "sess-w",
  }));
  translator.inbound(JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: "call-w",
    tool_call: {
      writeToolCall: { args: { path: "/tmp/new.txt", fileText: "body" } },
    },
    session_id: "sess-w",
  }));

  translator.inbound(JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "call-e",
    tool_call: {
      editToolCall: { args: { path: "/tmp/old.txt" } },
    },
    session_id: "sess-w",
  }));
  translator.inbound(JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: "call-e",
    tool_call: {
      editToolCall: { args: { path: "/tmp/old.txt" } },
    },
    session_id: "sess-w",
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const writeStarted = events.find(
    (e) => e.method === "item/started" && e.params.item.tool === "write"
  );
  const editStarted = events.find(
    (e) => e.method === "item/started" && e.params.item.tool === "edit"
  );
  assert.equal(writeStarted.params.item.type, "file_change");
  assert.equal(writeStarted.params.item.file_path, "/tmp/new.txt");
  assert.equal(editStarted.params.item.type, "file_change");
  assert.equal(editStarted.params.item.file_path, "/tmp/old.txt");

  const writeCompleted = events.find(
    (e) => e.method === "item/completed" && e.params.itemId === "call-w"
  );
  assert.equal(writeCompleted.params.item.status, "completed");
});

test("grepToolCall maps to a generic tool_call item with query", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_g", input: [{ type: "text", text: "find foo" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "call-g",
    tool_call: {
      grepToolCall: { args: { pattern: "foo", path: "src/" } },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const started = events.find((e) => e.method === "item/started");
  assert.equal(started.params.item.type, "tool_call");
  assert.equal(started.params.item.tool, "grep");
  assert.equal(started.params.item.query, "foo");
});

test("result frame emits final agent_message + item/completed + turn/completed", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_q", input: [{ type: "text", text: "say hi" }] },
  }));
  // Stream a small assistant snapshot so the accumulator is non-empty.
  translator.inbound(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Hi!",
    session_id: "sess-q",
    duration_ms: 500,
    is_error: false,
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const agent = events.find((e) => e.method === "codex/event/agent_message");
  const completed = events.find((e) => e.method === "item/completed");
  const turnDone = events.find((e) => e.method === "turn/completed");
  assert.equal(agent.params.message, "Hi!");
  assert.equal(completed.params.item.type, "assistant_message");
  assert.ok(turnDone);
});

test("result frame with is_error=true emits turn/failed before turn/completed", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "thr_err", input: [{ type: "text", text: "boom" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "result",
    subtype: "error",
    is_error: true,
    result: "model exploded",
    session_id: "sess-err",
    duration_ms: 12,
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const failed = events.find((e) => e.method === "turn/failed");
  const completed = events.find((e) => e.method === "turn/completed");
  assert.ok(failed);
  assert.match(failed.params.error.message, /model exploded/);
  assert.ok(completed);
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
  assert.deepEqual(transportCalls[0], ["interrupt"]);
});

test("turn/start with model param translates to --model X via setTurnArgs", () => {
  const { translator, transportCalls } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  transportCalls.length = 0;

  translator.outbound(JSON.stringify({
    id: "tu-args",
    method: "turn/start",
    params: {
      threadId: "thr_args",
      input: [{ type: "text", text: "x" }],
      model: "gpt-5",
    },
  }));

  const call = transportCalls.find((c) => c[0] === "turnArgs");
  assert.ok(call, "expected setTurnArgs to be called");
  assert.deepEqual(call[1], ["--model", "gpt-5"]);
});

test("thread/turns/list reconstructs from disk under CURSOR_HOME", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-cursor-shim-"));
  const chatsDir = path.join(tmpHome, "chats");
  fs.mkdirSync(chatsDir, { recursive: true });
  const sessionId = "00000000-0000-4000-8000-000000000abc";
  const sessionFile = path.join(chatsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: "user", message: { role: "user", content: "hello" }, uuid: "u-1" }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
      uuid: "u-2",
    }),
  ].join("\n"));

  const injected = [];
  const translator = createCursorTranslator({
    injectInbound: (line) => injected.push(line),
    transport: { send() {}, describe: () => "fake" },
    env: { ...process.env, CURSOR_HOME: tmpHome },
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

test("thread/list returns summaries from CURSOR_HOME/chats", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-cursor-shim-list-"));
  const chatsDir = path.join(tmpHome, "chats");
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(path.join(chatsDir, "thread-1.jsonl"), JSON.stringify({ type: "user" }));
  fs.writeFileSync(path.join(chatsDir, "thread-2.jsonl"), JSON.stringify({ type: "user" }));
  // Non-jsonl file that should be ignored.
  fs.writeFileSync(path.join(chatsDir, "ignore.txt"), "not a session");

  const injected = [];
  const translator = createCursorTranslator({
    injectInbound: (line) => injected.push(line),
    transport: { send() {}, describe: () => "fake" },
    env: { ...process.env, CURSOR_HOME: tmpHome },
  });

  translator.outbound(JSON.stringify({
    id: "lst",
    method: "thread/list",
    params: {},
  }));

  const events = injected.map((line) => JSON.parse(line));
  const ids = events[0].result.threads.map((t) => t.id).sort();
  assert.deepEqual(ids, ["thread-1", "thread-2"]);

  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("turn/steer is rejected with -32601 (cursor has no mid-turn steering)", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  injected.length = 0;

  translator.outbound(JSON.stringify({
    id: "steer-1",
    method: "turn/steer",
    params: { threadId: "thr_x" },
  }));

  const events = parseInjected(injected);
  const errorAck = events.find((e) => e.id === "steer-1");
  assert.equal(errorAck.error.code, -32601);
  assert.match(errorAck.error.message, /turn\/steer/);
});

test("thread/compact acknowledges as not supported without hanging the iOS pill", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({ id: "ts", method: "thread/start", params: {} }));
  injected.length = 0;

  translator.outbound(JSON.stringify({
    id: "compact-1",
    method: "thread/compact",
    params: { threadId: "thr_x" },
  }));

  const events = parseInjected(injected);
  const ack = events.find((e) => e.id === "compact-1");
  assert.equal(ack.result.compacted, false);
  assert.equal(ack.result.reason, "cursor_cli_compact_unsupported");
});
