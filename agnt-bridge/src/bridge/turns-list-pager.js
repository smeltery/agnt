// FILE: turns-list-pager.js
// Purpose: Adaptive pagination + budget enforcement for the
//          `thread/turns/list` relay path. The phone asks for a page of
//          turns; the bridge must answer within ~5.5 s and under a 4 MiB
//          payload cap or the relay/iPhone client falls apart. This module
//          owns the algorithm — page sizing, budget tracking, oversize
//          shrinking, JSONL fallback, and the emergency single-turn path —
//          and exposes the leaf helpers (`unwrapAppServerPayloadResult`,
//          `compactHistoryItemForRelay`, …) the rest of bridge.js still
//          uses for its non-paging trim path.
// Layer: Bridge support
// Exports:
//   constants:
//     - RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES
//     - RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS
//     - RELAY_TURNS_LIST_TARGET_BUDGET_MS
//     - RELAY_TURNS_LIST_BUDGET_RESERVE_MS
//     - RELAY_TURNS_LIST_MAX_INITIAL_LIMIT
//     - RELAY_TURNS_LIST_SAFE_RETRY_LIMIT
//     - RELAY_TURNS_LIST_RESULT_KEYS
//     - RELAY_TURNS_LIST_PAGINATION_RESULT_KEYS
//   utilities:
//     - unwrapAppServerPayloadResult
//     - compactHistoryItemForRelay
//     - firstRelayTextTail
//     - truncateRelayTextTail
//   paging entry points:
//     - parseAdaptiveThreadTurnsListRequest
//     - fetchAdaptiveThreadTurnsListForRelay
//     - createThreadTurnsListFastPageCoordinator
//     - maybeBuildJsonlThreadTurnsListFallback
//     - buildEmptyTurnsListResponse
//     - isEmptyTurnsListResponse
//   internal but re-exported for test pinning:
//     - buildLargestSafeTurnsListResponse
//     - buildEmergencySingleTurnResponse
//     - compactEmergencySingleTurnForRelay
// Depends on: ../desktop/rollout-watch, ../providers/codex/session-jsonl-history

const {
  findRecentRolloutFileForContextRead,
  resolveSessionsRoot,
} = require("../desktop/rollout-watch");
const {
  readThreadTurnsListPageFromSessionJsonl,
} = require("../providers/codex/session-jsonl-history");
const {
  RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS,
  buildEmergencySingleTurnResponse,
  buildLargestSafeTurnsListResponse,
  buildSafeTurnsListResponse,
  compactEmergencySingleTurnForRelay,
  compactHistoryItemForRelay,
  firstRelayTextTail,
  truncateRelayTextTail,
} = require("./turns-list-pager/compaction");
const {
  JSONL_CANONICAL_HANDOFF_CURSOR_PREFIX,
  RELAY_JSONL_FAST_FIRST_PAGE_WAIT_MS,
  canonicalThreadTurnsListRequest,
  createThreadTurnsListFastPageCoordinator,
  isEmptyTurnsListResponse,
  threadTurnsListHandoffDescriptor,
} = require("./turns-list-pager/jsonl-handoff");
const {
  RELAY_TURNS_LIST_PAGINATION_RESULT_KEYS,
  RELAY_TURNS_LIST_RESULT_KEYS,
  buildAdaptiveTurnsListResult,
  findTurnsListResultKey,
  hasRelayCursor,
  measureSanitizedTurnsListResponseBytes,
  normalizeNonEmptyString,
} = require("./turns-list-pager/utils");

const RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES = 4 * 1024 * 1024;
const RELAY_TURNS_LIST_TARGET_BUDGET_MS = 5_500;
const RELAY_TURNS_LIST_BUDGET_RESERVE_MS = 1_000;
// Cap how many turns we even ask the upstream for in one go so a misbehaving
// page (e.g. one with huge tool outputs) cannot single-handedly blow the relay
// payload budget. The safe-retry limit governs the recovery path that fires
// when the normal pager hits the byte-soft-limit anyway.
const RELAY_TURNS_LIST_MAX_INITIAL_LIMIT = 5;
const RELAY_TURNS_LIST_SAFE_RETRY_LIMIT = 5;

function parseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function unwrapAppServerPayloadResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  if (!Object.prototype.hasOwnProperty.call(value, "payload")) {
    return value;
  }

  const payload = value.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return value;
  }

  const directPayloadKeys = [
    "data",
    "items",
    "threads",
    "turns",
    "thread",
  ];
  const hasDirectResultPayload = directPayloadKeys.some((key) => (
    Object.prototype.hasOwnProperty.call(payload, key)
  ));
  if (!hasDirectResultPayload) {
    return value;
  }

  return {
    ...value,
    ...payload,
  };
}

function parseAdaptiveThreadTurnsListRequest(rawMessage) {
  const parsed = parseJSON(rawMessage);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  if (parsed.method !== "thread/turns/list") {
    return null;
  }

  if (parsed.id == null) {
    return null;
  }

  const params = parsed.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }

  if (!Number.isInteger(params.limit) || params.limit <= 0) {
    return null;
  }

  return parsed;
}

