// FILE: contracts/cursor-spawn-per-turn.test.js
// Purpose: Locks in the Cursor transport's spawn-per-turn contract:
//          every turn spawns a fresh `cursor-agent` child, the previous
//          child is SIGTERM'd first, --force is always present (since
//          cursor-agent has no runtime approval channel in headless mode),
//          --resume <session_id> is appended when known, and per-turn
//          --model flags arrive through setTurnArgs.
// Layer: Contract test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, events, ../../src/providers/cursor/transport
//
// Why a dedicated test: the guardrail in CLAUDE.md spells out the spawn-per-turn
// model in prose ("each turn/start shuts down any previous child and spawns a
// fresh `cursor-agent -p <prompt> --output-format stream-json --force ...`")
// but the existing cursor-transport.test.js doesn't pin the SIGTERM behaviour
// or the hard-coded --force flag. Both are easy to regress when extending the
// transport (e.g. someone adds an approval channel and "softens" --force).

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createCursorTransport, DEFAULT_ARGS } = require("../../src/providers/cursor/transport");

function makeFakeChild() {
  const child = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    // emulate node's child_process: exitCode flips after kill resolves
    return true;
  };
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function makeSpawnRecorder() {
  const calls = [];
  const children = [];
  function spawnImpl(bin, args, opts) {
    const child = makeFakeChild();
    calls.push({ bin, args, opts, child });
    children.push(child);
    return child;
  }
  return { spawnImpl, calls, children };
}

function newTransport(extra = {}) {
  const recorder = makeSpawnRecorder();
  const transport = createCursorTransport({
    binPath: "/fake/cursor-agent",
    spawnImpl: recorder.spawnImpl,
    env: { PATH: "/usr/bin" },
    ...extra,
  });
  return { transport, recorder };
}

test("DEFAULT_ARGS includes -p, --output-format stream-json, and --force", () => {
  // The hard-coded --force in DEFAULT_ARGS is what allows cursor-agent to run
  // headless. If someone removes it the CLI will block waiting for TTY input
  // for every tool call, and turns will hang silently. Lock the contract.
  assert.ok(DEFAULT_ARGS.includes("-p"), "must include -p (print/headless mode)");
  assert.ok(DEFAULT_ARGS.includes("--force"), "must include --force (auto-approve tool calls)");
  const ofIdx = DEFAULT_ARGS.indexOf("--output-format");
  assert.ok(ofIdx !== -1 && DEFAULT_ARGS[ofIdx + 1] === "stream-json",
    "must specify --output-format stream-json");
});

test("each turn spawns a fresh child with --force and the prompt as the final argv", () => {
  const { transport, recorder } = newTransport();
  transport.send(JSON.stringify({ type: "prompt", text: "hello world" }));

  assert.equal(recorder.calls.length, 1, "send must spawn the CLI");
  const { bin, args } = recorder.calls[0];
  assert.equal(bin, "/fake/cursor-agent");
  assert.ok(args.includes("--force"), "every spawn must carry --force");
  assert.ok(args.includes("-p"), "every spawn must carry -p");
  const ofIdx = args.indexOf("--output-format");
  assert.equal(args[ofIdx + 1], "stream-json");
  assert.equal(args[args.length - 1], "hello world", "prompt must be the final positional arg");
});

test("a second turn SIGTERMs the prior child before respawning", () => {
  const { transport, recorder } = newTransport();
  transport.send(JSON.stringify({ type: "prompt", text: "first" }));
  const firstChild = recorder.children[0];

  transport.send(JSON.stringify({ type: "prompt", text: "second" }));
  assert.equal(recorder.children.length, 2, "second turn must spawn a fresh child");
  assert.deepEqual(
    firstChild.killCalls,
    ["SIGTERM"],
    "first child must receive SIGTERM before the second spawn",
  );
  assert.equal(recorder.calls[1].args[recorder.calls[1].args.length - 1], "second");
});

test("setResumeSessionId is appended to the spawn argv on the next turn", () => {
  const { transport, recorder } = newTransport();
  transport.setResumeSessionId("session-xyz");
  transport.send(JSON.stringify({ type: "prompt", text: "resumed prompt" }));

  const args = recorder.calls[0].args;
  const idx = args.indexOf("--resume");
  assert.ok(idx !== -1, "--resume flag must be present after setResumeSessionId");
  assert.equal(args[idx + 1], "session-xyz");
  // Sanity: prompt is still the final positional arg.
  assert.equal(args[args.length - 1], "resumed prompt");
});

test("setTurnArgs layers per-turn flags between the base args and the prompt", () => {
  const { transport, recorder } = newTransport();
  transport.setTurnArgs(["--model", "gpt-5"]);
  transport.send(JSON.stringify({ type: "prompt", text: "turned prompt" }));

  const args = recorder.calls[0].args;
  const modelIdx = args.indexOf("--model");
  assert.ok(modelIdx !== -1, "--model must be present after setTurnArgs");
  assert.equal(args[modelIdx + 1], "gpt-5");
  // --force / -p / --output-format must still be present (turn args don't replace base).
  assert.ok(args.includes("--force"));
  assert.ok(args.includes("-p"));
  assert.equal(args[args.length - 1], "turned prompt");
});

test("setTurnArgs filters out empty / non-string entries instead of forwarding them as bare argv", () => {
  // A translator that publishes a malformed flag list (e.g. ["--model", ""])
  // should not produce `--model ""` on the CLI, which cursor-agent treats as
  // a parse error.
  const { transport, recorder } = newTransport();
  transport.setTurnArgs(["--model", "", null, "--effort", "low"]);
  transport.send(JSON.stringify({ type: "prompt", text: "p" }));

  const args = recorder.calls[0].args;
  assert.ok(!args.includes(""), "empty string flags must be filtered");
  assert.ok(args.includes("--effort"));
  assert.equal(args[args.indexOf("--effort") + 1], "low");
});

test("send() ignores frames that are not the {type:'prompt', text} envelope", () => {
  // The translator converts non-prompt frames before they reach the
  // transport; defensive drop in send() prevents spurious spawns from a
  // future protocol change.
  const { transport, recorder } = newTransport();
  transport.send(JSON.stringify({ type: "user", message: { content: "x" } }));
  transport.send("not json at all");
  transport.send(JSON.stringify({ type: "prompt" })); // no text
  transport.send(JSON.stringify({ type: "prompt", text: "" })); // empty text

  assert.equal(recorder.calls.length, 0, "no spawn for non-prompt frames");
});

test("interruptTurn() SIGINTs the live child and lets the next turn spawn cleanly", () => {
  const { transport, recorder } = newTransport();
  transport.send(JSON.stringify({ type: "prompt", text: "first" }));
  const firstChild = recorder.children[0];

  transport.interruptTurn();
  assert.deepEqual(firstChild.killCalls, ["SIGINT"]);

  transport.send(JSON.stringify({ type: "prompt", text: "second" }));
  assert.equal(recorder.children.length, 2);
  // After interruptTurn dropped the reference, the prior child must NOT get
  // a follow-up SIGTERM from the new spawn — it's already SIGINT'd.
  assert.deepEqual(firstChild.killCalls, ["SIGINT"]);
});
