const { randomBytes } = require("node:crypto");
const {
  findTurnsListResultKey,
  hasRelayCursor,
  threadIdFromRequestParams,
  turnListTurnIdentifier,
} = require("./utils");

const RELAY_JSONL_FAST_FIRST_PAGE_WAIT_MS = 1_500;
const RELAY_JSONL_CANONICAL_HANDOFF_TTL_MS = 60_000;
const RELAY_JSONL_CANONICAL_HANDOFF_MAX_ENTRIES = 32;
const JSONL_CANONICAL_HANDOFF_CURSOR_PREFIX = "agnt-jsonl-handoff-v1:";

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

    let timeoutId = null;
    const deadline = new Promise((resolveDeadline) => {
      timeoutId = setTimeoutImpl(() => resolveDeadline({ deadline: true }), waitMs);
    });
    const first = await Promise.race([canonicalOutcomePromise, deadline]);
    if (timeoutId != null) {
      clearTimeoutImpl(timeoutId);
    }

    if (first?.ok && !isEmptyTurnsListResponse(first.response)) {
      return {
        source: "canonical",
        response: rebindThreadTurnsListResponseId(first.response, request.id),
        usesJsonl: false,
      };
    }

    // Deadline hit, canonical error, or an empty canonical page: only now pay
    // for the synchronous rollout read, so a fast canonical response never
    // blocks behind it and never delays itself.
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

module.exports = {
  JSONL_CANONICAL_HANDOFF_CURSOR_PREFIX,
  RELAY_JSONL_FAST_FIRST_PAGE_WAIT_MS,
  canonicalThreadTurnsListRequest,
  createThreadTurnsListFastPageCoordinator,
  isEmptyTurnsListResponse,
  threadTurnsListHandoffDescriptor,
};
