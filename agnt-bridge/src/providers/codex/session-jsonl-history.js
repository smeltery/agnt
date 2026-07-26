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
  sanitizeUserRoleItem,
  visibleUserPromptText,
} = require("../../bridge/contextual-user-items");

const JSONL_OLDER_HANDOFF_CURSOR = "agnt-jsonl-fallback-older-unavailable";
const DEFAULT_SESSION_JSONL_METADATA_HEAD_BYTES = 256 * 1024;
const DEFAULT_SESSION_JSONL_INITIAL_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_SESSION_JSONL_MAX_TAIL_BYTES = 64 * 1024 * 1024;

function readThreadTurnsListPageFromSessionJsonl(filePath, {
  threadId = "",
  limit = 5,
  maxLimit = 5,
  cursor = null,
  fsModule = fs,
  metadataHeadBytes = DEFAULT_SESSION_JSONL_METADATA_HEAD_BYTES,
  initialTailBytes = DEFAULT_SESSION_JSONL_INITIAL_TAIL_BYTES,
  maxTailBytes = DEFAULT_SESSION_JSONL_MAX_TAIL_BYTES,
} = {}) {
  if (!filePath || cursor != null) {
    return null;
  }

  const recent = readRecentSessionJsonlTurns(filePath, {
    threadId,
    limit: Math.min(
      Number.isInteger(limit) && limit > 0 ? limit : 5,
      Number.isInteger(maxLimit) && maxLimit > 0 ? maxLimit : 5,
      5
    ),
    fsModule,
    metadataHeadBytes,
    initialTailBytes,
    maxTailBytes,
  });
  const turns = recent?.turns || [];
  if (turns.length === 0) {
    return null;
  }

  const requestedLimit = Number.isInteger(limit) && limit > 0 ? limit : 5;
  const requestedMaxLimit = Number.isInteger(maxLimit) && maxLimit > 0 ? maxLimit : 5;
  const safeLimit = Math.min(requestedLimit, requestedMaxLimit, 5);
  const pageTurns = turns.slice(-safeLimit).reverse();
  return {
    data: pageTurns,
    nextCursor: recent.hasOlderTurns || turns.length > pageTurns.length ? JSONL_OLDER_HANDOFF_CURSOR : null,
    agntJsonlFallback: true,
  };
}

function readRecentSessionJsonlTurns(filePath, {
  threadId = "",
  limit = 5,
  fsModule = fs,
  metadataHeadBytes = DEFAULT_SESSION_JSONL_METADATA_HEAD_BYTES,
  initialTailBytes = DEFAULT_SESSION_JSONL_INITIAL_TAIL_BYTES,
  maxTailBytes = DEFAULT_SESSION_JSONL_MAX_TAIL_BYTES,
} = {}) {
  if (!filePath) {
    return null;
  }

  if (!supportsBoundedSessionJsonlReads(fsModule)) {
    const content = fsModule.readFileSync(filePath, "utf8");
    const turns = parseSessionJsonlTurns(content, { threadId });
    return turns.length > 0 ? { turns, hasOlderTurns: false, bytesRead: Buffer.byteLength(content, "utf8") } : null;
  }

  const stat = fsModule.statSync(filePath);
  const snapshotSize = Math.max(0, Number(stat?.size) || 0);
  if (snapshotSize === 0) {
    return null;
  }

  const safeLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 5, 5));
  const safeMetadataHeadBytes = Math.max(1, Math.min(metadataHeadBytes, snapshotSize));
  const safeMaximumTailBytes = Math.max(1, Math.min(maxTailBytes, snapshotSize));
  let tailBytes = Math.max(1, Math.min(initialTailBytes, safeMaximumTailBytes));
  const fileHandle = fsModule.openSync(filePath, "r");

  try {
    const metadataBuffer = readSessionJsonlRange(fileHandle, 0, safeMetadataHeadBytes, fsModule);
    const initialMetadata = parseSessionJsonlMetadata(metadataBuffer.toString("utf8"));

    while (true) {
      const rawStart = Math.max(0, snapshotSize - tailBytes);
      const tailBuffer = readSessionJsonlRange(fileHandle, rawStart, snapshotSize - rawStart, fsModule);
      const aligned = alignSessionJsonlTailBuffer(tailBuffer, rawStart);
      if (aligned) {
        const content = aligned.buffer.toString("utf8");
        const sourceLineByteOffsets = sessionJsonlLineByteOffsets(aligned.buffer, aligned.sourceByteOffset);
        const turns = parseSessionJsonlTurns(content, {
          threadId,
          initialMetadata,
          sourceLineByteOffsets,
        });
        const observedStartedTurnIDs = observedTaskStartedTurnIDs(content, { sourceLineByteOffsets });
        const safeTurns = rawStart === 0
          ? turns
          : turns.filter((turn) => (
            observedStartedTurnIDs.has(normalizeString(turn?.id))
              && turnHasVisibleUserItem(turn)
          ));

        if (safeTurns.length >= safeLimit || tailBytes >= safeMaximumTailBytes || rawStart === 0) {
          if (safeTurns.length === 0) {
            return null;
          }
          return {
            turns: safeTurns,
            hasOlderTurns: rawStart > 0 || turns.length > safeTurns.length,
            bytesRead: metadataBuffer.length + tailBuffer.length,
          };
        }
      }

      if (tailBytes >= safeMaximumTailBytes || rawStart === 0) {
        return null;
      }
      tailBytes = Math.min(safeMaximumTailBytes, tailBytes * 2);
    }
  } finally {
    fsModule.closeSync(fileHandle);
  }
}

