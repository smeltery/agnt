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
const {
  parseSessionJsonlTurns,
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
