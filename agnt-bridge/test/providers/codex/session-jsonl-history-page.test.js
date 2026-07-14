// FILE: session-jsonl-history-page.test.js
// Purpose: Unit tests for JSONL thread-turn page reconstruction and bounded file reads.
// Layer: Unit test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  readSessionJsonlMetadataFromFile,
  readThreadTurnsListPageFromSessionJsonl,
} = require("../../../src/providers/codex/session-jsonl-history");

function jsonl(...entries) {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

// ─── readThreadTurnsListPageFromSessionJsonl ───────────────────────────────

test("readThreadTurnsListPageFromSessionJsonl returns null when filePath is missing", () => {
  const fakeFs = { readFileSync: () => { throw new Error("should not be called"); } };
  assert.equal(
    readThreadTurnsListPageFromSessionJsonl("", { fsModule: fakeFs }),
    null
  );
});

test("readThreadTurnsListPageFromSessionJsonl returns null whenever a cursor is set (not for paginated reads)", () => {
  const fakeFs = { readFileSync: () => { throw new Error("should not be called"); } };
  assert.equal(
    readThreadTurnsListPageFromSessionJsonl("/fake/path", { cursor: "page-2", fsModule: fakeFs }),
    null
  );
});

test("readThreadTurnsListPageFromSessionJsonl returns null when no turns recover from the file", () => {
  const fakeFs = { readFileSync: () => "" };
  assert.equal(
    readThreadTurnsListPageFromSessionJsonl("/fake/path", { fsModule: fakeFs }),
    null
  );
});

test("readThreadTurnsListPageFromSessionJsonl returns the most-recent turns reversed under safeLimit=5", () => {
  // Build 6 turns; the page should contain the last 5 reversed (newest first).
  const lines = [];
  for (let i = 1; i <= 6; i += 1) {
    lines.push(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: `t-${i}` } }));
    lines.push(JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `hi-${i}` }], turn_id: `t-${i}` } }));
  }
  const content = lines.join("\n");

  const fakeFs = { readFileSync: () => content };
  const page = readThreadTurnsListPageFromSessionJsonl("/fake/path", {
    fsModule: fakeFs,
    limit: 10, // larger than the cap; the cap kicks in.
  });
  assert.ok(page);
  assert.equal(page.agntJsonlFallback, true);
  // 5-turn cap, newest-first ordering.
  assert.equal(page.data.length, 5);
  assert.equal(page.data[0].id, "t-6");
  assert.equal(page.data[4].id, "t-2");
  // There were 6 turns total but only 5 surfaced — older ones unavailable in JSONL.
  assert.equal(page.nextCursor, "agnt-jsonl-fallback-older-unavailable");
});

test("readThreadTurnsListPageFromSessionJsonl reports nextCursor=null when all turns fit under the cap", () => {
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }], turn_id: "t-1" } }
  );
  const fakeFs = { readFileSync: () => content };
  const page = readThreadTurnsListPageFromSessionJsonl("/fake/path", {
    fsModule: fakeFs,
    limit: 5,
  });
  assert.ok(page);
  assert.equal(page.data.length, 1);
  assert.equal(page.nextCursor, null);
});

test("readThreadTurnsListPageFromSessionJsonl honors a smaller limit even when more turns are available", () => {
  const lines = [];
  for (let i = 1; i <= 4; i += 1) {
    lines.push(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: `t-${i}` } }));
    lines.push(JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `m-${i}` }], turn_id: `t-${i}` } }));
  }
  const fakeFs = { readFileSync: () => lines.join("\n") };
  const page = readThreadTurnsListPageFromSessionJsonl("/fake/path", {
    fsModule: fakeFs,
    limit: 2,
  });
  assert.equal(page.data.length, 2);
  assert.equal(page.data[0].id, "t-4");
  assert.equal(page.data[1].id, "t-3");
  // 4 turns total, surfaced 2 → older still exist.
  assert.equal(page.nextCursor, "agnt-jsonl-fallback-older-unavailable");
});

test("readThreadTurnsListPageFromSessionJsonl caps the requested limit at maxLimit then at hard ceiling 5", () => {
  // Build 7 turns. Pass limit=10, maxLimit=2 → final safe limit should be min(10, 2, 5) = 2.
  const lines = [];
  for (let i = 1; i <= 7; i += 1) {
    lines.push(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: `t-${i}` } }));
    lines.push(JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `m-${i}` }], turn_id: `t-${i}` } }));
  }
  const fakeFs = { readFileSync: () => lines.join("\n") };
  const page = readThreadTurnsListPageFromSessionJsonl("/fake/path", {
    fsModule: fakeFs,
    limit: 10,
    maxLimit: 2,
  });
  assert.equal(page.data.length, 2);
});

