// FILE: provider-translator.test.js
// Purpose: Verify withTranslator wires the factory + injectInbound contract that the
//          claude/opencode shims rely on.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/providers/types

const test = require("node:test");
const assert = require("node:assert/strict");

const { withTranslator } = require("../src/providers/types");

function makeFakeTransport() {
  let messageHandler = null;
  let startedHandler = null;
  let closeHandler = null;
  let errorHandler = null;
  const sent = [];
  return {
    mode: "spawn",
    sent,
    describe: () => "fake",
    send(line) { sent.push(line); },
    onMessage(handler) { messageHandler = handler; },
    onStarted(handler) { startedHandler = handler; },
    onClose(handler) { closeHandler = handler; },
    onError(handler) { errorHandler = handler; },
    shutdown() {},
    deliverMessage(line) { messageHandler?.(line); },
    deliverStarted(info) { startedHandler?.(info); },
    deliverClose(info) { closeHandler?.(info); },
    deliverError(err) { errorHandler?.(err); },
  };
}

test("withTranslator returns the original transport when no translator is configured", () => {
  const transport = makeFakeTransport();
  const wrapped = withTranslator(transport, { id: "noop" });
  assert.equal(wrapped, transport);
});

test("withTranslator factory receives injectInbound and routes synthetic frames inbound", () => {
  const transport = makeFakeTransport();
  const provider = {
    id: "claude",
    createTranslator(ctx) {
      return {
        outbound(line) {
          if (line === "ping") {
            ctx.injectInbound("synthetic-pong");
            return null;
          }
          return line;
        },
        inbound(line) {
          return `inbound:${line}`;
        },
      };
    },
  };

  const wrapped = withTranslator(transport, provider);
  const received = [];
  wrapped.onMessage((line) => received.push(line));

  // Outbound that returns null but injects inbound.
  wrapped.send("ping");
  assert.deepEqual(transport.sent, []);
  assert.deepEqual(received, ["synthetic-pong"]);

  // Outbound that translates and forwards.
  wrapped.send("hello");
  assert.deepEqual(transport.sent, ["hello"]);

  // Inbound translation.
  transport.deliverMessage("raw-event");
  assert.deepEqual(received, ["synthetic-pong", "inbound:raw-event"]);
});

test("withTranslator forwards lifecycle hooks to translator instance", () => {
  const transport = makeFakeTransport();
  const events = [];
  const provider = {
    id: "test",
    createTranslator() {
      return {
        outbound: (l) => l,
        inbound: (l) => l,
        handleStarted: (info) => events.push(["started", info]),
        handleClose: (info) => events.push(["close", info]),
      };
    },
  };

  const wrapped = withTranslator(transport, provider);
  wrapped.onStarted(() => events.push(["bridge-started"]));
  wrapped.onClose(() => events.push(["bridge-close"]));

  transport.deliverStarted({ host: "127.0.0.1", port: 1234 });
  transport.deliverClose({ code: 0, signal: null });

  assert.deepEqual(events, [
    ["started", { host: "127.0.0.1", port: 1234 }],
    ["bridge-started"],
    ["close", { code: 0, signal: null }],
    ["bridge-close"],
  ]);
});

test("withTranslator drops outbound when translator returns null and forwards arrays as multiple frames", () => {
  const transport = makeFakeTransport();
  const provider = {
    id: "fanout",
    createTranslator() {
      return {
        outbound(line) {
          if (line === "drop") return null;
          if (line === "split") return ["a", "b", "c"];
          return line;
        },
      };
    },
  };

  const wrapped = withTranslator(transport, provider);
  wrapped.send("drop");
  wrapped.send("split");
  wrapped.send("solo");
  assert.deepEqual(transport.sent, ["a", "b", "c", "solo"]);
});

test("withTranslator survives translator errors without crashing the bridge", () => {
  const transport = makeFakeTransport();
  const provider = {
    id: "throws",
    createTranslator() {
      return {
        outbound() { throw new Error("boom"); },
        inbound() { throw new Error("boom"); },
      };
    },
  };

  const wrapped = withTranslator(transport, provider);
  const received = [];
  wrapped.onMessage((line) => received.push(line));

  wrapped.send("any");
  assert.deepEqual(transport.sent, []);
  transport.deliverMessage("raw");
  assert.deepEqual(received, []);
});
