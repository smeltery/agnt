// FILE: git-handler-thread-title.test.js
// Purpose: Covers thread title generation and thread rename RPC handling.
// Layer: Unit Test
// Exports: node:test cases
// Depends on: node:test, assert, git-handler

const assert = require("node:assert/strict");
const test = require("node:test");
const { __test, handleGitRequest } = require("../../src/git/git-handler");

test.afterEach(() => {
  __test.resetRunStructuredCodexJsonImplementation();
  __test.resetRunGitHubCliImplementation();
});

test("threadGenerateTitle uses Codex structured JSON with read-only title constraints", async () => {
  let capturedInvocation = null;

  __test.setRunStructuredCodexJsonImplementation(async (payload) => {
    capturedInvocation = payload;
    return { title: "fix the sidebar thread title please" };
  });

  const result = await __test.threadGenerateTitle({
    message: "Can you fix the sidebar thread title so it summarizes the first request?",
    model: "gpt-5.4-mini",
    attachmentCount: 2,
  });

  assert.equal(result.title, "Fix the sidebar thread");
  assert.equal(capturedInvocation?.model, "gpt-5.4-mini");
  assert.equal(capturedInvocation?.skipGitRepoCheck, true);
  assert.equal(capturedInvocation?.sandboxMode, "read-only");
  assert.match(capturedInvocation?.prompt || "", /maximum 4 words/);
  assert.match(capturedInvocation?.prompt || "", /Attachments: 2 images/);
});

test("threadGenerateTitle falls back to a sanitized first-message title", async () => {
  __test.setRunStructuredCodexJsonImplementation(async () => {
    return { title: "" };
  });

  const result = await __test.threadGenerateTitle({
    message: "rename this conversation after first send",
  });

  assert.equal(result.title, "Rename this conversation after");
});

test("threadNameSet normalizes mobile rename params", async () => {
  const requests = [];
  const result = await __test.threadNameSet({
    thread_id: " thread-1 ",
    name: "  Fix Thread Naming  ",
  }, { sendCodexRequest: async (method, params) => { requests.push({ method, params }); } });
  assert.deepEqual(requests, [{ method: "thread/name/set", params: { threadId: "thread-1", name: "Fix Thread Naming" } }]);

  assert.deepEqual(result, {
    threadId: "thread-1",
    thread_id: "thread-1",
    name: "Fix Thread Naming",
    title: "Fix Thread Naming",
  });
});

test("handleGitRequest persists thread rename through the runtime", async () => {
  const responses = [];
  const requests = [];
  const handled = handleGitRequest(
    JSON.stringify({
      id: "rename-1",
      method: "thread/name/set",
      params: {
        threadId: "thread-1",
        title: "Polish loading states",
      },
    }),
    (response) => responses.push(JSON.parse(response)),
    {
      sendCodexRequest: async (method, params) => requests.push({ method, params }),
    }
  );

  assert.equal(handled, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0], {
    id: "rename-1",
    result: {
      threadId: "thread-1",
      thread_id: "thread-1",
      name: "Polish loading states",
      title: "Polish loading states",
    },
  });
  assert.deepEqual(requests, [{ method: "thread/name/set", params: { threadId: "thread-1", name: "Polish loading states" } }]);
});

test("handleGitRequest skips thread/generateTitle when codexTitleGeneration is false", () => {
  const responses = [];
  const handled = handleGitRequest(
    JSON.stringify({ id: "title-1", method: "thread/generateTitle", params: { message: "hi" } }),
    (line) => responses.push(line),
    { codexTitleGeneration: false }
  );
  assert.equal(handled, false, "handler must defer to provider translator when Codex title generation is gated off");
  assert.equal(responses.length, 0, "must not synthesize a response when not handling");
});

test("handleGitRequest still handles thread/generateTitle for Codex by default", () => {
  __test.setRunStructuredCodexJsonImplementation(async ({ prompt }) => {
    assert.match(prompt, /title/i);
    return { title: "Mocked title" };
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const handled = handleGitRequest(
      JSON.stringify({ id: "title-2", method: "thread/generateTitle", params: { message: "hello world" } }),
      (line) => {
        if (settled) return;
        settled = true;
        try {
          const parsed = JSON.parse(line);
          assert.equal(parsed.id, "title-2");
          assert.equal(parsed.result.title, "Mocked title");
          resolve();
        } catch (err) { reject(err); }
      },
      {} // no codexTitleGeneration override → defaults to handling locally
    );
    assert.equal(handled, true);
  });
});

 test("thread rename failures do not report optimistic success", async () => {
  await assert.rejects(__test.threadNameSet({ threadId: "task", name: "Title" }), /connection is unavailable/);
  await assert.rejects(__test.threadNameSet({ threadId: "task", name: "Title" }, {
    sendCodexRequest: async () => { throw new Error("owner rejected rename"); },
  }), /owner rejected rename/);
});