function readSessionJsonlMetadataFromFile(filePath, {
  fsModule = fs,
  metadataHeadBytes = DEFAULT_SESSION_JSONL_METADATA_HEAD_BYTES,
} = {}) {
  if (!filePath) {
    return { threadId: "", cwd: "" };
  }
  if (!supportsBoundedSessionJsonlReads(fsModule)) {
    return parseSessionJsonlMetadata(fsModule.readFileSync(filePath, "utf8"));
  }

  const stat = fsModule.statSync(filePath);
  const snapshotSize = Math.max(0, Number(stat?.size) || 0);
  if (snapshotSize === 0) {
    return { threadId: "", cwd: "" };
  }
  const fileHandle = fsModule.openSync(filePath, "r");
  try {
    const head = readSessionJsonlRange(
      fileHandle,
      0,
      Math.min(snapshotSize, Math.max(1, metadataHeadBytes)),
      fsModule
    );
    return parseSessionJsonlMetadata(head.toString("utf8"));
  } finally {
    fsModule.closeSync(fileHandle);
  }
}

function supportsBoundedSessionJsonlReads(fsModule) {
  return typeof fsModule?.statSync === "function"
    && typeof fsModule?.openSync === "function"
    && typeof fsModule?.readSync === "function"
    && typeof fsModule?.closeSync === "function";
}

function readSessionJsonlRange(fileHandle, start, length, fsModule) {
  const safeLength = Math.max(0, length);
  const buffer = Buffer.allocUnsafe(safeLength);
  const bytesRead = safeLength > 0
    ? fsModule.readSync(fileHandle, buffer, 0, safeLength, start)
    : 0;
  return buffer.subarray(0, bytesRead);
}

function alignSessionJsonlTailBuffer(buffer, rawStart) {
  if (rawStart === 0) {
    return { buffer, sourceByteOffset: 0 };
  }
  const firstLineFeed = buffer.indexOf(0x0a);
  if (firstLineFeed === -1 || firstLineFeed + 1 >= buffer.length) {
    return null;
  }
  return {
    buffer: buffer.subarray(firstLineFeed + 1),
    sourceByteOffset: rawStart + firstLineFeed + 1,
  };
}

function sessionJsonlLineByteOffsets(buffer, sourceByteOffset) {
  const offsets = [sourceByteOffset];
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a && index + 1 < buffer.length) {
      offsets.push(sourceByteOffset + index + 1);
    }
  }
  return offsets;
}

function observedTaskStartedTurnIDs(content, { sourceLineByteOffsets = null } = {}) {
  const turnIDs = new Set();
  const lines = String(content || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      const payload = objectValue(entry?.payload);
      if (entry?.type !== "event_msg" || normalizeString(payload?.type) !== "task_started") {
        continue;
      }
      const sourceLineNumber = sourceLineByteOffsets?.[index] ?? index + 1;
      const turnID = normalizeString(payload?.turn_id)
        || normalizeString(payload?.turnId)
        || `turn-line-${sourceLineNumber}`;
      if (turnID) {
        turnIDs.add(turnID);
      }
    } catch {
      // A live rollout may end with a partial line; ignore it until the next read.
    }
  }
  return turnIDs;
}

function turnHasVisibleUserItem(turn) {
  return Array.isArray(turn?.items) && turn.items.some((item) => isUserRoleHistoryItem(item));
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

function parseSessionJsonlTurns(content, {
  threadId = "",
  initialMetadata = null,
  sourceLineByteOffsets = null,
} = {}) {
  const turns = [];
  const turnsById = new Map();
  let activeTurnId = "";
  let sessionThreadId = normalizeString(threadId) || normalizeString(initialMetadata?.threadId);

  const lines = String(content || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const sourceLineNumber = sourceLineByteOffsets?.[index] ?? index + 1;
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
          || `turn-line-${sourceLineNumber}`;
        ensureTurn(turns, turnsById, activeTurnId, sessionThreadId, entry.timestamp);
        continue;
      }

      if (eventType === "task_complete" || eventType === "turn_aborted" || eventType === "error") {
        const turn = ensureTurn(
          turns,
          turnsById,
          normalizeString(payload?.turn_id) || normalizeString(payload?.turnId) || activeTurnId || `turn-line-${sourceLineNumber}`,
          sessionThreadId,
          entry.timestamp
        );
        turn.status = terminalStatusForEventType(eventType);
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
          normalizeString(payload?.turn_id) || normalizeString(payload?.turnId) || activeTurnId || `turn-line-${sourceLineNumber}`,
          sessionThreadId,
          entry.timestamp
        );
        turn.items.push({
          id: normalizeString(payload?.id) || `user-message-line-${sourceLineNumber}`,
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
        responseItemTurnId(payload) || activeTurnId || `turn-line-${sourceLineNumber}`,
        sessionThreadId,
        entry.timestamp
      );
      const item = normalizeResponseItemForHistory(payload, sourceLineNumber);
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

  return isUserRoleHistoryItem(item) ? sanitizeUserRoleItem(item) : item;
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

function terminalStatusForEventType(eventType) {
  if (eventType === "turn_aborted") {
    return "aborted";
  }
  if (eventType === "error") {
    return "failed";
  }
  return "completed";
}

// Modern Codex rollouts can attach response-item ownership in metadata
// passthrough. Prefer it before the process-wide active turn so interleaved
// turns keep their tools, plans, and prose isolated.
function responseItemTurnId(payload) {
  const metadata = objectValue(payload?.internal_chat_message_metadata_passthrough);
  return normalizeString(payload?.turn_id)
    || normalizeString(payload?.turnId)
    || normalizeString(metadata?.turn_id)
    || normalizeString(metadata?.turnId);
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
  readRecentSessionJsonlTurns,
  readSessionJsonlMetadataFromFile,
  readThreadTurnsListPageFromSessionJsonl,
};
