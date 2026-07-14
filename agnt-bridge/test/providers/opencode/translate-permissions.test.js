// FILE: translate-permissions.test.js
// Purpose: Verify opencode permission approval translation and pending-approval streaming.
// Layer: Unit test

const test = require("node:test");
const assert = require("node:assert/strict");

const { setupTranslator, parseInjected, createOpencodeTranslator } = require("./translate-test-helpers");

test("permission.asked emits item/commandExecution/requestApproval and reply POSTs to /permissions", async () => {
  const httpCalls = [];
  const injected = [];
  const transport = {
    describe: () => "fake",
    send() {},
    httpRequest(method, pathName, body) {
      httpCalls.push({ method, pathName, body });
      return Promise.resolve({ status: 200, json: { ok: true }, raw: "" });
    },
  };
  const translator = createOpencodeTranslator({
    injectInbound: (line) => injected.push(line),
    transport,
    env: process.env,
  });
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_perm", input: [{ type: "text", text: "do it" }] },
  }));
  injected.length = 0;
  httpCalls.length = 0;

  // opencode SSE: permission.asked
  translator.inbound(JSON.stringify({
    type: "permission.asked",
    properties: {
      sessionID: "ses_perm",
      info: {
        id: "perm_abc",
        sessionID: "ses_perm",
        permission: "edit",
        metadata: { filepath: "/tmp/y.txt", diff: "+ b" },
        title: "Approve edit?",
      },
    },
  }));

  const requestEnvelope = parseInjected(injected).find((e) => e.method?.endsWith("requestApproval"));
  assert.ok(requestEnvelope, "expected an approval request to be injected");
  assert.equal(requestEnvelope.method, "item/fileChange/requestApproval");
  assert.equal(requestEnvelope.params.permissionID, "perm_abc");
  assert.equal(requestEnvelope.params.file_path, "/tmp/y.txt");
  const approvalRequestId = requestEnvelope.id;

  // iOS replies via the bridge: outbound JSON-RPC response with decision:"accept"
  translator.outbound(JSON.stringify({
    id: approvalRequestId,
    result: { decision: "accept" },
  }));
  await new Promise((r) => setImmediate(r));

  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].method, "POST");
  assert.equal(httpCalls[0].pathName, "/session/ses_perm/permissions/perm_abc");
  assert.equal(httpCalls[0].body.response, "once");
});

test("permission decline maps decision:'decline' to opencode response:'reject'", async () => {
  const httpCalls = [];
  const injected = [];
  const transport = {
    describe: () => "fake",
    send() {},
    httpRequest(method, pathName, body) {
      httpCalls.push({ method, pathName, body });
      return Promise.resolve({ status: 200, json: { ok: true } });
    },
  };
  const translator = createOpencodeTranslator({
    injectInbound: (line) => injected.push(line),
    transport,
    env: process.env,
  });
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_decline", input: [{ type: "text", text: "go" }] },
  }));
  translator.inbound(JSON.stringify({
    type: "permission.asked",
    properties: { sessionID: "ses_decline", info: { id: "perm_x", sessionID: "ses_decline", permission: "command" } },
  }));
  const env = parseInjected(injected).find((e) => e.method?.endsWith("requestApproval"));
  translator.outbound(JSON.stringify({ id: env.id, result: { decision: "decline" } }));
  await new Promise((r) => setImmediate(r));
  assert.equal(httpCalls[httpCalls.length - 1].body.response, "reject");
});

test("assistant deltas continue to flow while an approval request is pending", () => {
  // Race scenario: iOS may take seconds/minutes to respond to permission.asked.
  // During that window, opencode's SSE keeps pushing assistant deltas
  // (model is still talking) and other events. The translator must keep
  // forwarding them — blocking would freeze the UI until the user decides.
  const { translator, injected } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_ar", input: [{ type: "text", text: "do" }] },
  }));
  injected.length = 0;

  // 1) Assistant emits some text before the permission ask.
  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_ar",
      part: { type: "text", text: "Reading", id: "prt_1", messageID: "msg_1" },
    },
  }));

  // 2) opencode asks for permission mid-flight.
  translator.inbound(JSON.stringify({
    type: "permission.asked",
    properties: {
      sessionID: "ses_ar",
      info: { id: "perm_1", sessionID: "ses_ar", permission: "edit", metadata: { filepath: "/tmp/z" } },
    },
  }));

  // 3) Without iOS responding yet, more assistant text arrives.
  translator.inbound(JSON.stringify({
    type: "message.part.updated",
    properties: {
      sessionID: "ses_ar",
      part: { type: "text", text: "Reading file...", id: "prt_1", messageID: "msg_1" },
    },
  }));

  const events = parseInjected(injected).filter((e) => e.method);
  const approval = events.find((e) => e.method?.endsWith("requestApproval"));
  const deltas = events.filter((e) => e.method === "item/agentMessage/delta");
  assert.ok(approval, "approval request must still be emitted");
  assert.equal(deltas.length, 2, "both pre- and post-approval deltas must propagate");
  assert.equal(deltas[0].params.delta, "Reading");
  // Differential delta: only the new suffix after the first chunk.
  assert.equal(deltas[1].params.delta, " file...");
});

test("an approval reply with an unknown id is dropped, not POSTed", async () => {
  // Defensive: if iOS sends a stale or misrouted approval response (e.g. an
  // id from a prior thread that the translator never issued), the shim
  // must NOT forward it to opencode's /permissions endpoint — that would
  // act on the wrong permission record on the server side.
  const { translator, httpCalls } = setupTranslator();
  translator.outbound(JSON.stringify({
    id: "tu", method: "turn/start",
    params: { threadId: "ses_drop", input: [{ type: "text", text: "go" }] },
  }));
  httpCalls.length = 0;

  translator.outbound(JSON.stringify({
    id: "approval_unknown_999",
    result: { decision: "accept" },
  }));
  await new Promise((r) => setImmediate(r));

  const permPosts = httpCalls.filter((c) => c.pathName.includes("/permissions/"));
  assert.equal(permPosts.length, 0, "unknown approval id must not POST to /permissions");
});
