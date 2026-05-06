// FILE: claude-transport.test.js
// Purpose: Verify the Claude transport applies the right CLI flags by default
//          and supports soft turn interrupt with auto-respawn.
// Layer: Unit test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createClaudeTransport, DEFAULT_ARGS } = require("../src/providers/claude/transport");

function makeFakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killedSignal = null;
  child.stdin = new (require("stream").PassThrough)();
  child.stdin.destroyed = false;
  child.stdin.writableEnded = false;
  Object.defineProperty(child.stdin, "writable", { value: true, configurable: true });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.killedSignal = signal;
    child.exitCode = 130;
    setImmediate(() => child.emit("close", 130, signal));
  };
  return child;
}

test("DEFAULT_ARGS includes --print and --include-partial-messages", () => {
  assert.ok(DEFAULT_ARGS.includes("--print"));
  assert.ok(DEFAULT_ARGS.includes("--include-partial-messages"));
  assert.ok(DEFAULT_ARGS.includes("stream-json"));
});

test("interruptTurn kills the child and the next send respawns with --resume", () => {
  const spawnCalls = [];
  let activeChild = null;

  function spawnImpl(_bin, args /* , opts */) {
    spawnCalls.push(args);
    activeChild = makeFakeChild();
    setImmediate(() => activeChild.emit("spawn"));
    return activeChild;
  }

  const transport = createClaudeTransport({
    binPath: "/usr/local/bin/claude",
    spawnImpl,
  });

  // First spawn happens at construction.
  assert.equal(spawnCalls.length, 1);
  assert.ok(!spawnCalls[0].includes("--resume"));

  // Translator publishes a session_id for resume.
  transport.setResumeSessionId("sess-xyz");

  // Interrupt drops the child reference.
  transport.interruptTurn();
  assert.equal(activeChild.killedSignal, "SIGINT");

  // Next send() respawns with --resume <sessionId>.
  transport.send('{"type":"user","message":{"role":"user","content":"again"}}');
  assert.equal(spawnCalls.length, 2);
  const respawnArgs = spawnCalls[1];
  const idx = respawnArgs.indexOf("--resume");
  assert.ok(idx >= 0);
  assert.equal(respawnArgs[idx + 1], "sess-xyz");
});

test("setTurnArgs layers extra flags onto the next spawn", () => {
  const spawnCalls = [];
  function spawnImpl(_bin, args) {
    spawnCalls.push(args);
    const child = makeFakeChild();
    setImmediate(() => child.emit("spawn"));
    return child;
  }

  const transport = createClaudeTransport({
    binPath: "/usr/local/bin/claude",
    spawnImpl,
  });

  transport.setTurnArgs(["--model", "sonnet", "--permission-mode", "plan"]);
  transport.interruptTurn();
  transport.send('{"type":"user","message":{"role":"user","content":"x"}}');

  const respawnArgs = spawnCalls[1];
  assert.ok(respawnArgs.includes("--model"));
  assert.ok(respawnArgs.includes("sonnet"));
  assert.ok(respawnArgs.includes("--permission-mode"));
  assert.ok(respawnArgs.includes("plan"));
});

test("setCwd respawns with the new working directory", () => {
  const spawnCalls = [];
  function spawnImpl(_bin, args, opts) {
    spawnCalls.push({ args, cwd: opts.cwd });
    const child = makeFakeChild();
    setImmediate(() => child.emit("spawn"));
    return child;
  }

  const transport = createClaudeTransport({
    binPath: "/usr/local/bin/claude",
    spawnImpl,
    cwd: "/tmp/initial",
  });
  assert.equal(spawnCalls[0].cwd, "/tmp/initial");

  transport.setCwd("/tmp/elsewhere");
  transport.send('{"type":"user","message":{"role":"user","content":"x"}}');
  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls[1].cwd, "/tmp/elsewhere");
});

test("post-interrupt close events do not surface to the bridge", () => {
  const closes = [];
  let activeChild = null;

  function spawnImpl() {
    activeChild = makeFakeChild();
    setImmediate(() => activeChild.emit("spawn"));
    return activeChild;
  }

  const transport = createClaudeTransport({
    binPath: "/usr/local/bin/claude",
    spawnImpl,
  });
  transport.onClose((info) => closes.push(info));

  transport.interruptTurn();

  return new Promise((resolve) => {
    setImmediate(() => {
      assert.equal(closes.length, 0, "interrupt-induced close must not bubble");
      resolve();
    });
  });
});
