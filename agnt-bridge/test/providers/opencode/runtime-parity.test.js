const assert = require("node:assert/strict");
const test = require("node:test");
const { setupTranslator, parseInjected } = require("./translate-test-helpers");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const send = (t, id, method, params = {}) => t.outbound(JSON.stringify({ id, method, params }));
const event = (t, type, properties) => t.inbound(JSON.stringify({ type, properties }));
const start = (t, threadId = "ses_a", params = {}) => send(t, "start", "turn/start", { threadId, input: [{ type: "text", text: "hi" }], ...params });

test("model catalog preserves configured variant IDs and hides disconnected providers", async () => {
  const { translator, injected } = setupTranslator({ httpHandler: () => ({ status: 200, json: {
    connected: ["custom"], default: { custom: "model" }, all: [
      { id: "custom", models: { model: { name: "My model", variants: { deep: { reasoningEffort: "high" }, disabled: { temperature: 1 } }, options: { effort: "high" } }, none: { variants: {}, reasoning_options: [{ type: "effort", values: ["high"] }] } } },
      { id: "disconnected", models: { model: {} } },
    ],
  } }) });
  send(translator, "models", "model/list"); await tick();
  const models = parseInjected(injected).find((e) => e.id === "models").result.data;
  assert.equal(models.length, 2);
  assert.equal(models[0].id, "custom/model");
  assert.equal(models[0].defaultReasoningEffort, "deep");
  assert.deepEqual(models[0].supportedReasoningEfforts.map((v) => v.reasoningEffort), ["deep"]);
  assert.deepEqual(models[1].supportedReasoningEfforts, []);
});

test("model and effort selections stay per chat and use the documented request body", async () => {
  const { translator, httpCalls } = setupTranslator();
  start(translator, "a", { model: "custom/model/with/slash", effort: "deep" });
  event(translator, "session.status", { sessionID: "a", status: { type: "idle" } });
  start(translator, "b");
  event(translator, "session.status", { sessionID: "b", status: { type: "idle" } });
  start(translator, "a", { effort: null });
  assert.deepEqual(httpCalls[0].body.model, { providerID: "custom", modelID: "model/with/slash" });
  assert.equal(httpCalls[0].body.variant, "deep");
  assert.equal(httpCalls[1].body.model, undefined);
  assert.deepEqual(httpCalls[2].body.model, httpCalls[0].body.model);
  assert.equal(httpCalls[2].body.variant, undefined);
  assert.match(httpCalls[0].body.messageID, /^msg_/);
  await tick();
});

test("failed and late prompt responses cannot wedge or corrupt a newer turn", async () => {
  let rejectOld;
  let first = true;
  const { translator, injected } = setupTranslator({ httpHandler: () => {
    if (first) { first = false; return new Promise((_, reject) => { rejectOld = reject; }); }
    return { status: 200, json: null };
  } });
  start(translator);
  send(translator, "interrupt", "turn/interrupt", { threadId: "ses_a" });
  start(translator, "ses_b");
  injected.length = 0;
  rejectOld(new Error("old failure")); await tick();
  assert.equal(parseInjected(injected).length, 0);
  send(translator, "overlap", "turn/start", { threadId: "ses_b", input: [{ type: "text", text: "x" }] });
  assert.equal(parseInjected(injected).find((e) => e.id === "overlap").error.code, -32003);
});

test("HTTP errors fail a turn once and permit another send", async () => {
  const { translator, injected } = setupTranslator({ httpHandler: () => ({ status: 403, json: { message: "denied" } }) });
  start(translator); await tick(); start(translator); await tick();
  assert.equal(parseInjected(injected).filter((e) => e.method === "turn/failed").length, 2);
  assert.equal(parseInjected(injected).filter((e) => e.error?.code === -32003).length, 0);
});