async function fetchAdaptiveThreadTurnsListForRelay(request, {
  fetchPage,
  sanitizeForRelay,
  now = Date.now,
  targetBudgetMs = RELAY_TURNS_LIST_TARGET_BUDGET_MS,
  budgetReserveMs = RELAY_TURNS_LIST_BUDGET_RESERVE_MS,
  rawPageSoftLimitBytes = RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES,
  payloadSoftLimitBytes = RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES,
} = {}) {
  if (typeof fetchPage !== "function") {
    throw new Error("fetchPage is required for adaptive turns-list pagination.");
  }
  if (typeof sanitizeForRelay !== "function") {
    throw new Error("sanitizeForRelay is required for adaptive turns-list pagination.");
  }

  const params = request?.params;
  const requestedLimit = Number.isInteger(params?.limit) && params.limit > 0
    ? Math.min(params.limit, RELAY_TURNS_LIST_MAX_INITIAL_LIMIT)
    : 1;
  const startedAt = now();
  let nextCursor = params?.cursor;
  let turnsKey = null;
  let firstResult = null;
  let lastResult = null;
  let combinedTurns = [];
  let response = null;

  while (combinedTurns.length < requestedLimit) {
    const remaining = requestedLimit - combinedTurns.length;
    const pageLimit = selectAdaptiveTurnsListBatchLimit(combinedTurns.length, remaining);
    const pageParams = buildAdaptiveTurnsListPageParams(params, pageLimit, nextCursor);
    let page;

    try {
      page = await fetchMeasuredAdaptiveTurnsListPage(fetchPage, pageParams, now);
    } catch (error) {
      if (response) {
        return response;
      }
      return await fetchSafeThreadTurnsListFallback(request, {
        fetchPage,
        now,
        sanitizeForRelay,
        payloadSoftLimitBytes,
      });
    }

    const pageResult = unwrapAppServerPayloadResult(page.result);
    const pageTurnsKey = findTurnsListResultKey(pageResult);
    if (!pageTurnsKey) {
      if (!response) {
        return await fetchSafeThreadTurnsListFallback(request, {
          fetchPage,
          now,
          sanitizeForRelay,
          payloadSoftLimitBytes,
        });
      }
      return response;
    }

    if (!turnsKey) {
      turnsKey = pageTurnsKey;
    }
    if (!firstResult) {
      firstResult = pageResult;
    }
    lastResult = pageResult;

    const pageTurns = pageResult[pageTurnsKey];
    combinedTurns = combinedTurns.concat(pageTurns);
    response = buildSafeTurnsListResponse(request.id, firstResult, lastResult, turnsKey, combinedTurns);

    if (measureSanitizedTurnsListResponseBytes(response, sanitizeForRelay) >= payloadSoftLimitBytes) {
      response = buildLargestSafeTurnsListResponse({
        requestId: request.id,
        firstResult,
        lastResult,
        turnsKey,
        turns: combinedTurns,
        maxTurns: RELAY_TURNS_LIST_SAFE_RETRY_LIMIT,
        sanitizeForRelay,
        payloadSoftLimitBytes,
      }) ?? buildEmptyTurnsListResponse(request);
      break;
    }

    nextCursor = readTurnsListNextCursor(pageResult);
    if (combinedTurns.length >= requestedLimit || !hasRelayCursor(nextCursor) || pageTurns.length === 0) {
      break;
    }

    const rawPageBytes = jsonByteLength(pageResult);
    const sanitizedResponseBytes = measureSanitizedTurnsListResponseBytes(response, sanitizeForRelay);
    const elapsedMs = Math.max(0, now() - startedAt);
    const remainingBudgetMs = Math.max(0, targetBudgetMs - elapsedMs);
    if (
      rawPageBytes >= rawPageSoftLimitBytes
      || sanitizedResponseBytes >= payloadSoftLimitBytes
      || page.elapsedMs >= Math.max(0, targetBudgetMs - budgetReserveMs)
      || remainingBudgetMs <= budgetReserveMs
    ) {
      break;
    }
  }

  return response ?? buildEmptyTurnsListResponse(request);
}

function buildEmptyTurnsListResponse(request) {
  return {
    id: request.id,
    result: {
      data: [],
      nextCursor: null,
    },
  };
}

