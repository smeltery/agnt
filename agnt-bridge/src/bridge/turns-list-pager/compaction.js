const {
  buildAdaptiveTurnsListResult,
  measureSanitizedTurnsListResponseBytes,
} = require("./utils");

const RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS = 24_000;

function buildSafeTurnsListResponse(requestId, firstResult, lastResult, turnsKey, turns) {
  return {
    id: requestId,
    result: buildAdaptiveTurnsListResult(firstResult, lastResult, turnsKey, turns),
  };
}

function buildLargestSafeTurnsListResponse({
  requestId,
  firstResult,
  lastResult,
  turnsKey,
  turns,
  maxTurns,
  sanitizeForRelay,
  payloadSoftLimitBytes,
}) {
  const sliceLimit = Math.min(turns.length, maxTurns);
  for (let count = sliceLimit; count > 0; count -= 1) {
    const response = buildSafeTurnsListResponse(
      requestId,
      firstResult,
      lastResult,
      turnsKey,
      turns.slice(0, count)
    );
    if (measureSanitizedTurnsListResponseBytes(response, sanitizeForRelay) < payloadSoftLimitBytes) {
      return response;
    }
  }
  return buildEmergencySingleTurnResponse({
    requestId,
    lastResult,
    turnsKey,
    turn: turns[0],
    sanitizeForRelay,
    payloadSoftLimitBytes,
  });
}

function buildEmergencySingleTurnResponse({
  requestId,
  lastResult,
  turnsKey,
  turn,
  sanitizeForRelay,
  payloadSoftLimitBytes,
}) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
    return null;
  }

  for (const maxItems of [16, 4, 1]) {
    for (const maxChars of [
      RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS,
      Math.floor(RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS / 4),
      1_000,
      0,
    ]) {
      const response = {
        id: requestId,
        result: {
          ...buildAdaptiveTurnsListResult({}, lastResult, turnsKey, [
            compactEmergencySingleTurnForRelay(turn, maxChars, maxItems),
          ]),
          agntEmergencySingleTurnForRelay: true,
        },
      };
      if (measureSanitizedTurnsListResponseBytes(response, sanitizeForRelay) < payloadSoftLimitBytes) {
        return response;
      }
    }
  }

  return null;
}

function compactEmergencySingleTurnForRelay(turn, maxChars, maxItems) {
  const safeTurn = {};
  for (const key of [
    "id",
    "turnId",
    "turn_id",
    "threadId",
    "thread_id",
    "createdAt",
    "created_at",
    "completedAt",
    "completed_at",
    "status",
    "role",
    "kind",
  ]) {
    const value = turn[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safeTurn[key] = value;
    }
  }

  const items = Array.isArray(turn.items) ? turn.items : [];
  safeTurn.items = items.slice(-maxItems).map((item) => compactHistoryItemForRelay(item, maxChars));
  safeTurn.agntEmergencySingleTurnForRelay = true;
  safeTurn.agntPageCompactedForRelay = true;
  return safeTurn;
}

function compactHistoryItemForRelay(item, maxChars) {
  const compactItem = {
    id: typeof item?.id === "string" ? item.id : undefined,
    type: typeof item?.type === "string" ? item.type : "relay_truncated_item",
    role: typeof item?.role === "string" ? item.role : undefined,
    itemId: typeof item?.itemId === "string" ? item.itemId : undefined,
    relayPayloadTruncated: true,
  };
  const tailText = maxChars > 0 ? firstRelayTextTail(item, maxChars) : "";
  if (tailText) {
    compactItem.text = tailText;
  }

  return Object.fromEntries(
    Object.entries(compactItem).filter(([, value]) => value !== undefined)
  );
}

function firstRelayTextTail(value, maxChars) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  for (const key of ["text", "message", "summary", "output", "outputText", "output_text"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return truncateRelayTextTail(value[key], maxChars);
    }
  }

  if (Array.isArray(value.content)) {
    for (const entry of value.content) {
      const tail = firstRelayTextTail(entry, maxChars);
      if (tail) {
        return tail;
      }
    }
  }

  return "";
}

function truncateRelayTextTail(value, maxChars) {
  if (typeof value !== "string" || value.length <= maxChars) {
    return value;
  }

  const tail = value.slice(-maxChars).trimStart();
  return `…\n${tail}`;
}

module.exports = {
  RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS,
  buildEmergencySingleTurnResponse,
  buildLargestSafeTurnsListResponse,
  buildSafeTurnsListResponse,
  compactEmergencySingleTurnForRelay,
  compactHistoryItemForRelay,
  firstRelayTextTail,
  truncateRelayTextTail,
};