test("bounded JSONL history reads a complete tail turn without loading the full file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-jsonl-tail-"));
  const filePath = path.join(directory, "rollout.jsonl");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const threadId = "thread-bounded-tail";
  const turnId = "turn-bounded-tail";
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: "/repo" } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        id: "oversized-old-output",
        type: "function_call_output",
        turn_id: "turn-old",
        output: "x".repeat(2_500),
      },
    }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-old" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Load the latest reply" } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        id: "assistant-bounded-tail",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Ready" }],
      },
    }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId } }),
  ].join("\n"), "utf8");

  let maximumReadLength = 0;
  const boundedFs = {
    statSync: (...args) => fs.statSync(...args),
    openSync: (...args) => fs.openSync(...args),
    readSync: (...args) => {
      maximumReadLength = Math.max(maximumReadLength, args[3]);
      return fs.readSync(...args);
    },
    closeSync: (...args) => fs.closeSync(...args),
    readFileSync: () => {
      throw new Error("bounded reader must not call readFileSync");
    },
  };

  const readPage = () => readThreadTurnsListPageFromSessionJsonl(filePath, {
    threadId,
    limit: 1,
    maxLimit: 1,
    fsModule: boundedFs,
    metadataHeadBytes: 128,
    initialTailBytes: 1_024,
    maxTailBytes: 1_024,
  });

  const firstPage = readPage();
  const firstUserItem = firstPage.data[0].items.find((item) => item.role === "user");
  assert.equal(firstPage.agntJsonlFallback, true);
  assert.equal(firstPage.data[0].id, turnId);
  assert.equal(firstPage.data[0].status, "completed");
  assert.equal(firstUserItem.text, "Load the latest reply");
  assert.equal(firstPage.nextCursor, "agnt-jsonl-fallback-older-unavailable");
  assert.equal(maximumReadLength <= 1_024, true);

  fs.appendFileSync(filePath, `\n${JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { total_tokens: 1 } } },
  })}`, "utf8");
  const secondPage = readPage();
  const secondUserItem = secondPage.data[0].items.find((item) => item.role === "user");
  assert.equal(secondUserItem.id, firstUserItem.id);
});

test("synthetic JSONL ids stay stable when an append crosses the tail-window boundary", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-jsonl-tail-boundary-"));
  const filePath = path.join(directory, "rollout.jsonl");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const threadId = "thread-tail-boundary";
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: "/repo" } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        id: "old-output",
        type: "function_call_output",
        turn_id: "turn-old",
        output: "x".repeat(1_200),
      },
    }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-old" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "Keep this synthetic turn stable" },
    }),
  ].join("\n"), "utf8");
  assert.ok(fs.statSync(filePath).size < 4_096);

  const readPage = () => readThreadTurnsListPageFromSessionJsonl(filePath, {
    threadId,
    limit: 1,
    maxLimit: 1,
    metadataHeadBytes: 128,
    initialTailBytes: 4_096,
    maxTailBytes: 4_096,
  });
  const firstPage = readPage();
  const firstTurn = firstPage.data[0];
  const firstUserItem = firstTurn.items.find((item) => item.role === "user");
  assert.ok(firstTurn.id.startsWith("turn-line-"));

  fs.appendFileSync(filePath, `\n${[
    JSON.stringify({
      type: "response_item",
      payload: {
        id: "assistant-after-boundary",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "y".repeat(3_000) }],
      },
    }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
  ].join("\n")}`, "utf8");
  assert.ok(fs.statSync(filePath).size > 4_096);

  const secondPage = readPage();
  const secondTurn = secondPage.data[0];
  const secondUserItem = secondTurn.items.find((item) => item.role === "user");
  assert.equal(secondTurn.id, firstTurn.id);
  assert.equal(secondUserItem.id, firstUserItem.id);
  assert.equal(secondTurn.status, "completed");
});

test("bounded JSONL history rejects a tail that does not contain a complete turn start", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-jsonl-partial-"));
  const filePath = path.join(directory, "rollout.jsonl");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: "session_meta", payload: { id: "thread-partial-tail" } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        id: "partial-output",
        type: "function_call_output",
        turn_id: "turn-started-before-window",
        output: "X".repeat(4_000),
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        id: "partial-answer",
        type: "message",
        role: "assistant",
        turn_id: "turn-started-before-window",
        content: [{ type: "output_text", text: "Not safe alone" }],
      },
    }),
  ].join("\n"), "utf8");

  const page = readThreadTurnsListPageFromSessionJsonl(filePath, {
    threadId: "thread-partial-tail",
    limit: 1,
    initialTailBytes: 512,
    maxTailBytes: 512,
  });

  assert.equal(page, null);
});

test("readSessionJsonlMetadataFromFile reads cwd from the bounded file head", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-jsonl-metadata-"));
  const filePath = path.join(directory, "rollout.jsonl");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: "session_meta", payload: { id: "thread-meta", cwd: "/repo" } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        id: "huge-output",
        type: "function_call_output",
        turn_id: "turn-old",
        output: "x".repeat(10_000),
      },
    }),
  ].join("\n"), "utf8");

  let maximumReadLength = 0;
  const boundedFs = {
    statSync: (...args) => fs.statSync(...args),
    openSync: (...args) => fs.openSync(...args),
    readSync: (...args) => {
      maximumReadLength = Math.max(maximumReadLength, args[3]);
      return fs.readSync(...args);
    },
    closeSync: (...args) => fs.closeSync(...args),
    readFileSync: () => {
      throw new Error("metadata reader must not call readFileSync");
    },
  };

  const metadata = readSessionJsonlMetadataFromFile(filePath, {
    fsModule: boundedFs,
    metadataHeadBytes: 128,
  });

  assert.deepEqual(metadata, { threadId: "thread-meta", cwd: "/repo" });
  assert.equal(maximumReadLength <= 128, true);
});
