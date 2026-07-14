// FILE: codex-session-jsonl-history.test.js
// Purpose: Unit tests for the Codex JSONL session history parser used as the
//          empty-thread/turns/list fallback. Exercises the four event types
//          (session_meta, event_msg variants, response_item), type normalization
//          (functionCall → tool_call), the slice/reverse paging behavior, and
//          the bail-out cases (empty content, cursor present, no matching turns).
// Layer: Unit test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseSessionJsonlTurns,
  readSessionJsonlMetadataFromFile,
  readThreadTurnsListPageFromSessionJsonl,
} = require("../../../src/providers/codex/session-jsonl-history");

function jsonl(...entries) {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

// ─── parseSessionJsonlTurns ────────────────────────────────────────────────

test("parseSessionJsonlTurns picks up session id from session_meta and tags every turn with it", () => {
  const content = jsonl(
    { type: "session_meta", payload: { id: "thr-meta" }, timestamp: "2026-05-06T00:00:00Z" },
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" }, timestamp: "2026-05-06T00:00:01Z" },
    { type: "response_item", payload: { type: "message", role: "assistant", id: "m-1", content: [{ type: "output_text", text: "hi" }], turn_id: "t-1" }, timestamp: "2026-05-06T00:00:02Z" }
  );

  const turns = parseSessionJsonlTurns(content);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].id, "t-1");
  assert.equal(turns[0].threadId, "thr-meta");
  assert.equal(turns[0].items.length, 1);
});

test("parseSessionJsonlTurns prefers an explicitly-passed threadId over the file's session_meta", () => {
  const content = jsonl(
    { type: "session_meta", payload: { id: "thr-from-file" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }], turn_id: "t-1" } }
  );
  const turns = parseSessionJsonlTurns(content, { threadId: "thr-explicit" });
  assert.equal(turns[0].threadId, "thr-explicit");
});

test("parseSessionJsonlTurns marks the turn completed when a task_complete event arrives", () => {
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }], turn_id: "t-1" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "t-1" } }
  );
  const turns = parseSessionJsonlTurns(content);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, "completed");
});

test("parseSessionJsonlTurns treats aborted and error events as terminal statuses", () => {
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-aborted" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }], turn_id: "t-aborted" } },
    { type: "event_msg", payload: { type: "turn_aborted", turn_id: "t-aborted" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-error" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "failed" }], turn_id: "t-error" } },
    { type: "event_msg", payload: { type: "error", turn_id: "t-error" } }
  );

  const turns = parseSessionJsonlTurns(content);

  assert.equal(turns.length, 2);
  assert.equal(turns[0].status, "aborted");
  assert.equal(turns[1].status, "failed");
});

test("parseSessionJsonlTurns captures user_message events as user-role items", () => {
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } },
    { type: "event_msg", payload: { type: "user_message", message: "hello there", turn_id: "t-1", id: "u-1" } }
  );
  const turns = parseSessionJsonlTurns(content);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].items.length, 1);
  assert.equal(turns[0].items[0].type, "user_message");
  assert.equal(turns[0].items[0].role, "user");
  assert.equal(turns[0].items[0].text, "hello there");
});

test("parseSessionJsonlTurns skips injected context user_message events", () => {
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } },
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "# AGENTS.md instructions for /Users/me/project\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>",
        turn_id: "t-1",
        id: "ctx-agents",
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Continue the task",
        turn_id: "t-1",
        id: "real-user",
      },
    }
  );

  const turns = parseSessionJsonlTurns(content);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].items.map((item) => item.id), ["real-user"]);
});

test("parseSessionJsonlTurns extracts visible text from wrapped user_message events", () => {
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } },
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: [
          "<environment_context>",
          "  <cwd>/Users/me/project</cwd>",
          "</environment_context>",
          "",
          "## My request for Codex:",
          "Fix the failing parser test",
        ].join("\n"),
        turn_id: "t-1",
        id: "wrapped-user",
      },
    }
  );

  const turns = parseSessionJsonlTurns(content);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].items[0].id, "wrapped-user");
  assert.equal(turns[0].items[0].text, "Fix the failing parser test");
});

test("parseSessionJsonlTurns falls back to the active turn id when an event omits turn_id", () => {
  // The parser remembers the most recent task_started turn id and applies it to
  // subsequent events that don't have one. response_items without an explicit
  // turn_id should land on whichever turn is currently active.
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-active" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "from active" }] } }
  );
  const turns = parseSessionJsonlTurns(content);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].id, "t-active");
  assert.equal(turns[0].items.length, 1);
});

test("parseSessionJsonlTurns normalizes tool-call types: functionCall → tool_call", () => {
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } },
    { type: "response_item", payload: { type: "function_call", name: "Bash", id: "fc-1", turn_id: "t-1" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "fc-1", output: "...", turn_id: "t-1" } }
  );
  const turns = parseSessionJsonlTurns(content);
  const types = turns[0].items.map((i) => i.type);
  assert.deepEqual(types, ["tool_call", "tool_call_output"]);
});

test("parseSessionJsonlTurns defaults message role to assistant when one is missing", () => {
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } },
    { type: "response_item", payload: { type: "message", id: "m-1", content: [{ type: "output_text", text: "hi" }], turn_id: "t-1" } }
  );
  const turns = parseSessionJsonlTurns(content);
  assert.equal(turns[0].items[0].role, "assistant");
});

