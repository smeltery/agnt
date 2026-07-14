const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createClaudeTranslator } = require("./translate-test-helpers");

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
