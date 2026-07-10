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
const { randomBytes } = require("node:crypto");
const {
  readThreadTurnsListPageFromSessionJsonl,
} = require("../providers/codex/session-jsonl-history");

const RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES = 4 * 1024 * 1024;
const RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS = 24_000;
const RELAY_TURNS_LIST_TARGET_BUDGET_MS = 5_500;
const RELAY_TURNS_LIST_BUDGET_RESERVE_MS = 1_000;
const RELAY_JSONL_FAST_FIRST_PAGE_WAIT_MS = 1_500;
const RELAY_JSONL_CANONICAL_HANDOFF_TTL_MS = 60_000;
const RELAY_JSONL_CANONICAL_HANDOFF_MAX_ENTRIES = 32;
const JSONL_CANONICAL_HANDOFF_CURSOR_PREFIX = "agnt-jsonl-handoff-v1:";
// Cap how many turns we even ask the upstream for in one go so a misbehaving
// page (e.g. one with huge tool outputs) cannot single-handedly blow the relay
// payload budget. The safe-retry limit governs the recovery path that fires
// when the normal pager hits the byte-soft-limit anyway.
const RELAY_TURNS_LIST_MAX_INITIAL_LIMIT = 5;
const RELAY_TURNS_LIST_SAFE_RETRY_LIMIT = 5;
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

function parseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeNonEmptyString(value) {
  const str = readString(value).trim();
  return str.length > 0 ? str : "";
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

function createThreadTurnsListFastPageCoordinator({
  waitMs = RELAY_JSONL_FAST_FIRST_PAGE_WAIT_MS,
  handoffTTLms = RELAY_JSONL_CANONICAL_HANDOFF_TTL_MS,
  maxHandoffs = RELAY_JSONL_CANONICAL_HANDOFF_MAX_ENTRIES,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  createToken = () => randomBytes(12).toString("hex"),
} = {}) {
  const handoffsByToken = new Map();
  const latestHandoffTokenByThread = new Map();
  const canonicalFirstPageByKey = new Map();

  function pruneHandoffs() {
    const cutoff = now() - handoffTTLms;
    for (const [token, entry] of handoffsByToken) {
      if (entry.createdAt >= cutoff) {
        continue;
      }
      handoffsByToken.delete(token);
      if (latestHandoffTokenByThread.get(entry.threadId) === token) {
        latestHandoffTokenByThread.delete(entry.threadId);
      }
    }
    for (const [cacheKey, entry] of canonicalFirstPageByKey) {
      if (entry.createdAt < cutoff) {
        canonicalFirstPageByKey.delete(cacheKey);
      }
    }
    while (handoffsByToken.size > maxHandoffs) {
      const oldestToken = handoffsByToken.keys().next().value;
      const oldest = handoffsByToken.get(oldestToken);
      handoffsByToken.delete(oldestToken);
      if (oldest && latestHandoffTokenByThread.get(oldest.threadId) === oldestToken) {
        latestHandoffTokenByThread.delete(oldest.threadId);
      }
    }
  }

  function rememberHandoff(threadId, canonicalOutcomePromise, jsonlFallback) {
    pruneHandoffs();
    const token = createToken();
    const entry = {
      token,
      threadId,
      canonicalOutcomePromise,
      hadNonEmptyJsonl: Boolean(jsonlFallback?.response),
      anchorTurnId: firstTurnsListTurnId(jsonlFallback?.response),
      createdAt: now(),
    };
    handoffsByToken.set(token, entry);
    latestHandoffTokenByThread.set(threadId, token);
    pruneHandoffs();
    return token;
  }

  function consumeHandoff(entry) {
    if (!entry?.token) {
      return;
    }
    handoffsByToken.delete(entry.token);
    if (latestHandoffTokenByThread.get(entry.threadId) === entry.token) {
      latestHandoffTokenByThread.delete(entry.threadId);
    }
  }

  function canonicalFirstPageOutcome(cacheKey, canonicalRequest, fetchCanonical) {
    pruneHandoffs();
    const existing = canonicalFirstPageByKey.get(cacheKey);
    if (existing) {
      return existing.canonicalOutcomePromise;
    }
    const canonicalOutcomePromise = settleThreadTurnsListCanonicalOutcome(
      fetchCanonical(canonicalRequest)
    );
    canonicalFirstPageByKey.set(cacheKey, {
      canonicalOutcomePromise,
      createdAt: now(),
    });
    canonicalOutcomePromise.then(() => {
      const current = canonicalFirstPageByKey.get(cacheKey);
      if (current?.canonicalOutcomePromise === canonicalOutcomePromise) {
        canonicalFirstPageByKey.delete(cacheKey);
      }
    });
    return canonicalOutcomePromise;
  }

  function readHandoffEntry(request) {
    pruneHandoffs();
    const threadId = threadIdFromRequestParams(request?.params);
    const cursor = request?.params?.cursor;
    const token = threadTurnsListHandoffDescriptor(cursor)?.token
      || latestHandoffTokenByThread.get(threadId)
      || "";
    const entry = token ? handoffsByToken.get(token) : null;
    return entry?.threadId === threadId ? entry : null;
  }

  async function awaitCanonicalOutcome(canonicalOutcomePromise) {
    const outcome = await canonicalOutcomePromise;
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.response;
  }

  async function resolveCanonicalRequest(request, fetchCanonical, entry = null, {
    alignToHandoffAnchor = false,
    handoffAnchorTurnId = "",
  } = {}) {
    const canonicalRequest = canonicalThreadTurnsListRequest(request);
    let response = null;
    if (entry) {
      const firstOutcome = await entry.canonicalOutcomePromise;
      if (firstOutcome.ok && !isEmptyTurnsListResponse(firstOutcome.response)) {
        response = firstOutcome.response;
      } else {
        entry.canonicalOutcomePromise = settleThreadTurnsListCanonicalOutcome(fetchCanonical(canonicalRequest));
        entry.createdAt = now();
      }
    }

    response = response || await awaitCanonicalOutcome(
      entry?.canonicalOutcomePromise
        || settleThreadTurnsListCanonicalOutcome(fetchCanonical(canonicalRequest))
    );
    if (entry?.hadNonEmptyJsonl && isEmptyTurnsListResponse(response)) {
      throw new Error("Canonical thread history was empty after a non-empty JSONL first page.");
    }
    const rebound = rebindThreadTurnsListResponseId(response, request.id);
    if (!alignToHandoffAnchor) {
      return rebound;
    }
    const anchorTurnId = entry?.anchorTurnId || handoffAnchorTurnId;
    return alignThreadTurnsListResponseToAnchor(rebound, anchorTurnId) || rebound;
  }

  async function resolve(request, { fetchCanonical, readJsonl }) {
    if (typeof fetchCanonical !== "function") {
      throw new Error("fetchCanonical is required for fast turns-list pagination.");
    }
    if (typeof readJsonl !== "function") {
      throw new Error("readJsonl is required for fast turns-list pagination.");
    }

    const params = request?.params || {};
    const cursor = params.cursor;
    const handoffDescriptor = threadTurnsListHandoffDescriptor(cursor);
    const isHandoffRequest = Boolean(handoffDescriptor);
    const requiresCanonical = params.agntRequireCanonical === true;
    const hasOrdinaryCursor = hasRelayCursor(cursor) && !isHandoffRequest;

    if (hasOrdinaryCursor) {
      return {
        source: "canonical",
        response: await resolveCanonicalRequest(request, fetchCanonical),
        usesJsonl: false,
      };
    }

    if (isHandoffRequest || requiresCanonical) {
      const handoffEntry = readHandoffEntry(request);
      const response = await resolveCanonicalRequest(request, fetchCanonical, handoffEntry, {
        alignToHandoffAnchor: isHandoffRequest,
        handoffAnchorTurnId: handoffDescriptor?.anchorTurnId || "",
      });
      consumeHandoff(handoffEntry);
      return {
        source: "canonical",
        response,
        usesJsonl: false,
      };
    }

    const canonicalRequest = canonicalThreadTurnsListRequest(request);
    const threadId = threadIdFromRequestParams(params);
    const cacheKey = canonicalThreadTurnsListRequestShapeKey(canonicalRequest);
    const canonicalOutcomePromise = canonicalFirstPageOutcome(cacheKey, canonicalRequest, fetchCanonical);
    let jsonlFallback = null;
    try {
      jsonlFallback = await readJsonl(request);
    } catch {
      jsonlFallback = null;
    }
    if (!jsonlFallback?.response) {
      const response = await awaitCanonicalOutcome(canonicalOutcomePromise);
      return {
        source: "canonical",
        response: rebindThreadTurnsListResponseId(response, request.id),
        usesJsonl: false,
      };
    }

    let timeoutId = null;
    const deadline = new Promise((resolveDeadline) => {
      timeoutId = setTimeoutImpl(() => resolveDeadline({ deadline: true }), waitMs);
    });
    const first = await Promise.race([canonicalOutcomePromise, deadline]);
    if (timeoutId != null) {
      clearTimeoutImpl(timeoutId);
    }

    if (first?.ok && !isEmptyTurnsListResponse(first.response)) {
      if (shouldPreferJsonlFirstPage(first.response, jsonlFallback.response)) {
        const token = rememberHandoff(threadId, canonicalOutcomePromise, jsonlFallback);
        return {
          source: "jsonl",
          response: buildJsonlCanonicalHandoffResponse(
            jsonlFallback.response,
            request.id,
            token,
            firstTurnsListTurnId(jsonlFallback.response)
          ),
          usesJsonl: true,
        };
      }
      return {
        source: "canonical",
        response: rebindThreadTurnsListResponseId(first.response, request.id),
        usesJsonl: false,
        jsonlFallback,
      };
    }

    const token = rememberHandoff(threadId, canonicalOutcomePromise, jsonlFallback);
    return {
      source: "jsonl",
      response: buildJsonlCanonicalHandoffResponse(
        jsonlFallback.response,
        request.id,
        token,
        firstTurnsListTurnId(jsonlFallback.response)
      ),
      usesJsonl: true,
    };
  }

  return { resolve };
}

function settleThreadTurnsListCanonicalOutcome(promise) {
  return Promise.resolve(promise).then(
    (response) => ({ ok: true, response }),
    (error) => ({ ok: false, error })
  );
}

function isEmptyTurnsListResponse(response) {
  const turnsKey = findTurnsListResultKey(response?.result);
  return Boolean(turnsKey) && response.result[turnsKey].length === 0;
}

function threadTurnsListHandoffDescriptor(cursor) {
  if (typeof cursor !== "string" || !cursor.startsWith(JSONL_CANONICAL_HANDOFF_CURSOR_PREFIX)) {
    return null;
  }
  const raw = cursor.slice(JSONL_CANONICAL_HANDOFF_CURSOR_PREFIX.length);
  const separatorIndex = raw.lastIndexOf(":");
  if (separatorIndex < 0) {
    return raw ? { anchorTurnId: "", token: raw } : null;
  }
  const token = raw.slice(separatorIndex + 1);
  if (!token) {
    return null;
  }
  try {
    return {
      anchorTurnId: decodeURIComponent(raw.slice(0, separatorIndex)),
      token,
    };
  } catch {
    return null;
  }
}

function canonicalThreadTurnsListRequest(request) {
  const params = { ...(request?.params || {}) };
  delete params.agntRequireCanonical;
  if (threadTurnsListHandoffDescriptor(params.cursor)) {
    delete params.cursor;
  }
  return { ...request, params };
}

function canonicalThreadTurnsListRequestShapeKey(canonicalRequest) {
  const params = canonicalRequest?.params || {};
  return JSON.stringify(sortJsonValueForCacheKey({
    threadId: threadIdFromRequestParams(params),
    params,
  }));
}

function sortJsonValueForCacheKey(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValueForCacheKey);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValueForCacheKey(value[key])])
  );
}

