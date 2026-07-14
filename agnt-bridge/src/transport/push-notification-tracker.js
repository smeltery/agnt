// FILE: push-notification-tracker.js
// Purpose: Tracks per-turn titles and failure context so the bridge can emit completion pushes even after the iPhone disconnects.
// Layer: Bridge helper
// Exports: createPushNotificationTracker
// Depends on: ./push-notification-completion-dedupe

const {
  createPushNotificationCompletionDedupe,
} = require("./push-notification-completion-dedupe");
const {
  buildNotificationBody,
  completionDedupeKey,
  extractAssistantCompletedText,
  extractAssistantDeltaText,
  extractFailureMessage,
  extractThreadTitle,
  isActiveThreadStatus,
  isAssistantCompletedMethod,
  isAssistantDeltaMethod,
  isFailureEnvelope,
  isTerminalThreadStatusMethod,
  loadGoalPushState,
  normalizeGoalPushSnapshot,
  normalizePreviewText,
  objectValue,
  parseOutboundMessage,
  readString,
  resolveCompletionResult,
  resolveThreadStatusResult,
  resolveTurnId,
  saveGoalPushState,
  shouldIgnoreRetriableFailure,
  truncatePreview,
  turnStateKey,
} = require("./push-notification-tracker-utils");

const os = require("os");
const path = require("path");

const DEFAULT_GOAL_PUSH_STATE_PATH = path.join(os.homedir(), ".agnt", "goal-push-state.json");
const DEFAULT_PREVIEW_MAX_CHARS = 160;
const MAX_GOAL_STATUS_ENTRIES = 500;

const GOAL_PUSH_BODIES = new Map([
  ["complete", "Goal complete"],
  ["blocked", "Goal blocked - agnt needs your input"],
  ["usageLimited", "Goal stopped - usage limit reached"],
  ["budgetLimited", "Goal stopped - token budget reached"],
]);

