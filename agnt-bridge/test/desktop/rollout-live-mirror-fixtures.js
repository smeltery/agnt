// FILE: rollout-live-mirror-fixtures.js
// Purpose: Provides JSONL rollout fixtures shared by rollout live mirror tests.
// Layer: Unit test helper
// Exports: rollout JSONL builders and temporary CODEX_HOME helpers
// Depends on: fs, os, path

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function createTemporaryRolloutHome({ threadId, originator, source, lines }) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-live-mirror-"));
  const threadDir = path.join(homeDir, "sessions", "2026", "03", "15");
  fs.mkdirSync(threadDir, { recursive: true });
  const rolloutPath = path.join(threadDir, `rollout-2026-03-15T19-47-36-${threadId}.jsonl`);
  const header = JSON.stringify({
    timestamp: "2026-03-15T19:47:36.019Z",
    type: "session_meta",
    payload: {
      id: threadId,
      cwd: "/repo",
      originator,
      source,
    },
  });
  fs.writeFileSync(rolloutPath, [header, ...lines, ""].join("\n"));
  return { homeDir, rolloutPath };
}

function appendRolloutLines(rolloutPath, lines) {
  fs.appendFileSync(rolloutPath, `${lines.join("\n")}\n`);
}

function taskStarted(turnId) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:37.000Z",
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: turnId,
      model_context_window: 258400,
    },
  });
}

function taskStartedWithoutTurnId() {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:37.000Z",
    type: "event_msg",
    payload: {
      type: "task_started",
      model_context_window: 258400,
    },
  });
}

function userMessage(message) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:36.500Z",
    type: "event_msg",
    payload: {
      type: "user_message",
      message,
    },
  });
}

function userMessagePayload(payload) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:36.500Z",
    type: "event_msg",
    payload: {
      type: "user_message",
      ...payload,
    },
  });
}

function agentMessage(message, phase = "final_answer") {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:40.000Z",
    type: "event_msg",
    payload: {
      type: "agent_message",
      message,
      phase,
    },
  });
}

function responseMessage(message, phase = "final_answer", id = "msg-response", turnId = "") {
  const payload = {
    type: "message",
    id,
    role: "assistant",
    phase,
    content: [
      {
        type: "output_text",
        text: message,
      },
    ],
  };
  if (turnId) {
    payload.internal_chat_message_metadata_passthrough = {
      turn_id: turnId,
    };
  }
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:40.000Z",
    type: "response_item",
    payload,
  });
}

function agentReasoning(title) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.000Z",
    type: "event_msg",
    payload: {
      type: "agent_reasoning",
      text: `**${title}**\n\n<!-- -->`,
    },
  });
}

function responseReasoning(id, titles) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.500Z",
    type: "response_item",
    payload: {
      type: "reasoning",
      id,
      summary: titles.map((title) => ({
        type: "summary_text",
        text: `**${title}**\n\n<!-- -->`,
      })),
    },
  });
}

function userMessageWithTimestamp(message, timestamp, id = "") {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "user_message",
      message,
      ...(id ? { id } : {}),
    },
  });
}

function planItemCompleted(turnId, itemId, text) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:40.500Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: turnId,
      item: {
        type: "Plan",
        id: itemId,
        text,
      },
    },
  });
}

function customToolCall(callId, name, input) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:38.500Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      status: "completed",
      call_id: callId,
      name,
      input,
    },
  });
}

function patchApplyEnd(turnId, callId) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:38.750Z",
    type: "event_msg",
    payload: {
      type: "patch_apply_end",
      turn_id: turnId,
      call_id: callId,
      status: "completed",
      stdout: "Success. Updated the following files:\nM Sources/App.swift\n",
    },
  });
}

function taskComplete(turnId) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:41.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: turnId,
    },
  });
}

function turnAborted(turnId) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:41.000Z",
    type: "event_msg",
    payload: {
      type: "turn_aborted",
      turn_id: turnId,
    },
  });
}

function errorEvent(turnId, message) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:41.000Z",
    type: "event_msg",
    payload: {
      type: "error",
      turn_id: turnId,
      message,
    },
  });
}

function functionCall(callId, name, argumentsObject) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:38.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: JSON.stringify(argumentsObject),
    },
  });
}

function functionCallOutput(callId, output) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: callId,
      output,
    },
  });
}

function imageGenerationCall(itemId) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.500Z",
    type: "response_item",
    payload: {
      id: itemId,
      type: "image_generation_call",
      status: "completed",
      result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    },
  });
}

function imageGenerationEnd(turnId, callId, savedPath) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.500Z",
    type: "event_msg",
    payload: {
      type: "image_generation_end",
      id: turnId,
      turn_id: turnId,
      call_id: callId,
      saved_path: savedPath,
      result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    },
  });
}

function imageViewItem(itemId, imagePath) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.500Z",
    type: "response_item",
    payload: {
      id: itemId,
      type: "imageView",
      path: imagePath,
    },
  });
}

function imageGenerationItem(itemId, imagePath) {
  return JSON.stringify({
    timestamp: "2026-03-15T19:47:39.500Z",
    type: "response_item",
    payload: {
      id: itemId,
      type: "image_generation",
      path: imagePath,
      result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    },
  });
}

function restoreCodexHome(previousCodexHome) {
  if (previousCodexHome == null) {
    delete process.env.CODEX_HOME;
    return;
  }
  process.env.CODEX_HOME = previousCodexHome;
}

module.exports = {
  agentMessage,
  agentReasoning,
  appendRolloutLines,
  createTemporaryRolloutHome,
  customToolCall,
  errorEvent,
  functionCall,
  functionCallOutput,
  imageGenerationCall,
  imageGenerationEnd,
  imageGenerationItem,
  imageViewItem,
  patchApplyEnd,
  planItemCompleted,
  responseMessage,
  responseReasoning,
  restoreCodexHome,
  taskComplete,
  taskStarted,
  taskStartedWithoutTurnId,
  turnAborted,
  userMessage,
  userMessagePayload,
  userMessageWithTimestamp,
};
