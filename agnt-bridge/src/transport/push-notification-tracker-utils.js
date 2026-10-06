// Shared completion-envelope parsing and local goal-state persistence.
const fs = require("fs");
const path = require("path");
const MAX_GOAL_STATUS_ENTRIES = 500;

// Best-effort disk persistence for goal statuses; failures must never break the bridge.
function loadGoalPushState(filePath, logPrefix) {
  if (!filePath) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map();
    }
    const entries = Object.entries(parsed)
      .map(([threadId, snapshot]) => [threadId, normalizeGoalPushSnapshot(snapshot)])
      .filter(([threadId, snapshot]) => typeof threadId === "string" && snapshot != null)
      .slice(-MAX_GOAL_STATUS_ENTRIES);
    return new Map(entries);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`${logPrefix} failed to load goal push state: ${error.message}`);
    }
    return new Map();
  }
}

function normalizeGoalPushSnapshot(value) {
  if (typeof value === "string") {
    return { status: value, updatedAt: null };
  }
  if (!value || typeof value !== "object" || typeof value.status !== "string") {
    return null;
  }
  return {
    status: value.status,
    updatedAt: value.updatedAt ?? null,
  };
}

function saveGoalPushState(filePath, goalStatusByThreadId, logPrefix) {
  if (!filePath) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(goalStatusByThreadId)));
  } catch (error) {
    console.error(`${logPrefix} failed to save goal push state: ${error.message}`);
  }
}

// Normalizes the message envelope once so downstream helpers can share the same parsed view.
function parseOutboundMessage(rawMessage, parsedMessage = null) {
  const parsed = parsedMessage ?? safeParseJSON(rawMessage);
  if (!parsed || typeof parsed.method !== "string") {
    return null;
  }

  const method = parsed.method.trim();
  const params = objectValue(parsed.params) || {};
  const eventObject = envelopeEventObject(params);

  return {
    method,
    params,
    eventObject,
    threadId: resolveThreadId(method, params, eventObject),
    turnId: resolveTurnId(method, params, eventObject),
  };
}

function shouldIgnoreHistoricalMessage({ method, params, eventObject }) {
  if (hasTrueFlag(params, eventObject, "agntReplayedEvent")) {
    return true;
  }
  if (hasTrueFlag(params, eventObject, "agntRolloutTerminalCatchUp")) {
    return true;
  }
  return hasTrueFlag(params, eventObject, "agntRolloutBootstrapReplay")
    && method !== "turn/started";
}

function hasTrueFlag(params, eventObject, key) {
  return parseBooleanFlag(params?.[key]) === true
    || parseBooleanFlag(eventObject?.[key]) === true
    || parseBooleanFlag(params?.event?.[key]) === true;
}

function envelopeEventObject(params) {
  if (params?.event && typeof params.event === "object") {
    return params.event;
  }
  if (params?.msg && typeof params.msg === "object") {
    return params.msg;
  }
  return null;
}

function resolveThreadId(method, params, eventObject) {
  const candidates = [
    params?.threadId,
    params?.thread_id,
    params?.conversationId,
    params?.conversation_id,
    params?.thread?.id,
    params?.thread?.threadId,
    params?.thread?.thread_id,
    params?.turn?.threadId,
    params?.turn?.thread_id,
    eventObject?.threadId,
    eventObject?.thread_id,
    eventObject?.conversationId,
    eventObject?.conversation_id,
  ];

  for (const candidate of candidates) {
    const value = readString(candidate);
    if (value) {
      return value;
    }
  }

  const turnId = resolveTurnId(method, params, eventObject);
  if (turnId) {
    return null;
  }

  return null;
}

function resolveTurnId(_method, params, eventObject) {
  const itemObject = incomingItemObject(params, eventObject);
  const candidates = [
    params?.turnId,
    params?.turn_id,
    params?.id,
    params?.turn?.id,
    params?.turn?.turnId,
    params?.turn?.turn_id,
    eventObject?.id,
    eventObject?.turnId,
    eventObject?.turn_id,
    itemObject?.turnId,
    itemObject?.turn_id,
  ];

  for (const candidate of candidates) {
    const value = readString(candidate);
    if (value) {
      return value;
    }
  }

  return null;
}

function incomingItemObject(params, eventObject) {
  if (params?.item && typeof params.item === "object") {
    return params.item;
  }
  if (eventObject?.item && typeof eventObject.item === "object") {
    return eventObject.item;
  }
  if (eventObject && typeof eventObject === "object" && typeof eventObject.type === "string") {
    return eventObject;
  }
  return null;
}

function extractThreadTitle(params, eventObject) {
  const threadObject = (params?.thread && typeof params.thread === "object") ? params.thread : null;
  const candidates = [
    params?.threadName,
    params?.thread_name,
    params?.name,
    params?.title,
    threadObject?.name,
    threadObject?.title,
    eventObject?.threadName,
    eventObject?.thread_name,
    eventObject?.name,
    eventObject?.title,
  ];

  for (const candidate of candidates) {
    const value = normalizePreviewText(candidate);
    if (value) {
      return value;
    }
  }

  return null;
}

function isAssistantDeltaMethod(method) {
  return method === "item/agentMessage/delta"
    || method === "codex/event/agent_message_content_delta"
    || method === "codex/event/agent_message_delta";
}

function isAssistantCompletedMethod(method, params, eventObject) {
  if (method === "codex/event/agent_message") {
    return true;
  }

  if (method !== "item/completed" && method !== "codex/event/item_completed") {
    return false;
  }

  return isAssistantMessageItem(incomingItemObject(params, eventObject));
}