function rebindThreadTurnsListResponseId(response, requestId) {
  return response && typeof response === "object"
    ? { ...response, id: requestId }
    : response;
}

function buildJsonlCanonicalHandoffResponse(response, requestId, token, anchorTurnId = "") {
  const result = response?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return response;
  }
  return {
    ...response,
    id: requestId,
    result: {
      ...result,
      nextCursor: `${JSONL_CANONICAL_HANDOFF_CURSOR_PREFIX}${encodeURIComponent(anchorTurnId)}:${token}`,
      agntJsonlFallback: true,
      agntCanonicalHandoff: true,
    },
  };
}

function shouldPreferJsonlFirstPage(canonicalResponse, jsonlResponse) {
  const canonicalResult = canonicalResponse?.result;
  const jsonlResult = jsonlResponse?.result;
  const canonicalTurnsKey = findTurnsListResultKey(canonicalResult);
  const jsonlTurnsKey = findTurnsListResultKey(jsonlResult);
  if (!canonicalTurnsKey || !jsonlTurnsKey) {
    return false;
  }
  const jsonlTurn = jsonlResult[jsonlTurnsKey]?.[0];
  const jsonlTurnId = turnListTurnIdentifier(jsonlTurn);
  return Boolean(jsonlTurnId)
    && !canonicalResult[canonicalTurnsKey].some((turn) => turnListTurnIdentifier(turn) === jsonlTurnId)
    && shouldPreferLatestJsonlTurn(jsonlTurn);
}

function shouldPreferLatestJsonlTurn(turn) {
  const status = normalizeNonEmptyString(turn?.status).toLowerCase();
  return status === "running"
    || status === "inprogress"
    || status === "in_progress"
    || status === "active"
    || status === "processing";
}

function firstTurnsListTurnId(response) {
  const result = response?.result;
  const turnsKey = findTurnsListResultKey(result);
  return turnsKey ? turnListTurnIdentifier(result[turnsKey]?.[0]) : "";
}

function alignThreadTurnsListResponseToAnchor(response, anchorTurnId) {
  if (!anchorTurnId) {
    return response;
  }
  const result = response?.result;
  const turnsKey = findTurnsListResultKey(result);
  if (!turnsKey) {
    return null;
  }
  const turns = result[turnsKey];
  const anchorIndex = turns.findIndex((turn) => turnListTurnIdentifier(turn) === anchorTurnId);
  if (anchorIndex < 0) {
    return null;
  }
  return {
    ...response,
    result: {
      ...result,
      [turnsKey]: turns.slice(anchorIndex),
    },
  };
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

function buildSafeTurnsListResponse(requestId, firstResult, lastResult, turnsKey, turns) {
  return {
    id: requestId,
    result: buildAdaptiveTurnsListResult(firstResult, lastResult, turnsKey, turns),
  };
}

// Trims oversized history pages progressively: normal page -> 5 turns -> ... -> 1 turn.
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

function hasRelayCursor(cursor) {
  return cursor !== undefined && cursor !== null && cursor !== "";
}

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
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
