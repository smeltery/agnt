// FILE: session-jsonl-history.test.js
// Purpose: Unit tests for the Codex JSONL session history parser and item normalization.
// Layer: Unit test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSessionJsonlTurns } = require("../../../src/providers/codex/session-jsonl-history");

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

test("parseSessionJsonlTurns unwraps an exec wrapper into its real nested tool call", () => {
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "call-outer-exec",
        status: "completed",
        turn_id: "t-1",
        input: [
          "const result = await tools.exec_command({",
          "  cmd: \"gh run view 30709849174 --json status\",",
          "  workdir: \"/repo\",",
          "});",
          "text(result.output);",
        ].join("\n"),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call-outer-exec",
        output: "completed",
        turn_id: "t-1",
      },
    }
  );

  const turns = parseSessionJsonlTurns(content);
  const toolCall = turns[0].items.find((item) => item.type === "tool_call");
  assert.equal(toolCall.name, "exec_command");
  assert.deepEqual(JSON.parse(toolCall.arguments), {
    cmd: "gh run view 30709849174 --json status",
    workdir: "/repo",
  });
  assert.equal(turns[0].items.some((item) => item.name === "exec"), false);
});

test("parseSessionJsonlTurns suppresses cell-backed orchestration wait calls and their output", () => {
  const content = jsonl(
    { type: "event_msg", payload: { type: "task_started", turn_id: "t-1" } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "wait",
        call_id: "call-cell-wait",
        turn_id: "t-1",
        arguments: JSON.stringify({ cell_id: "382", yield_time_ms: 30000 }),
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-cell-wait", output: "completed", turn_id: "t-1" },
    },
    { type: "response_item", payload: { type: "message", id: "m-1", content: [{ type: "output_text", text: "done" }], turn_id: "t-1" } }
  );

  const turns = parseSessionJsonlTurns(content);
  assert.equal(turns[0].items.some((item) => item.name === "wait" || item.call_id === "call-cell-wait"), false);
  assert.equal(turns[0].items.length, 1);
  assert.equal(turns[0].items[0].type, "message");
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

test("parseSessionJsonlTurns hides injected desktop preamble before the prompt", () => {
  const content = jsonl(
    { timestamp: "2026-07-25T00:39:28.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-opener" } },
    {
      timestamp: "2026-07-25T00:39:30.000Z",
      type: "response_item",
      payload: {
        id: "injected-preamble",
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<recommended_plugins>\n- Figma\n</recommended_plugins>" },
          { type: "input_text", text: "# AGENTS.md instructions for /Users/me/proj\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>" },
          { type: "input_text", text: "<environment_context>\n  <cwd>/Users/me/proj</cwd>\n</environment_context>" },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-opener" },
      },
    },
    {
      timestamp: "2026-07-25T00:39:30.100Z",
      type: "response_item",
      payload: {
        id: "real-prompt",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "check the release" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-opener" },
      },
    },
    { timestamp: "2026-07-25T00:41:00.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-opener" } }
  );

  const turns = parseSessionJsonlTurns(content, { threadId: "thread-opener" });
  const serialized = JSON.stringify(turns);
  const userItems = turns[0].items.filter((item) => item.role === "user");

  assert.equal(serialized.includes("recommended_plugins"), false);
  assert.equal(serialized.includes("AGENTS.md instructions"), false);
  assert.equal(serialized.includes("environment_context"), false);
  assert.equal(userItems.length, 1);
  assert.equal(userItems[0].content[0].text, "check the release");
});

test("parseSessionJsonlTurns keeps request sharing an item with injected context", () => {
  const content = jsonl(
    { timestamp: "2026-07-25T00:39:28.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-mixed" } },
    {
      timestamp: "2026-07-25T00:39:30.000Z",
      type: "response_item",
      payload: {
        id: "mixed-opener",
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<recommended_plugins>\n- Figma\n</recommended_plugins>" },
          { type: "input_text", text: "check the release" },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-mixed" },
      },
    },
    { timestamp: "2026-07-25T00:41:00.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-mixed" } }
  );

  const turns = parseSessionJsonlTurns(content, { threadId: "thread-mixed" });
  const userItems = turns[0].items.filter((item) => item.role === "user");

  assert.equal(JSON.stringify(turns).includes("recommended_plugins"), false);
  assert.equal(userItems.length, 1);
  assert.deepEqual(userItems[0].content, [{ type: "input_text", text: "check the release" }]);
});