function isFailureEnvelope(method, eventObject) {
  if (method === "error" || method === "codex/event/error") {
    return true;
  }

  return readString(eventObject?.type) === "error";
}

function extractAssistantDeltaText(params, eventObject) {
  const candidates = [
    params?.delta,
    params?.textDelta,
    params?.text_delta,
    eventObject?.delta,
    eventObject?.text,
    params?.event?.delta,
    params?.event?.text,
  ];

  for (const candidate of candidates) {
    const value = readString(candidate);
    if (value) {
      return value;
    }
  }

  return "";
}

function extractAssistantCompletedText(params, eventObject) {
  const itemObject = incomingItemObject(params, eventObject);
  const candidates = [
    itemObject?.message,
    itemObject?.text,
    itemObject?.summary,
    params?.message,
    eventObject?.message,
    eventObject?.text,
  ];

  for (const candidate of candidates) {
    const value = normalizePreviewText(candidate);
    if (value) {
      return value;
    }
  }

  return "";
}

function extractFailureMessage(params, eventObject) {
  const candidates = [
    params?.message,
    params?.error?.message,
    params?.turn?.error?.message,
    eventObject?.message,
    eventObject?.error?.message,
    eventObject?.turn?.error?.message,
  ];

  for (const candidate of candidates) {
    const value = normalizePreviewText(candidate);
    if (value) {
      return value;
    }
  }

  return "";
}

function resolveCompletionResult(params, eventObject) {
  const rawStatus = readTurnStatus(params, eventObject);
  if (!rawStatus) {
    return extractFailureMessage(params, eventObject) ? "failed" : "completed";
  }

  const normalizedStatus = normalizeToken(rawStatus);
  if (normalizedStatus.includes("fail") || normalizedStatus.includes("error")) {
    return "failed";
  }
  if (["completed", "complete", "done", "finished", "succeeded", "success"].includes(
    normalizedStatus
  )) {
    return "completed";
  }
  return null;
}

function canStartLiveRun(params, eventObject) {
  const status = normalizeToken(readTurnStatus(params, eventObject));
  return !status || ![
    "completed",
    "complete",
    "done",
    "finished",
    "succeeded",
    "success",
    "failed",
    "failure",
    "error",
    "stopped",
    "interrupted",
    "cancelled",
    "canceled",
    "aborted",
  ].includes(status);
}

function readTurnStatus(params, eventObject) {
  const statusObject = objectValue(params?.status)
    || objectValue(eventObject?.status)
    || objectValue(params?.event?.status);
  return readString(
    params?.turn?.status
      || eventObject?.turn?.status
      || statusObject?.type
      || statusObject?.statusType
      || statusObject?.status_type
      || params?.status
      || eventObject?.status
      || params?.event?.status
  );
}

function completionReceiptKey(run) {
  const stableTurnIdentity = run.turnId
    ? `turn:${run.turnId}`
    : `generated:${run.identity}`;
  return JSON.stringify([run.threadId, stableTurnIdentity]);
}

function readCompletionTimestamp(params, eventObject) {
  const sources = [params?.turn, params, eventObject?.turn, eventObject];
  for (const source of sources) {
    for (const key of ["completedAt", "completed_at", "completedAtMs", "completed_at_ms"]) {
      const value = source?.[key];
      if (value == null || value === "") continue;
      if (typeof value !== "number" && typeof value !== "string") continue;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric > 10_000_000_000 ? numeric : numeric * 1000;
      }
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function shouldIgnoreRetriableFailure(params, eventObject) {
  const retryCandidates = [
    params?.willRetry,
    params?.will_retry,
    eventObject?.willRetry,
    eventObject?.will_retry,
    params?.event?.willRetry,
    params?.event?.will_retry,
  ];

  return retryCandidates.some((candidate) => parseBooleanFlag(candidate) === true);
}

function buildNotificationBody({ result, state, params, eventObject, previewMaxChars }) {
  if (result === "failed") {
    return truncatePreview(
      state?.latestFailurePreview
        || extractFailureMessage(params, eventObject)
        || "Run failed",
      previewMaxChars
    ) || "Run failed";
  }

  return "Response ready";
}

function truncatePreview(value, limit) {
  const normalized = normalizePreviewText(value);
  if (!normalized) {
    return "";
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizePreviewText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseBooleanFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue === "true" || normalizedValue === "1") {
      return true;
    }
    if (normalizedValue === "false" || normalizedValue === "0") {
      return false;
    }
  }
  return null;
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isAssistantMessageItem(itemObject) {
  if (!itemObject || typeof itemObject !== "object") {
    return false;
  }

  const normalizedType = normalizeToken(itemObject.type);
  const normalizedRole = normalizeToken(itemObject.role);
  return normalizedType === "agentmessage"
    || normalizedType === "assistantmessage"
    || normalizedRole === "assistant";
}

function normalizeToken(value) {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[_-\s]+/g, "")
    : "";
}

function safeParseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = {
  loadGoalPushState,
  normalizeGoalPushSnapshot,
  saveGoalPushState,
  parseOutboundMessage,
  shouldIgnoreHistoricalMessage,
  extractThreadTitle,
  isAssistantDeltaMethod,
  isAssistantCompletedMethod,
  isFailureEnvelope,
  extractAssistantDeltaText,
  extractAssistantCompletedText,
  extractFailureMessage,
  resolveCompletionResult,
  canStartLiveRun,
  completionReceiptKey,
  readCompletionTimestamp,
  shouldIgnoreRetriableFailure,
  buildNotificationBody,
  truncatePreview,
  normalizePreviewText,
  objectValue,
  readString
};
