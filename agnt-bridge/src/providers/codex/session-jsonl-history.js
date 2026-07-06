// FILE: providers/codex/session-jsonl-history.js
// Purpose: Reconstructs a small thread/turns/list page from local Codex session JSONL files
//          when the live bridge response is empty. Codex-specific because it parses Codex's
//          rollout schema (`session_meta`, `event_msg`, `response_item`); other providers
//          reconstruct history through their own translator's reconstructThreadFrom*().
// Layer: provider plugin (codex)
// Exports: parseSessionJsonlMetadata, parseSessionJsonlTurns, readThreadTurnsListPageFromSessionJsonl
// Depends on: fs

const fs = require("fs");
const {
  historyItemUserText,
  isContextualUserText,
  isUserRoleHistoryItem,
  visibleUserPromptText,
} = require("../../bridge/contextual-user-items");

function readThreadTurnsListPageFromSessionJsonl(filePath, {
  threadId = "",
  limit = 5,
  maxLimit = 5,
  cursor = null,
  fsModule = fs,
} = {}) {
  if (!filePath || cursor != null) {
    return null;
  }

  const content = fsModule.readFileSync(filePath, "utf8");
  const turns = parseSessionJsonlTurns(content, { threadId });
  if (turns.length === 0) {
    return null;
  }

  const requestedLimit = Number.isInteger(limit) && limit > 0 ? limit : 5;
  const requestedMaxLimit = Number.isInteger(maxLimit) && maxLimit > 0 ? maxLimit : 5;
  const safeLimit = Math.min(requestedLimit, requestedMaxLimit, 5);
  const pageTurns = turns.slice(-safeLimit).reverse();
  return {
    data: pageTurns,
    nextCursor: turns.length > pageTurns.length ? "agnt-jsonl-fallback-older-unavailable" : null,
    agntJsonlFallback: true,
  };
}

function parseSessionJsonlMetadata(content) {
  const metadata = {};
  const lines = String(content || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry?.type !== "session_meta") {
      continue;
    }

    const payload = objectValue(entry.payload);
    if (!payload) {
      continue;
    }

    metadata.threadId ||= normalizeString(payload.id)
      || normalizeString(payload.thread_id)
      || normalizeString(payload.threadId);
    metadata.cwd ||= normalizeString(payload.cwd)
      || normalizeString(payload.current_working_directory)
      || normalizeString(payload.currentWorkingDirectory)
      || normalizeString(payload.working_directory)
      || normalizeString(payload.workingDirectory);
  }

  return metadata;
}

function parseSessionJsonlTurns(content, { threadId = "" } = {}) {
  const turns = [];
  const turnsById = new Map();
  let activeTurnId = "";
  let sessionThreadId = normalizeString(threadId);

  const lines = String(content || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry?.type === "session_meta") {
      const payload = objectValue(entry.payload);
      sessionThreadId ||= normalizeString(payload?.id)
        || normalizeString(payload?.thread_id)
        || normalizeString(payload?.threadId);
      continue;
    }

    if (entry?.type === "event_msg") {
      const payload = objectValue(entry.payload);
      const eventType = normalizeString(payload?.type);
      if (eventType === "task_started") {
        activeTurnId = normalizeString(payload?.turn_id)
          || normalizeString(payload?.turnId)
          || activeTurnId
          || `turn-line-${index + 1}`;
        ensureTurn(turns, turnsById, activeTurnId, sessionThreadId, entry.timestamp);
        continue;
      }

      if (eventType === "task_complete") {
        const turn = ensureTurn(
          turns,
          turnsById,
          normalizeString(payload?.turn_id) || normalizeString(payload?.turnId) || activeTurnId || `turn-line-${index + 1}`,
          sessionThreadId,
          entry.timestamp
        );
        turn.status = "completed";
        continue;
      }

      if (eventType === "user_message") {
        const text = visibleUserPromptText(
          normalizeString(payload?.message) || normalizeString(payload?.text)
        );
        if (!text) {
          continue;
        }
        const turn = ensureTurn(
          turns,
          turnsById,
          normalizeString(payload?.turn_id) || normalizeString(payload?.turnId) || activeTurnId || `turn-line-${index + 1}`,
          sessionThreadId,
          entry.timestamp
        );
        turn.items.push({
          id: normalizeString(payload?.id) || `user-message-line-${index + 1}`,
          type: "user_message",
          role: "user",
          text,
        });
        continue;
      }

      // The final assistant text is usually present again as a response_item message.
      // Skipping event agent_message avoids double-rendering streaming/final chunks.
      continue;
    }

    if (entry?.type === "response_item") {
      const payload = objectValue(entry.payload);
      if (!payload) {
        continue;
      }
      const turn = ensureTurn(
        turns,
        turnsById,
        normalizeString(payload.turn_id) || normalizeString(payload.turnId) || activeTurnId || `turn-line-${index + 1}`,
        sessionThreadId,
        entry.timestamp
      );
      const item = normalizeResponseItemForHistory(payload, index + 1);
      if (item) {
        turn.items.push(item);
      }
    }
  }

  return turns.filter((turn) => turn.items.length > 0);
}

function ensureTurn(turns, turnsById, turnId, threadId, timestamp) {
  const normalizedTurnId = normalizeString(turnId) || `turn-${turns.length + 1}`;
  let turn = turnsById.get(normalizedTurnId);
  if (!turn) {
    turn = {
      id: normalizedTurnId,
      threadId: normalizeString(threadId) || undefined,
      createdAt: normalizeString(timestamp) || undefined,
      status: "running",
      items: [],
    };
    turnsById.set(normalizedTurnId, turn);
    turns.push(turn);
  }
  if (!turn.createdAt && timestamp) {
    turn.createdAt = normalizeString(timestamp);
  }
  return turn;
}

function normalizeResponseItemForHistory(payload, lineNumber) {
  const type = normalizeHistoryItemType(payload.type);
  if (!type) {
    return null;
  }

  const item = {
    ...payload,
    id: normalizeString(payload.id)
      || normalizeString(payload.item_id)
      || normalizeString(payload.itemId)
      || `response-item-line-${lineNumber}`,
    type,
  };

  if (type === "message" && !normalizeString(item.role)) {
    item.role = "assistant";
  }

  if (isUserRoleHistoryItem(item) && isContextualUserText(historyItemUserText(item))) {
    return null;
  }

  return item;
}

function normalizeHistoryItemType(rawType) {
  const normalized = normalizeString(rawType).toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) {
    return "";
  }
  if (normalized === "functioncall") {
    return "tool_call";
  }
  if (normalized === "functioncalloutput") {
    return "tool_call_output";
  }
  return rawType;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  parseSessionJsonlMetadata,
  parseSessionJsonlTurns,
  readThreadTurnsListPageFromSessionJsonl,
};