test("reading another chat cannot redirect active tools or nested-session events", async () => {
  const { translator, injected } = setupTranslator(); start(translator);
  send(translator, "read", "thread/read", { threadId: "ses_b" }); await tick(); injected.length = 0;
  event(translator, "message.part.updated", { part: { id: "other", sessionID: "ses_b", type: "text", text: "wrong" } });
  event(translator, "message.part.updated", { part: { id: "tool", sessionID: "ses_a", type: "tool", tool: "bash", state: { status: "running", input: { command: "pwd" } } } });
  const events = parseInjected(injected);
  assert.equal(events.length, 1);
  assert.equal(events[0].params.threadId, "ses_a");
  assert.ok(events[0].params.turnId);
});

test("streamed deltas keep whitespace and never merge reasoning into the final answer", () => {
  const { translator, injected } = setupTranslator(); start(translator);
  event(translator, "message.updated", { info: { sessionID: "ses_a", id: "assistant", role: "assistant" } });
  event(translator, "message.part.updated", { part: { sessionID: "ses_a", id: "text", messageID: "assistant", type: "text", text: " hello " } });
  event(translator, "message.part.delta", { sessionID: "ses_a", partID: "text", field: "text", delta: "world " });
  event(translator, "message.part.updated", { part: { sessionID: "ses_a", id: "reason", messageID: "assistant", type: "reasoning", text: "private reasoning" } });
  event(translator, "session.status", { sessionID: "ses_a", status: { type: "idle" } });
  const answer = parseInjected(injected).find((e) => e.method === "codex/event/agent_message");
  assert.equal(answer.params.message, " hello world ");
});

test("questions map ordered multi-select answers and resolve only after delivery", async () => {
  const { translator, injected, httpCalls } = setupTranslator(); start(translator);
  event(translator, "question.asked", { id: "q", sessionID: "ses_a", questions: [{ question: "Which?", header: "Choice", options: [{ label: "A", description: "A" }], multiple: true }] });
  const question = parseInjected(injected).find((e) => e.method === "item/tool/requestUserInput");
  translator.outbound(JSON.stringify({ id: question.id, result: { answers: { "question-0": { answers: ["A", "B"] } } } }));
  assert.equal(parseInjected(injected).some((e) => e.method === "serverRequest/resolved"), false);
  await tick();
  assert.equal(httpCalls.at(-1).pathName, "/question/q/reply");
  assert.deepEqual(httpCalls.at(-1).body, { answers: [["A", "B"]] });
  assert.equal(parseInjected(injected).filter((e) => e.method === "serverRequest/resolved").length, 1);
});

test("failed approval responses remain retryable and remote resolution clears them", async () => {
  const { translator, injected, httpCalls } = setupTranslator({ httpHandler: (method, route) => ({ status: route.startsWith("/permission") ? 500 : 200, json: null }) });
  start(translator);
  event(translator, "permission.asked", { id: "p", sessionID: "ses_a", permission: "bash" });
  translator.outbound(JSON.stringify({ id: "approval_p", result: { decision: "acceptForSession" } })); await tick();
  assert.equal(httpCalls.at(-1).body.reply, "always");
  assert.equal(parseInjected(injected).filter((e) => e.method === "item/commandExecution/requestApproval").length, 2);
  event(translator, "permission.replied", { id: "p", sessionID: "ses_a" });
  const count = httpCalls.length;
  translator.outbound(JSON.stringify({ id: "approval_p", result: { decision: "accept" } })); await tick();
  assert.equal(httpCalls.length, count);
});

test("new chats and saved names use their project context and acknowledge real errors", async () => {
  const { translator, injected, httpCalls } = setupTranslator({ httpHandler: (method) => ({ status: method === "PATCH" ? 403 : 200, json: { id: "ses_project", directory: "/project one" } }) });
  send(translator, "new", "thread/start", { cwd: "/project one" }); await tick();
  send(translator, "rename", "thread/name/set", { threadId: "ses_project", name: "Saved name" }); await tick();
  assert.equal(httpCalls[0].pathName, "/session?directory=%2Fproject%20one");
  assert.equal(httpCalls[1].pathName, "/session/ses_project?directory=%2Fproject%20one");
  assert.deepEqual(httpCalls[1].body, { title: "Saved name" });
  assert.ok(parseInjected(injected).find((e) => e.id === "rename").error);
});
