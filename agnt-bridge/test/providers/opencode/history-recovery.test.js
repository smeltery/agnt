const assert = require("node:assert/strict");
const test = require("node:test");
const { mapMessagesToTurns } = require("../../../src/providers/opencode/mappers");
const { setupTranslator, parseInjected } = require("./translate-test-helpers");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const send = (translator, id, method, params) => translator.outbound(JSON.stringify({ id, method, params }));
const messages = [
  { info: { id: "msg_user", role: "user", time: { created: 1000 } }, parts: [
    { type: "text", text: " inspect\n" }, { type: "file", mime: "image/png", url: "data:image/png;base64,AA==" },
  ] },
  { info: { id: "msg_answer", role: "assistant", time: { created: 2000 } }, parts: [
    { id: "thought", type: "reasoning", text: " reasoning\n" },
    { id: "shell", type: "tool", tool: "bash", state: { status: "completed", input: { command: "pwd", cwd: "/project" }, output: " /project\n" } },
    { id: "part", type: "text", text: "answer " }, { id: "part2", type: "text", text: "so far" },
  ] },
];

test("saved history retains inputs, images, reasoning, tool results and live item identities", () => {
  const [turn] = mapMessagesToTurns(messages);
  assert.equal(turn.id, "turn_user"); assert.equal(turn.turnId, turn.id); assert.equal(turn.createdAt, 1000);
  assert.equal(turn.items[0].content[0].text, " inspect\n");
  assert.equal(turn.items[0].content[1].image_url, "data:image/png;base64,AA==");
  assert.equal(turn.items[1].content[0].text, " reasoning\n");
  assert.equal(turn.items[2].type, "commandExecution");
  assert.equal(turn.items[2].command, "pwd"); assert.equal(turn.items[2].aggregatedOutput, " /project\n");
  assert.equal(turn.items[3].id, "msg_answer"); assert.equal(turn.items[3].text, "answer so far");
  assert.equal(turn.items[3].createdAt, 2000); assert.equal(turn.items.length, 4);
});

function setupRecovery(statusHandler = () => ({ status: 200, json: { ses_a: { type: "busy" } } })) {
  return setupTranslator({ httpHandler(method, route) {
    if (route.startsWith("/session/status")) return statusHandler();
    if (route.includes("/message")) return { status: 200, json: route.includes("limit=1") ? messages.slice(-1) : messages };
    return { status: 200, json: { id: "ses_a", directory: "/project" } };
  } });
}

test("reopening a running session restores overlap rejection, deltas and Stop after restart", async () => {
  const { translator, injected, httpCalls } = setupRecovery();
  send(translator, "read", "thread/resume", { threadId: "ses_a" }); await tick();
  const thread = parseInjected(injected).find((e) => e.id === "read").result.thread;
  assert.equal(thread.status.type, "active"); assert.equal(thread.turns[0].status, "inProgress");
  assert.ok(httpCalls.some((call) => call.pathName === "/session/status?directory=%2Fproject"));
  assert.equal(parseInjected(injected).some((e) => e.method === "item/agentMessage/delta"), false);
  send(translator, "overlap", "turn/start", { threadId: "ses_a", input: [{ type: "text", text: "new" }] });
  assert.equal(parseInjected(injected).find((e) => e.id === "overlap").error.code, -32003);
  translator.inbound(JSON.stringify({ type: "message.part.updated", properties: { part: {
    id: "part2", messageID: "msg_answer", sessionID: "ses_a", type: "text", text: "so far done",
  } } }));
  assert.equal(parseInjected(injected).find((e) => e.method === "item/agentMessage/delta").params.delta, " done");
  send(translator, "stop", "turn/interrupt", { threadId: "ses_a", turnId: "turn_user" }); await tick();
  assert.ok(httpCalls.some((call) => call.pathName.startsWith("/session/ses_a/abort")));
});

test("metadata reads restore ownership without returning or replaying history", async () => {
  const { translator, injected } = setupRecovery();
  send(translator, "read", "thread/read", { threadId: "ses_a", excludeTurns: true }); await tick();
  const thread = parseInjected(injected).find((e) => e.id === "read").result.thread;
  assert.equal(thread.status.type, "active"); assert.deepEqual(thread.turns, []);
  assert.equal(parseInjected(injected).some((e) => e.method?.startsWith("item/")), false);
});

test("delayed busy snapshots cannot replace newer turns or revive a live idle session", async () => {
  for (const newerTurn of [false, true]) {
    let resolveStatus;
    const { translator, injected } = setupRecovery(() => new Promise((resolve) => { resolveStatus = resolve; }));
    send(translator, "read", "thread/read", { threadId: "ses_a" }); await tick();
    if (newerTurn) send(translator, "new", "turn/start", { threadId: "ses_a", input: [{ type: "text", text: "new" }] });
    else translator.inbound(JSON.stringify({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "idle" } } }));
    resolveStatus({ status: 200, json: { ses_a: { type: "busy" } } }); await tick();
    const events = parseInjected(injected);
    const thread = events.find((e) => e.id === "read").result.thread;
    if (newerTurn) assert.equal(thread.turns.at(-1).id, events.find((e) => e.id === "new").result.turnId);
    else assert.equal(thread.status, "idle");
  }
});

test("failed status reads do not invent an active turn", async () => {
  const { translator, injected } = setupRecovery(() => ({ status: 503, json: null }));
  send(translator, "read", "thread/read", { threadId: "ses_a" }); await tick();
  assert.equal(parseInjected(injected).find((e) => e.id === "read").result.thread.status, "idle");
});
