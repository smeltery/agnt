const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createCursorTranslator } = require("./translate-test-helpers");

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