test("parseSessionJsonlTurns uses nested response-item turn ownership across interleaved turns", () => {
  const nestedTurn = (turnId) => ({
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
  const content = jsonl(
    { timestamp: "2026-07-08T18:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
    { timestamp: "2026-07-08T18:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-b" } },
    {
      timestamp: "2026-07-08T18:00:02.000Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        id: "reasoning-a",
        summary: [{ type: "summary_text", text: "Reasoning for A" }],
        ...nestedTurn("turn-a"),
      },
    },
    {
      timestamp: "2026-07-08T18:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        id: "plan-a",
        name: "update_plan",
        call_id: "plan-a",
        arguments: JSON.stringify({
          explanation: "Plan A",
          plan: [{ step: "Keep A isolated", status: "in_progress" }],
        }),
        ...nestedTurn("turn-a"),
      },
    },
    {
      timestamp: "2026-07-08T18:00:04.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "assistant-b",
        role: "assistant",
        content: [{ type: "output_text", text: "Answer B" }],
        ...nestedTurn("turn-b"),
      },
    },
    {
      timestamp: "2026-07-08T18:00:05.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "assistant-a",
        role: "assistant",
        content: [{ type: "output_text", text: "Answer A" }],
        ...nestedTurn("turn-a"),
      },
    }
  );

  const turns = parseSessionJsonlTurns(content, { threadId: "thread-interleaved" });
  const turnA = turns.find((turn) => turn.id === "turn-a");
  const turnB = turns.find((turn) => turn.id === "turn-b");

  assert.ok(turnA);
  assert.ok(turnB);
  assert.deepEqual(
    turnA.items.map((item) => item.id),
    ["reasoning-a", "plan-a", "assistant-a"]
  );
  assert.deepEqual(turnB.items.map((item) => item.id), ["assistant-b"]);
});

test("parseSessionJsonlTurns skips injected context user response items", () => {
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "ctx-agents",
        content: [{
          type: "input_text",
          text: "# AGENTS.md instructions for /Users/me/project\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>",
        }],
        turn_id: "t-1",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "real-user",
        content: [{ type: "input_text", text: "Continue the task" }],
        turn_id: "t-1",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        id: "assistant",
        content: [{ type: "output_text", text: "Continuing" }],
        turn_id: "t-1",
      },
    }
  );

  const turns = parseSessionJsonlTurns(content);
  assert.deepEqual(turns[0].items.map((item) => item.id), ["real-user", "assistant"]);
});

test("parseSessionJsonlTurns skips invalid JSON lines and empty lines without crashing", () => {
  const content = [
    '',
    'not-json-at-all',
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } }),
    '   ',
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }], turn_id: "t-1" } }),
  ].join("\n");
  const turns = parseSessionJsonlTurns(content);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].items.length, 1);
});

test("parseSessionJsonlTurns drops turns that have no items (e.g. only a stray task_started)", () => {
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-empty" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-real" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "real" }], turn_id: "t-real" } }
  );
  const turns = parseSessionJsonlTurns(content);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].id, "t-real");
});

test("parseSessionJsonlTurns ignores agent_message events to avoid double-counting streaming text", () => {
  // The final assistant text is republished as a response_item; surfacing the
  // streaming event_msg.agent_message would render the same content twice.
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } },
    { type: "event_msg", payload: { type: "agent_message", message: "streaming chunk", turn_id: "t-1" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "final" }], turn_id: "t-1" } }
  );
  const turns = parseSessionJsonlTurns(content);
  // Only ONE item survives — the response_item. The streaming event_msg.agent_message
  // was dropped so the iOS client doesn't render the same text twice.
  assert.equal(turns[0].items.length, 1);
  assert.equal(turns[0].items[0].type, "message");
  assert.equal(turns[0].items[0].content[0].text, "final");
});

test("parseSessionJsonlTurns drops expanded skill context user items", () => {
  const expandedSkillContext = [
    "<skill>",
    "<name>check-code</name>",
    "<path>$check-code</path>",
    "---",
    "name: check-code",
    "description: Review recent code changes across a repository.",
    "</skill>",
  ].join("\n");
  const content = jsonl(
    {
      timestamp: "2026-05-24T21:53:47.000Z",
      type: "session_meta",
      payload: { id: "thread-jsonl-expanded-skill" },
    },
    {
      timestamp: "2026-05-24T21:53:51.100Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-jsonl-expanded-skill" },
    },
    {
      timestamp: "2026-05-24T21:53:51.133Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: expandedSkillContext }],
      },
    },
    {
      timestamp: "2026-05-24T21:53:52.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        turn_id: "turn-jsonl-expanded-skill",
        message: expandedSkillContext,
      },
    },
    {
      timestamp: "2026-05-24T21:53:53.000Z",
      type: "response_item",
      payload: {
        id: "assistant-final",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    }
  );

  const turns = parseSessionJsonlTurns(content, { threadId: "thread-jsonl-expanded-skill" });
  const userItems = turns.flatMap((turn) => turn.items.filter((item) => item.role === "user"));

  assert.equal(userItems.length, 0);
  assert.equal(turns[0].items.some((item) => item.role === "assistant"), true);
});

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