function createPushNotificationTracker({
  sessionId,
  pushServiceClient,
  previewMaxChars = DEFAULT_PREVIEW_MAX_CHARS,
  logPrefix = "[agnt]",
  now = () => Date.now(),
  goalPushStatePath = DEFAULT_GOAL_PUSH_STATE_PATH,
} = {}) {
  const threadTitleById = new Map();
  const threadIdByTurnId = new Map();
  const turnStateByKey = new Map();
  const goalStatusByThreadId = loadGoalPushState(goalPushStatePath, logPrefix);
  const completionDedupe = createPushNotificationCompletionDedupe({ now });

  // ─── ENTRY POINT ─────────────────────────────────────────────

  function handleOutbound(rawMessage) {
    const message = parseOutboundMessage(rawMessage);
    if (!message) {
      return;
    }

    if (message.method === "thread/goal/updated") {
      void handleGoalUpdated(message);
      return;
    }

    if (message.method === "thread/goal/cleared") {
      if (message.threadId && goalStatusByThreadId.delete(message.threadId)) {
        saveGoalPushState(goalPushStatePath, goalStatusByThreadId, logPrefix);
      }
      return;
    }

    rememberMessageContext(message);
    clearFallbackSuppressionForNewRun(message);

    if (isAssistantDeltaMethod(message.method)) {
      recordAssistantDelta(message.threadId, message.turnId, message.params, message.eventObject);
      return;
    }

    if (isAssistantCompletedMethod(message.method, message.params, message.eventObject)) {
      recordAssistantCompletion(message.threadId, message.turnId, message.params, message.eventObject);
      return;
    }

    routeTerminalMessage(message);
  }

  // Keeps the top-level handler focused on orchestration while helpers own terminal edge cases.
  function routeTerminalMessage({ method, params, eventObject, threadId, turnId }) {
    if (method === "turn/failed" || isFailureEnvelope(method, eventObject)) {
      if (shouldIgnoreRetriableFailure(params, eventObject)) {
        return;
      }

      recordFailure(threadId, turnId, params, eventObject);
      void notifyCompletion(threadId, turnId, params, eventObject, { forcedResult: "failed" });
      return;
    }

    if (isTerminalThreadStatusMethod(method)) {
      void notifyCompletion(threadId, turnId, params, eventObject, {
        forcedResult: resolveThreadStatusResult(params, eventObject),
      });
      return;
    }

    if (method === "turn/completed") {
      void notifyCompletion(threadId, turnId, params, eventObject);
    }
  }

  async function handleGoalUpdated({ threadId, params }) {
    const goal = objectValue(params?.goal);
    const status = readString(goal?.status);
    const resolvedThreadId = threadId || readString(goal?.threadId);
    if (!resolvedThreadId || !status) {
      return;
    }

    const previousSnapshot = normalizeGoalPushSnapshot(goalStatusByThreadId.get(resolvedThreadId));
    const nextSnapshot = {
      status,
      updatedAt: goal?.updatedAt ?? goal?.updated_at ?? null,
    };
    const isFirstObservation = previousSnapshot == null;
    const isDuplicate = previousSnapshot?.status === nextSnapshot.status
      && previousSnapshot?.updatedAt === nextSnapshot.updatedAt;
    const body = GOAL_PUSH_BODIES.get(status);
    if (isFirstObservation || isDuplicate || !body || !pushServiceClient?.hasConfiguredBaseUrl) {
      if (!isDuplicate) {
        rememberGoalSnapshot(resolvedThreadId, nextSnapshot);
      }
      return;
    }

    const title = normalizePreviewText(threadTitleById.get(resolvedThreadId)) || "New Thread";
    try {
      await pushServiceClient.notifyCompletion({
        threadId: resolvedThreadId,
        turnId: null,
        result: status === "complete" ? "completed" : "failed",
        title,
        body,
        dedupeKey: [sessionId || "", resolvedThreadId, "goal", status, nextSnapshot.updatedAt ?? ""].join("|"),
      });
      rememberGoalSnapshot(resolvedThreadId, nextSnapshot);
    } catch (error) {
      console.error(`${logPrefix} goal push notify failed: ${error.message}`);
    }
  }

  function rememberGoalSnapshot(threadId, snapshot) {
    if (!goalStatusByThreadId.has(threadId) && goalStatusByThreadId.size >= MAX_GOAL_STATUS_ENTRIES) {
      const oldest = goalStatusByThreadId.keys().next().value;
      goalStatusByThreadId.delete(oldest);
    }
    goalStatusByThreadId.set(threadId, snapshot);
    saveGoalPushState(goalPushStatePath, goalStatusByThreadId, logPrefix);
  }

  // Remembers thread/turn linkage before the terminal event arrives on a different payload shape.
  function rememberMessageContext({ threadId, turnId, params, eventObject }) {
    if (threadId && turnId) {
      threadIdByTurnId.set(turnId, threadId);
      ensureTurnState(threadId, turnId);
    }

    if (!threadId) {
      return;
    }

    const nextTitle = extractThreadTitle(params, eventObject);
    if (nextTitle) {
      threadTitleById.set(threadId, nextTitle);
    }
  }

  // A new run on the same thread must not inherit duplicate-suppression from the previous run.
  function clearFallbackSuppressionForNewRun({ method, threadId, params, eventObject }) {
    if (!threadId) {
      return;
    }

    if (method === "turn/started" || isActiveThreadStatus(method, params, eventObject)) {
      completionDedupe.clearForNewRun(threadId);
    }
  }

  // Buckets turnless completions so repeated terminal events dedupe briefly instead of forever.
  async function notifyCompletion(threadId, turnId, params, eventObject, { forcedResult = null } = {}) {
    const resolvedThreadId = threadId || (turnId ? threadIdByTurnId.get(turnId) : null);
    if (!pushServiceClient?.hasConfiguredBaseUrl || !resolvedThreadId) {
      return;
    }

    const result = forcedResult || resolveCompletionResult(params, eventObject);
    if (!result) {
      cleanupTurnState(resolvedThreadId, turnId);
      return;
    }

    if (completionDedupe.shouldSuppressThreadStatusFallback({
      threadId: resolvedThreadId,
      turnId,
      result,
    })) {
      cleanupTurnState(resolvedThreadId, turnId);
      return;
    }

    const dedupeKey = completionDedupeKey({
      sessionId,
      threadId: resolvedThreadId,
      turnId,
      result,
      now,
    });
    if (completionDedupe.hasActiveDedupeKey(dedupeKey)) {
      cleanupTurnState(resolvedThreadId, turnId);
      return;
    }

    const state = getTurnState(resolvedThreadId, turnId);
    const title = normalizePreviewText(threadTitleById.get(resolvedThreadId)) || "New Thread";
    const body = buildNotificationBody({
      result,
      state,
      params,
      eventObject,
      previewMaxChars,
    });

    try {
      completionDedupe.beginNotification({
        dedupeKey,
        threadId: resolvedThreadId,
        turnId,
        result,
      });
      await pushServiceClient.notifyCompletion({
        threadId: resolvedThreadId,
        turnId,
        result,
        title,
        body,
        dedupeKey,
      });
      completionDedupe.commitNotification({
        dedupeKey,
        threadId: resolvedThreadId,
        turnId,
        result,
      });
    } catch (error) {
      completionDedupe.abortNotification({
        dedupeKey,
        threadId: resolvedThreadId,
        turnId,
        result,
      });
      console.error(`${logPrefix} push notify failed: ${error.message}`);
    } finally {
      cleanupTurnState(resolvedThreadId, turnId);
    }
  }

  function recordAssistantDelta(threadId, turnId, params, eventObject) {
    const resolvedTurnId = turnId || resolveTurnId("assistant", params, eventObject);
    const resolvedThreadId = threadId || (resolvedTurnId ? threadIdByTurnId.get(resolvedTurnId) : null);
    if (!resolvedThreadId || !resolvedTurnId) {
      return;
    }

    const delta = extractAssistantDeltaText(params, eventObject);
    if (!delta) {
      return;
    }

    const state = ensureTurnState(resolvedThreadId, resolvedTurnId);
    state.latestAssistantPreview = truncatePreview(`${state.latestAssistantPreview || ""}${delta}`, previewMaxChars);
  }

  function recordAssistantCompletion(threadId, turnId, params, eventObject) {
    const resolvedTurnId = turnId || resolveTurnId("assistant", params, eventObject);
    const resolvedThreadId = threadId || (resolvedTurnId ? threadIdByTurnId.get(resolvedTurnId) : null);
    if (!resolvedThreadId || !resolvedTurnId) {
      return;
    }

    const completedText = extractAssistantCompletedText(params, eventObject);
    if (!completedText) {
      return;
    }

    const state = ensureTurnState(resolvedThreadId, resolvedTurnId);
    state.latestAssistantPreview = truncatePreview(completedText, previewMaxChars);
  }

  function recordFailure(threadId, turnId, params, eventObject) {
    const resolvedTurnId = turnId || resolveTurnId("failure", params, eventObject);
    const resolvedThreadId = threadId || (resolvedTurnId ? threadIdByTurnId.get(resolvedTurnId) : null);
    if (!resolvedThreadId || !resolvedTurnId) {
      return;
    }

    const failureMessage = extractFailureMessage(params, eventObject);
    const state = ensureTurnState(resolvedThreadId, resolvedTurnId);
    if (failureMessage) {
      state.latestFailurePreview = truncatePreview(failureMessage, previewMaxChars);
    }
  }

  function ensureTurnState(threadId, turnId) {
    const key = turnStateKey(threadId, turnId);
    if (!turnStateByKey.has(key)) {
      turnStateByKey.set(key, {
        latestAssistantPreview: "",
        latestFailurePreview: "",
      });
    }

    return turnStateByKey.get(key);
  }

  function getTurnState(threadId, turnId) {
    if (!threadId) {
      return null;
    }
    return turnStateByKey.get(turnStateKey(threadId, turnId)) || null;
  }

  function cleanupTurnState(threadId, turnId) {
    if (!threadId) {
      return;
    }

    const resolvedTurnId = turnId || null;
    if (resolvedTurnId) {
      threadIdByTurnId.delete(resolvedTurnId);
    }
    turnStateByKey.delete(turnStateKey(threadId, resolvedTurnId));
  }

  return {
    handleOutbound,
  };
}

module.exports = {
  createPushNotificationTracker,
};
