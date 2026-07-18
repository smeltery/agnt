// FILE: translate-tools.test.js
// Purpose: Verify opencode tool, diff, notice, attachment, and thread-list translation.
// Layer: Unit test

const test = require("node:test");
const assert = require("node:assert/strict");

const { setupTranslator, parseInjected } = require("./translate-test-helpers");

test("opencode read tool emits item/started + item/completed with file_path", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_read", input: [{ type: "text", text: "read it" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_read",
      part: {
        type: "tool", tool: "read", id: "prt_r", messageID: "msg_r",
        state: { input: { file_path: "/tmp/x.txt" }, status: "running" },
      },
    },
  }));
  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_read",
      part: {
        type: "tool", tool: "read", id: "prt_r", messageID: "msg_r",
        state: { input: { file_path: "/tmp/x.txt" }, status: "completed", output: "hello" },
      },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const started = events.find((e) => e.method === "item/started");
  const delta = events.find((e) => e.method === "item/toolCall/outputDelta");
  const completed = events.find((e) => e.method === "item/completed");
  assert.equal(started.params.item.type, "file_read");
  assert.equal(started.params.item.file_path, "/tmp/x.txt");
  assert.equal(delta.params.delta, "hello");
  assert.equal(completed.params.item.status, "completed");
});

test("opencode edit tool emits file_change with output delta", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_edit", input: [{ type: "text", text: "edit it" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_edit",
      part: {
        type: "tool", tool: "edit", id: "prt_e", messageID: "msg_e",
        state: {
          input: { file_path: "/tmp/y.txt", old_string: "a", new_string: "b" },
          status: "completed", output: "updated y.txt",
        },
      },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const started = events.find((e) => e.method === "item/started");
  const fileDelta = events.find((e) => e.method === "item/fileChange/outputDelta");
  const completed = events.find((e) => e.method === "item/completed");
  assert.equal(started.params.item.type, "file_change");
  assert.equal(started.params.item.tool, "edit");
  assert.equal(fileDelta.params.delta, "updated y.txt");
  assert.equal(completed.params.item.status, "completed");
});

test("tui.toast.show emits system/notice with severity + title", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_t", input: [{ type: "text", text: "x" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "tui.toast.show",
    properties: {
      title: "MCP Authentication Required",
      message: "Server linear requires auth",
      variant: "warning",
      duration: 8000,
    },
  }));

  const ev = parseInjected(injected).find((e) => e.method === "system/notice");
  assert.ok(ev);
  assert.equal(ev.params.severity, "warning");
  assert.equal(ev.params.title, "MCP Authentication Required");
});

test("patch part emits turn/diff/updated and file_change item", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_p", input: [{ type: "text", text: "patch" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_p",
      part: {
        type: "patch", id: "prt_p", messageID: "msg_p",
        file_path: "/tmp/z.txt",
        diff: "@@ -1 +1 @@\n-old\n+new",
      },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const diff = events.find((e) => e.method === "turn/diff/updated");
  const started = events.find((e) => e.method === "item/started");
  const out = events.find((e) => e.method === "item/fileChange/outputDelta");
  assert.equal(diff.params.diff[0].file, "/tmp/z.txt");
  assert.equal(started.params.item.type, "file_change");
  assert.match(out.params.delta, /\+new/);
});

test("opencode webfetch tool emits a background_event with descriptive message", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_wf", input: [{ type: "text", text: "fetch" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_wf",
      part: {
        type: "tool", tool: "webfetch", id: "prt_wf", messageID: "msg_wf",
        state: { input: { url: "https://example.com" }, status: "running" },
      },
    },
  }));

  const ev = parseInjected(injected).find((e) => e.method === "codex/event/background_event");
  assert.equal(ev.params.message, "Fetching https://example.com");
});

test("turn/start image attachment uses opencode {type:'file', mediaType, url} schema", () => {
  const { translator, httpCalls } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu-img", method: "turn/start",
    params: {
      threadId: "ses_img",
      input: [
        { type: "image", image_url: "data:image/jpeg;base64,/9j/" },
        { type: "text", text: "describe" },
      ],
    },
  }));

  const body = httpCalls[0].body;
  const filePart = body.parts.find((p) => p.type === "file");
  assert.ok(filePart);
  assert.equal(filePart.mediaType, "image/jpeg");
  assert.equal(filePart.url, "data:image/jpeg;base64,/9j/");
});

test("session.status retry with next-resets-at emits thread/status/changed rateLimited", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_rl", input: [{ type: "text", text: "x" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "session.status",
    properties: {
      sessionID: "ses_rl",
      status: { type: "retry", attempt: 1, next: 1778105124680, message: "Quota exceeded" },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method === "thread/status/changed");
  assert.equal(events.length, 1);
  assert.equal(events[0].params.status.type, "rateLimited");
  assert.equal(events[0].params.status.rateLimit.resetsAt, 1778105124680);
  assert.equal(events[0].params.status.rateLimit.attempt, 1);
});

test("thread/list applies a 200-row pagination cap and reports hasMore", async () => {
  const sessions = Array.from({ length: 350 }, (_, i) => ({
    id: `ses_${i.toString().padStart(3, "0")}`,
    title: `s${i}`,
    directory: "/tmp",
    time: { created: 0, updated: i },
  }));
  const { translator, injected } = setupTranslator({
    httpHandler(method, pathName) {
      if (method === "GET" && pathName === "/session") {
        return { status: 200, json: sessions };
      }
      return { status: 404, json: null };
    },
  });

  translator.outbound(JSON.stringify({ id: "list-cap", method: "thread/list", params: {} }));
  await new Promise((r) => setImmediate(r));

  const events = parseInjected(injected);
  const ack = events.find((e) => e.id === "list-cap");
  assert.equal(ack.result.data.length, 200);
  assert.equal(ack.result.hasMore, true);
  // Sorted descending by updated, so first is sessions[349].
  assert.equal(ack.result.data[0].id, "ses_349");
});

test("thread/list honors a smaller requested limit", async () => {
  const sessions = Array.from({ length: 50 }, (_, i) => ({
    id: `ses_${i}`, time: { updated: i },
  }));
  const { translator, injected } = setupTranslator({
    httpHandler() { return { status: 200, json: sessions }; },
  });
  translator.outbound(JSON.stringify({
    id: "list-limit", method: "thread/list", params: { limit: 10 },
  }));
  await new Promise((r) => setImmediate(r));

  const ack = parseInjected(injected).find((e) => e.id === "list-limit");
  assert.equal(ack.result.data.length, 10);
});

test("inbound events for a different sessionID are ignored once a turn is active", () => {
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_mine", input: [{ type: "text", text: "x" }] },
  }));
  injected.length = 0;

  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_other",
      part: { type: "text", text: "leak", id: "prt_l", messageID: "msg_l" },
    },
  }));

  assert.equal(injected.length, 0);
});
