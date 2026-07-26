// FILE: rollout-live-mirror-utils.js
// Purpose: Pure helper utilities for desktop rollout live mirroring.
// Layer: CLI helper
// Exports: rollout parsing, ID, file, and tool normalization helpers
// Depends on: fs-compatible modules, crypto, path, Codex generated-image paths

const crypto = require("crypto");
const path = require("path");
const { resolveCodexGeneratedImagesRoot } = require("../providers/codex/home");

function isDesktopRolloutOrigin(sessionMeta) {
  const originator = readString(sessionMeta?.originator).toLowerCase();
  const source = readString(sessionMeta?.source).toLowerCase();
  if (!originator && !source) {
    return false;
  }

  if (originator.includes("mobile") || originator.includes("ios")) {
    return false;
  }

  return originator.includes("desktop")
    || originator.includes("vscode")
    || source.includes("vscode")
    || source.includes("desktop");
}

function extractReasoningText(payload) {
  const summary = Array.isArray(payload?.summary)
    ? payload.summary
        .map((part) => readString(part?.text) || readString(part?.summary))
        .filter(Boolean)
        .join("\n")
    : "";
  return firstNonEmptyString([
    summary,
    readString(payload?.text),
    readString(payload?.content),
  ]);
}

function parseToolArguments(rawArguments) {
  const parsed = safeParseJSON(rawArguments);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function normalizeProgressPlanSteps(rawPlan) {
  if (!Array.isArray(rawPlan)) {
    return [];
  }

  return rawPlan.flatMap((rawStep) => {
    if (!rawStep || typeof rawStep !== "object") {
      return [];
    }

    const step = readString(rawStep.step);
    const status = normalizeProgressPlanStatus(rawStep.status);
    if (!step || !status) {
      return [];
    }

    return [{ step, status }];
  });
}

function normalizeProgressPlanStatus(rawStatus) {
  const normalized = readString(rawStatus);
  switch (normalized) {
  case "pending":
  case "in_progress":
  case "inProgress":
  case "completed":
    return normalized;
  default:
    return "";
  }
}

function resolveToolCommand(toolName, argumentsObject) {
  if (isCommandToolName(toolName)) {
    return firstNonEmptyString([
      readString(argumentsObject.cmd),
      readString(argumentsObject.command),
      readString(argumentsObject.raw_command),
      readString(argumentsObject.rawCommand),
    ]) || toolName;
  }

  return toolName;
}

function resolveToolWorkingDirectory(argumentsObject, state) {
  return firstNonEmptyString([
    readString(argumentsObject.workdir),
    readString(argumentsObject.cwd),
    readString(argumentsObject.working_directory),
    readString(state.sessionMeta?.cwd),
  ]) || "";
}

function isCommandToolName(toolName) {
  const normalized = readString(toolName).toLowerCase();
  return normalized === "exec_command" || normalized === "shell_command";
}

function isInternalProgressPlanToolName(toolName) {
  return readString(toolName).toLowerCase() === "update_plan";
}

function genericToolActivityMessage(toolName) {
  switch (readString(toolName).toLowerCase()) {
  case "apply_patch":
    return "Applying patch";
  case "write_stdin":
    return "Writing to terminal";
  case "read_thread_terminal":
    return "Reading terminal output";
  default:
    return `Running ${toolName}`;
  }
}

function genericToolCompletionMessage(toolName) {
  switch (readString(toolName).toLowerCase()) {
  case "apply_patch":
    return "Applied patch";
  case "write_stdin":
    return "Wrote to terminal";
  case "read_thread_terminal":
    return "Read terminal output";
  default:
    return `Completed ${readString(toolName)}`;
  }
}

function createNotification(method, params) {
  return { method, params };
}

function buildSyntheticItemId(kind, threadId, turnId, suffix = "") {
  const suffixPart = suffix ? `:${suffix}` : "";
  return `rollout-${kind}:${threadId}:${turnId}${suffixPart}`;
}

function buildSyntheticTurnId(state, entry) {
  const timestamp = readString(entry?.timestamp) || "unknown";
  return `rollout-turn:${state.threadId}:${timestamp}`;
}

function readUserMessageTimestamp(entry, payload = {}) {
  return firstNonEmptyString([
    readString(payload.createdAt),
    readString(payload.created_at),
    readString(payload.timestamp),
    readString(payload.time),
    readString(entry?.timestamp),
  ]);
}

function timestampParams(timestamp) {
  const normalizedTimestamp = readString(timestamp);
  return normalizedTimestamp
    ? { createdAt: normalizedTimestamp, timestamp: normalizedTimestamp }
    : {};
}

function buildAgentMessageItemId(threadId, turnId, entry, message) {
  const timestamp = readString(entry?.timestamp) || "untimed";
  const messageHash = crypto
    .createHash("sha256")
    .update(readString(message))
    .digest("hex")
    .slice(0, 12);
  return buildSyntheticItemId(
    "agent-message",
    threadId,
    turnId || "turnless",
    `${timestamp}:${messageHash}`
  );
}

function agentMessageDedupeKey(turnId, message) {
  return `${readString(turnId)}\n${readString(message)}`;
}

function generatedImagePathForRolloutItem(threadId, callId) {
  const resolvedThreadId = readString(threadId);
  const resolvedCallId = readString(callId);
  if (!resolvedThreadId || !resolvedCallId) {
    return "";
  }

  return path.join(resolveCodexGeneratedImagesRoot(), resolvedThreadId, `${resolvedCallId}.png`);
}

function normalizeRolloutItemType(value) {
  return readString(value).replace(/[_-]/g, "").toLowerCase();
}

function readThreadId(params) {
  return firstNonEmptyString([
    readString(params?.threadId),
    readString(params?.thread_id),
  ]) || "";
}

function readFileSize(filePath, fsModule) {
  return fsModule.statSync(filePath).size;
}

function readFileSlice(filePath, start, endExclusive, fsModule) {
  const length = Math.max(0, endExclusive - start);
  if (length === 0) {
    return "";
  }

  const fileHandle = fsModule.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fsModule.readSync(fileHandle, buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    fsModule.closeSync(fileHandle);
  }
}

function safeParseJSON(rawValue) {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return null;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return null;
  }
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

module.exports = {
  agentMessageDedupeKey,
  buildAgentMessageItemId,
  buildSyntheticItemId,
  buildSyntheticTurnId,
  createNotification,
  extractReasoningText,
  firstNonEmptyString,
  generatedImagePathForRolloutItem,
  genericToolActivityMessage,
  genericToolCompletionMessage,
  isCommandToolName,
  isDesktopRolloutOrigin,
  isInternalProgressPlanToolName,
  normalizeProgressPlanSteps,
  normalizeProgressPlanStatus,
  normalizeRolloutItemType,
  parseToolArguments,
  readFileSize,
  readFileSlice,
  readString,
  readThreadId,
  readUserMessageTimestamp,
  resolveToolCommand,
  resolveToolWorkingDirectory,
  safeParseJSON,
  timestampParams,
};