// When the live thread/turns/list returns no turns (e.g. transient bridge
// error or stale upstream cache), reconstruct a small page from the local
// Codex rollout file so the iPhone has something to render. Codex-only — the
// other providers' translators already build their own thread/turns/list
// responses from their session files.
//
// Dependencies are injectable so the fallback is testable without touching the
// real ~/.codex/sessions directory.
function maybeBuildJsonlThreadTurnsListFallback(activeProvider, request, response, {
  resolveSessionsRootImpl = resolveSessionsRoot,
  findRecentRolloutFileForContextReadImpl = findRecentRolloutFileForContextRead,
  readThreadTurnsListPageFromSessionJsonlImpl = readThreadTurnsListPageFromSessionJsonl,
  logger = console,
} = {}) {
  if (activeProvider?.id !== "codex") {
    return null;
  }
  if (!isEmptyTurnsListResponse(response)) {
    return null;
  }

  const params = request?.params || {};
  const threadId = normalizeNonEmptyString(params.threadId)
    || normalizeNonEmptyString(params.thread_id);
  const requireCanonical = params.agntRequireCanonical === true;
  if (!threadId || hasRelayCursor(params.cursor) || requireCanonical) {
    return null;
  }

  try {
    const rolloutPath = findRecentRolloutFileForContextReadImpl(resolveSessionsRootImpl(), { threadId });
    if (!rolloutPath) {
      return null;
    }
    const result = readThreadTurnsListPageFromSessionJsonlImpl(rolloutPath, {
      threadId,
      limit: params.limit,
      maxLimit: 1,
      cursor: params.cursor,
    });
    const turnsKey = findTurnsListResultKey(result);
    if (!turnsKey || result[turnsKey].length === 0) {
      return null;
    }

    return {
      id: request.id,
      result,
    };
  } catch (error) {
    logger.warn?.(`[agnt] thread/turns/list jsonl fallback failed: ${error.message}`);
    return null;
  }
}

async function fetchSafeThreadTurnsListFallback(request, {
  fetchPage,
  now,
  sanitizeForRelay,
  payloadSoftLimitBytes,
}) {
  const params = request?.params;
  const requestedLimit = Number.isInteger(params?.limit) && params.limit > 0
    ? params.limit
    : RELAY_TURNS_LIST_SAFE_RETRY_LIMIT;
  const safeLimit = Math.min(requestedLimit, RELAY_TURNS_LIST_SAFE_RETRY_LIMIT);
  const safeParams = buildAdaptiveTurnsListPageParams(params, safeLimit, params?.cursor);

  try {
    const page = await fetchMeasuredAdaptiveTurnsListPage(fetchPage, safeParams, now);
    const pageResult = unwrapAppServerPayloadResult(page.result);
    const turnsKey = findTurnsListResultKey(pageResult);
    if (!turnsKey) {
      return buildEmptyTurnsListResponse(request);
    }

    // If the normal pagination path returns a bad first page, retry once with a small page.
    // The retry response is intentionally minimal so the iOS client does not decode stale
    // server metadata.
    const response = buildLargestSafeTurnsListResponse({
      requestId: request.id,
      firstResult: pageResult,
      lastResult: pageResult,
      turnsKey,
      turns: pageResult[turnsKey],
      maxTurns: safeLimit,
      sanitizeForRelay,
      payloadSoftLimitBytes,
    });
    if (response) {
      return response;
    }
  } catch {
    // Fall through to a valid empty page: the phone can keep the thread open instead of crashing.
  }

  return buildEmptyTurnsListResponse(request);
}

async function fetchMeasuredAdaptiveTurnsListPage(fetchPage, params, now) {
  const startedAt = now();
  const result = await fetchPage(params);
  const elapsedMs = Math.max(0, now() - startedAt);
  return {
    result,
    elapsedMs,
  };
}

function selectAdaptiveTurnsListBatchLimit(fetchedTurnCount, remainingTurnCount) {
  if (fetchedTurnCount <= 0) {
    return Math.min(1, remainingTurnCount);
  }
  if (fetchedTurnCount <= 1) {
    return Math.min(4, remainingTurnCount);
  }
  return remainingTurnCount;
}

function buildAdaptiveTurnsListPageParams(baseParams, limit, cursor) {
  const params = {
    ...baseParams,
    limit,
  };
  if (hasRelayCursor(cursor)) {
    params.cursor = cursor;
  } else {
    delete params.cursor;
  }
  return params;
}

function readTurnsListNextCursor(result) {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  if (hasRelayCursor(result.nextCursor)) {
    return result.nextCursor;
  }
  if (hasRelayCursor(result.next_cursor)) {
    return result.next_cursor;
  }
  return undefined;
}

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

module.exports = {
  RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES,
  RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS,
  RELAY_TURNS_LIST_TARGET_BUDGET_MS,
  RELAY_TURNS_LIST_BUDGET_RESERVE_MS,
  RELAY_JSONL_FAST_FIRST_PAGE_WAIT_MS,
  JSONL_CANONICAL_HANDOFF_CURSOR_PREFIX,
  RELAY_TURNS_LIST_MAX_INITIAL_LIMIT,
  RELAY_TURNS_LIST_SAFE_RETRY_LIMIT,
  RELAY_TURNS_LIST_RESULT_KEYS,
  RELAY_TURNS_LIST_PAGINATION_RESULT_KEYS,
  unwrapAppServerPayloadResult,
  compactHistoryItemForRelay,
  firstRelayTextTail,
  truncateRelayTextTail,
  parseAdaptiveThreadTurnsListRequest,
  fetchAdaptiveThreadTurnsListForRelay,
  createThreadTurnsListFastPageCoordinator,
  canonicalThreadTurnsListRequest,
  threadTurnsListHandoffDescriptor,
  maybeBuildJsonlThreadTurnsListFallback,
  buildEmptyTurnsListResponse,
  isEmptyTurnsListResponse,
  buildLargestSafeTurnsListResponse,
  buildEmergencySingleTurnResponse,
  compactEmergencySingleTurnForRelay,
};
