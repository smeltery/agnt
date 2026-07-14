const RELAY_TURNS_LIST_RESULT_KEYS = ["data", "items", "turns"];
const RELAY_TURNS_LIST_PAGINATION_RESULT_KEYS = [
  "nextCursor",
  "next_cursor",
  "cursor",
  "hasNextCursor",
  "has_next_cursor",
  "hasNextPage",
  "has_next_page",
  "hasMore",
  "has_more",
  "prevCursor",
  "prev_cursor",
  "previousCursor",
  "previous_cursor",
];

function readString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeNonEmptyString(value) {
  const str = readString(value).trim();
  return str.length > 0 ? str : "";
}

function findTurnsListResultKey(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  return RELAY_TURNS_LIST_RESULT_KEYS.find((key) => Array.isArray(result[key])) || null;
}

function buildAdaptiveTurnsListResult(firstResult, lastResult, turnsKey, turns) {
  const result = {
    ...firstResult,
  };
  for (const key of RELAY_TURNS_LIST_RESULT_KEYS) {
    delete result[key];
  }
  result[turnsKey] = turns;

  for (const key of RELAY_TURNS_LIST_PAGINATION_RESULT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(lastResult, key)) {
      result[key] = lastResult[key];
    } else {
      delete result[key];
    }
  }

  return result;
}

function hasRelayCursor(cursor) {
  return cursor !== undefined && cursor !== null && cursor !== "";
}

function measureSanitizedTurnsListResponseBytes(response, sanitizeForRelay) {
  try {
    const rawResponse = JSON.stringify(response);
    const sanitizedResponse = sanitizeForRelay(rawResponse, "thread/turns/list");
    return Buffer.byteLength(sanitizedResponse, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function threadIdFromRequestParams(params) {
  return normalizeNonEmptyString(params?.threadId)
    || normalizeNonEmptyString(params?.thread_id)
    || normalizeNonEmptyString(params?.id);
}

function turnListTurnIdentifier(turn) {
  return normalizeNonEmptyString(turn?.id)
    || normalizeNonEmptyString(turn?.turnId)
    || normalizeNonEmptyString(turn?.turn_id);
}

module.exports = {
  RELAY_TURNS_LIST_PAGINATION_RESULT_KEYS,
  RELAY_TURNS_LIST_RESULT_KEYS,
  buildAdaptiveTurnsListResult,
  findTurnsListResultKey,
  hasRelayCursor,
  measureSanitizedTurnsListResponseBytes,
  normalizeNonEmptyString,
  readString,
  threadIdFromRequestParams,
  turnListTurnIdentifier,
};
