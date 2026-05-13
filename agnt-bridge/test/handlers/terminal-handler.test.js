// FILE: terminal-handler.test.js
// Purpose: Pins the JSON-RPC contract and gating behavior of the bridge-side
//          local-PTY terminal handler used by the web client.
// Layer: Unit test
// Depends on: node:test, node:assert/strict, ../../src/handlers/terminal-handler

const test = require("node:test");
const assert = require("node:assert/strict");

const { createTerminalHandler } = require("../../src/handlers/terminal-handler");

function makeFakePty({ scriptedOutputBytes = [] } = {}) {
  const writes = [];
  const resizes = [];
  let killed = false;
  const dataListeners = [];
  const exitListeners = [];

  const child = {
    onData(fn) {
      dataListeners.push(fn);
    },
    onExit(fn) {
      exitListeners.push(fn);
    },
    write(input) {
      writes.push(input);
    },
    resize(cols, rows) {
      resizes.push({ cols, rows });
    },
    kill() {
      killed = true;
      // Mirror node-pty: emit exit on kill.
      exitListeners.forEach((fn) => fn({ exitCode: 0, signal: "SIGTERM" }));
    },
  };

  const pty = {
    spawn() {
      // Drain any scripted bytes asynchronously after the test's first await.
      queueMicrotask(() => {
        scriptedOutputBytes.forEach((bytes) => {
          dataListeners.forEach((fn) => fn(Buffer.from(bytes).toString("utf8")));
        });
      });
      return child;
    },
  };

  return { pty, child, writes, resizes, isKilled: () => killed };
}

async function dispatch(handler, message) {
  const responses = [];
  handler.handleTerminalRequest(JSON.stringify(message), (raw) => responses.push(raw));
  // handler-utils dispatches via Promise.resolve().then(...); flush microtasks
  // and one task tick so the response (or error envelope) settles.
  await new Promise((resolve) => setImmediate(resolve));
  return responses.map((raw) => JSON.parse(raw));
}

test("terminal/* requests are rejected when the web terminal preference is off", async () => {
  const handler = createTerminalHandler({
    isEnabled: () => false,
    sendApplicationResponse: () => {},
    ptyImpl: { spawn: () => assert.fail("must not spawn when disabled") },
  });

  const responses = await dispatch(handler, {
    id: "1",
    method: "terminal/open",
    params: { cols: 80, rows: 24 },
  });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.data.errorCode, "terminal_disabled");
  assert.equal(responses[0].id, "1");
});

test("terminal/open spawns a PTY and returns a snapshot with running status", async () => {
  const { pty, child } = makeFakePty();
  const sent = [];
  const handler = createTerminalHandler({
    isEnabled: () => true,
    sendApplicationResponse: (raw) => sent.push(raw),
    ptyImpl: pty,
    cwdProvider: () => "/tmp",
  });

  const [response] = await dispatch(handler, {
    id: "open-1",
    method: "terminal/open",
    params: { terminalId: "term-1", cols: 100, rows: 30, cwd: "/tmp/work" },
  });

  assert.equal(response.id, "open-1");
  assert.equal(response.result.terminalId, "term-1");
  assert.equal(response.result.status, "running");
  assert.equal(response.result.cols, 100);
  assert.equal(response.result.rows, 30);
  assert.equal(response.result.cwd, "/tmp/work");
  assert.equal(response.result.resizeSupported, true);
  // child is alive
  assert.ok(child);
});

test("PTY output is forwarded as terminal/output notifications", async () => {
  const { pty } = makeFakePty({ scriptedOutputBytes: ["hello\n", "world\n"] });
  const sent = [];
  const handler = createTerminalHandler({
    isEnabled: () => true,
    sendApplicationResponse: (raw) => sent.push(JSON.parse(raw)),
    ptyImpl: pty,
  });

  await dispatch(handler, { id: "1", method: "terminal/open", params: {} });
  await new Promise((resolve) => setImmediate(resolve));

  const outputs = sent.filter((m) => m.method === "terminal/output");
  assert.equal(outputs.length, 2);
  assert.equal(Buffer.from(outputs[0].params.dataBase64, "base64").toString(), "hello\n");
  assert.equal(Buffer.from(outputs[1].params.dataBase64, "base64").toString(), "world\n");
  assert.equal(outputs[0].params.terminalId, "term-1");
  assert.ok(outputs[0].params.instanceId.startsWith("inst-"));
});

test("terminal/write decodes base64 input and forwards to the PTY as utf8", async () => {
  const { pty, writes } = makeFakePty();
  const handler = createTerminalHandler({
    isEnabled: () => true,
    sendApplicationResponse: () => {},
    ptyImpl: pty,
  });

  await dispatch(handler, { id: "1", method: "terminal/open", params: {} });
  const inputBytes = Buffer.from("ls -la\n", "utf8");
  await dispatch(handler, {
    id: "2",
    method: "terminal/write",
    params: { terminalId: "term-1", dataBase64: inputBytes.toString("base64") },
  });

  assert.deepEqual(writes, ["ls -la\n"]);
});

test("terminal/write before terminal/open returns terminal_not_running", async () => {
  const handler = createTerminalHandler({
    isEnabled: () => true,
    sendApplicationResponse: () => {},
    ptyImpl: { spawn: () => assert.fail("must not spawn for write before open") },
  });
  const [response] = await dispatch(handler, {
    id: "9",
    method: "terminal/write",
    params: { dataBase64: Buffer.from("x").toString("base64") },
  });
  assert.equal(response.error.data.errorCode, "terminal_not_running");
});

test("terminal/resize forwards new dimensions to the PTY when running", async () => {
  const { pty, resizes } = makeFakePty();
  const handler = createTerminalHandler({
    isEnabled: () => true,
    sendApplicationResponse: () => {},
    ptyImpl: pty,
  });

  await dispatch(handler, { id: "1", method: "terminal/open", params: { cols: 80, rows: 24 } });
  await dispatch(handler, {
    id: "2",
    method: "terminal/resize",
    params: { terminalId: "term-1", cols: 120, rows: 40 },
  });

  assert.deepEqual(resizes, [{ cols: 120, rows: 40 }]);
});

test("terminal/close kills the PTY and clears state", async () => {
  const { pty, isKilled } = makeFakePty();
  const handler = createTerminalHandler({
    isEnabled: () => true,
    sendApplicationResponse: () => {},
    ptyImpl: pty,
  });

  await dispatch(handler, { id: "1", method: "terminal/open", params: {} });
  await dispatch(handler, { id: "2", method: "terminal/close", params: {} });
  assert.equal(isKilled(), true);
});

test("terminal/snapshot returns idle for an unknown terminal id", async () => {
  const handler = createTerminalHandler({
    isEnabled: () => true,
    sendApplicationResponse: () => {},
    ptyImpl: { spawn: () => assert.fail("must not spawn for snapshot") },
  });

  const [response] = await dispatch(handler, {
    id: "1",
    method: "terminal/snapshot",
    params: { terminalId: "term-7" },
  });
  assert.equal(response.result.terminalId, "term-7");
  assert.equal(response.result.status, "idle");
  assert.equal(response.result.historyBase64, "");
});

test("non-terminal methods are passed through (handler returns false)", () => {
  const handler = createTerminalHandler({
    isEnabled: () => true,
    sendApplicationResponse: () => {},
    ptyImpl: { spawn: () => assert.fail("must not spawn for unrelated method") },
  });
  const claimed = handler.handleTerminalRequest(
    JSON.stringify({ id: "1", method: "thread/list", params: {} }),
    () => assert.fail("must not respond to non-terminal method"),
  );
  assert.equal(claimed, false);
});
