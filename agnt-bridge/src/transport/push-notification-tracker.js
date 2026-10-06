// FILE: push-notification-tracker.js
// Purpose: Tracks per-turn titles and failure context so the bridge can emit completion pushes even after the iPhone disconnects.
// Layer: Bridge helper
// Exports: createPushNotificationTracker
// Depends on: ./push-notification-completion-dedupe

const {
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
} = require("./push-notification-tracker-utils");

const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

const {
  createPushNotificationCompletionDedupe,
} = require("./push-notification-completion-dedupe");

const DEFAULT_GOAL_PUSH_STATE_PATH = path.join(os.homedir(), ".agnt", "goal-push-state.json");

const DEFAULT_PREVIEW_MAX_CHARS = 160;
const MAX_THREAD_TITLE_ENTRIES = 200;
const MAX_LIVE_RUN_ENTRIES = 500;
const MAX_GOAL_STATUS_ENTRIES = 500;
const MAX_COMPLETION_AGE_MS = 5 * 60 * 1000;

// Goal states worth waking the phone for: terminal or needs-user-attention.
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
  completionStatePath,
  goalPushStatePath = DEFAULT_GOAL_PUSH_STATE_PATH,
  readThread,
} = {}) {
  const threadTitleById = new Map();
  const liveRunsByIdentity = new Map();
  const runIdentitiesByThreadId = new Map();
  const runIdentitiesByTurnId = new Map();
  const threadsWithAnonymousCompletions = new Set();
  const historicalTurnKeys = new Set();
  const observedGoalThreadIds = new Set();
  const goalPushInFlightByThreadId = new Map();
  // Persisted status is a baseline, never a reason to wake the phone on restart.
  const goalStatusByThreadId = loadGoalPushState(goalPushStatePath, logPrefix);
  const completionDedupe = createPushNotificationCompletionDedupe({
    statePath: completionStatePath,
    logPrefix,
  });

  // ─── ENTRY POINT ─────────────────────────────────────────────

  function handleOutbound(rawMessage, parsedMessage = null) {
    const message = parseOutboundMessage(rawMessage, parsedMessage);
    if (!message || shouldIgnoreHistoricalMessage(message)) {
      return;
    }
    rememberThreadTitle(message);
    if (message.method === "thread/goal/updated") {
      void handleGoalUpdated(message);
      return;
    }

    if (message.method === "thread/goal/cleared") {
      observedGoalThreadIds.delete(message.threadId);
      if (message.threadId && goalStatusByThreadId.delete(message.threadId)) {
        saveGoalPushState(goalPushStatePath, goalStatusByThreadId, logPrefix);
      }
      return;
    }

    if (message.turnId && historicalTurnKeys.has(completionReceiptKey(message))) return;
    // Delivery can finish before a delayed canonical ID arrives. Never use HTTP
    // timing to decide which of two observed anonymous runs owns that ID.
    const anonymousRun = message.turnId && !findExactLiveRun(message)
      ? uniqueAnonymousRun(message.threadId)
      : null;
    if (anonymousRun?.requiresIdentityConfirmation) {
      const isFailure = message.method === "turn/failed" || isFailureEnvelope(message.method, message.eventObject);
      if (message.method !== "turn/started" && message.method !== "turn/completed" && !isFailure) return;
      if (isFailure && shouldIgnoreRetriableFailure(message.params, message.eventObject)) return;
      if (!anonymousRun.superseded || message.method === "turn/started"
        || anonymousRun.identityConfirmation) {
        void readLatestTurnId(anonymousRun).then((turnId) => {
          if (turnId !== message.turnId
            || liveRunsByIdentity.get(anonymousRun.identity) !== anonymousRun
            || (anonymousRun.turnId && anonymousRun.turnId !== turnId)) return;
          if (findExactLiveRun(message)) {
            handleRunMessage(message);
            return;
          }
          if (anonymousRun.superseded) {
            // A subsequent identified start is independent of the old receipt.
            if (message.method !== "turn/started"
              || uniqueLiveRun(message.threadId) !== anonymousRun) return;
            addLiveRun(createLiveRun(message.threadId, turnId));
          } else {
            promoteRun(anonymousRun, turnId);
          }
          handleRunMessage(message);
        });
      }
      return;
    }
    handleRunMessage(message);
  }

  function handleRunMessage(message) {
    if (message.method === "turn/started") {
      observeRunStart(message);
      return;
    }

    if (isAssistantDeltaMethod(message.method)) {
      recordAssistantDelta(message);
      return;
    }

    if (isAssistantCompletedMethod(message.method, message.params, message.eventObject)) {
      recordAssistantCompletion(message);
      return;
    }

    routeTerminalMessage(message);
  }

  function routeTerminalMessage(message) {
    const { method, params, eventObject } = message;
    if (method === "turn/failed" || isFailureEnvelope(method, eventObject)) {
      if (shouldIgnoreRetriableFailure(params, eventObject)) {
        return;
      }
      const run = findLiveRun(message);
      if (!run) {
        return;
      }
      recordFailure(run, params, eventObject);
      void notifyCompletion(run, "failed", params, eventObject);
      return;
    }

    if (method !== "turn/completed") {
      return;
    }

    const run = findLiveRun(message);
    if (!run) {
      return;
    }
    const result = resolveCompletionResult(params, eventObject);
    if (!result) {
      retireRun(run);
      return;
    }
    if (result === "failed") {
      recordFailure(run, params, eventObject);
    }
    void notifyCompletion(run, result, params, eventObject);
  }

  // Pushes goal lifecycle transitions into terminal/attention states so hours-long
  // background goals still reach the user. Resume snapshots (first observation of a
  // status) never notify; only live status changes do.
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
    if (!goalStatusByThreadId.has(resolvedThreadId) && goalStatusByThreadId.size >= MAX_GOAL_STATUS_ENTRIES) {
      const oldest = goalStatusByThreadId.keys().next().value;
      goalStatusByThreadId.delete(oldest);
      observedGoalThreadIds.delete(oldest);
    }
    const isFirstObservation = !observedGoalThreadIds.has(resolvedThreadId);
    observedGoalThreadIds.add(resolvedThreadId);
    const isDuplicate = previousSnapshot?.status === nextSnapshot.status
      && previousSnapshot?.updatedAt === nextSnapshot.updatedAt;
    const body = GOAL_PUSH_BODIES.get(status);
    if (isFirstObservation || previousSnapshot?.status === status || !body || !pushServiceClient?.hasConfiguredBaseUrl) {
      if (previousSnapshot?.status === status
        && goalPushInFlightByThreadId.get(resolvedThreadId) === goalStatusByThreadId.get(resolvedThreadId)
        && goalPushInFlightByThreadId.has(resolvedThreadId)) {
        return;
      }
      if (!isDuplicate) {
        goalStatusByThreadId.set(resolvedThreadId, nextSnapshot);
        saveGoalPushState(goalPushStatePath, goalStatusByThreadId, logPrefix);
      }
      return;
    }

    const title = normalizePreviewText(threadTitleById.get(resolvedThreadId)) || "New Thread";
    // Reserve the transition while HTTP is pending; timestamp-only updates must
    // not enqueue another notification for the same goal state.
    goalStatusByThreadId.set(resolvedThreadId, nextSnapshot);
    goalPushInFlightByThreadId.set(resolvedThreadId, nextSnapshot);
    // The goal objective intentionally stays out of push payloads and logs.
    try {
      await pushServiceClient.notifyCompletion({
        threadId: resolvedThreadId,
        turnId: null,
        result: status === "complete" ? "completed" : "failed",
        title,
        body,
        // updatedAt keeps repeated legitimate transitions (blocked -> active -> blocked) notifiable.
        dedupeKey: [sessionId || "", resolvedThreadId, "goal", status, goal?.updatedAt ?? ""].join("|"),
      });
      saveGoalPushState(goalPushStatePath, goalStatusByThreadId, logPrefix);
    } catch (error) {
      // Restore eligibility on failure, without overwriting a newer transition.
      if (goalStatusByThreadId.get(resolvedThreadId) === nextSnapshot) {
        goalStatusByThreadId.set(resolvedThreadId, previousSnapshot);
        saveGoalPushState(goalPushStatePath, goalStatusByThreadId, logPrefix);
      }
      console.error(`${logPrefix} goal push notify failed: ${error.message}`);
    } finally {
      if (goalPushInFlightByThreadId.get(resolvedThreadId) === nextSnapshot) {
        goalPushInFlightByThreadId.delete(resolvedThreadId);
      }
    }
  }

  function rememberThreadTitle({ threadId, params, eventObject }) {
    if (!threadId) {
      return;
    }

    const nextTitle = extractThreadTitle(params, eventObject);
    if (nextTitle) {
      if (!threadTitleById.has(threadId) && threadTitleById.size >= MAX_THREAD_TITLE_ENTRIES) {
        const oldest = threadTitleById.keys().next().value;
        threadTitleById.delete(oldest);
      }
      threadTitleById.set(threadId, nextTitle);
    }
  }

  function observeRunStart(message) {
    const { threadId, turnId, params, eventObject } = message;
    if (!threadId || !canStartLiveRun(params, eventObject)) {
      return;
    }

    if (turnId) {
      const existing = findExactLiveRun(message);
      if (existing) {
        return;
      }
      const anonymousRun = uniqueAnonymousRun(threadId);
      if (anonymousRun && uniqueLiveRun(threadId) === anonymousRun) {
        promoteRun(anonymousRun, turnId);
        return;
      }
    } else {
      const anonymousRun = uniqueAnonymousRun(threadId);
      if (anonymousRun && anonymousRun.terminalObservedAt == null) {
        return;
      }
    }

    addLiveRun(createLiveRun(threadId, turnId));
  }

  async function notifyCompletion(run, result, params, eventObject) {
    run.terminalObservedAt ??= now();
    if (!run.turnId) {
      threadsWithAnonymousCompletions.delete(run.threadId);
      threadsWithAnonymousCompletions.add(run.threadId);
      while (threadsWithAnonymousCompletions.size > MAX_LIVE_RUN_ENTRIES) {
        threadsWithAnonymousCompletions.delete(threadsWithAnonymousCompletions.values().next().value);
      }
    }
    const completedAt = readCompletionTimestamp(params, eventObject);
    if (now() - run.terminalObservedAt > MAX_COMPLETION_AGE_MS
      || (completedAt !== null && Math.abs(now() - completedAt) > MAX_COMPLETION_AGE_MS)) {
      retireRun(run);
      return;
    }
    if (!pushServiceClient?.hasConfiguredBaseUrl) {
      retireRun(run);
      return;
    }

    // Canonical IDs can arrive while a send is awaiting HTTP. Freeze its delivery
    // identity so promotion cannot start a second request for the same run.
    const receiptKey = run.notificationReceiptKey ?? completionReceiptKey(run);
    run.notificationReceiptKey = receiptKey;
    if (completionDedupe.hasSuccessfulNotification(receiptKey)) {
      retireRun(run);
      return;
    }
    if (!completionDedupe.beginNotification(receiptKey)) {
      return;
    }

    const title = normalizePreviewText(threadTitleById.get(run.threadId)) || "New Thread";
    const body = buildNotificationBody({
      result,
      state: run,
      params,
      eventObject,
      previewMaxChars,
    });

    try {
      const delivery = await pushServiceClient.notifyCompletion({
        threadId: run.threadId,
        turnId: run.turnId,
        result,
        title,
        body,
        // Relay delivery stays session-scoped; the local receipt must survive
        // resolveBridgeRelaySession rotating that session on every launch.
        dedupeKey: JSON.stringify([sessionId || "", receiptKey]),
      });
      if (delivery?.ok !== true) {
        throw new Error("Push service did not accept the completion notification.");
      }
      completionDedupe.commitNotification(receiptKey);
      const canonicalKey = completionReceiptKey(run);
      if (canonicalKey !== receiptKey) {
        completionDedupe.commitNotification(canonicalKey);
      }
      retireRun(run);
    } catch (error) {
      completionDedupe.abortNotification(receiptKey);
      console.error(`${logPrefix} push notify failed: ${error.message}`);
    }
  }

  function recordAssistantDelta(message) {
    const run = findLiveRun(message);
    if (!run) {
      return;
    }

    const delta = extractAssistantDeltaText(message.params, message.eventObject);
    if (!delta) {
      return;
    }
    run.latestAssistantPreview = truncatePreview(
      `${run.latestAssistantPreview}${delta}`,
      previewMaxChars
    );
  }

  function recordAssistantCompletion(message) {
    const run = findLiveRun(message);
    if (!run) {
      return;
    }

    const completedText = extractAssistantCompletedText(message.params, message.eventObject);
    if (!completedText) {
      return;
    }
    run.latestAssistantPreview = truncatePreview(completedText, previewMaxChars);
  }

  function recordFailure(run, params, eventObject) {
    const failureMessage = extractFailureMessage(params, eventObject);
    if (failureMessage) {
      run.latestFailurePreview = truncatePreview(failureMessage, previewMaxChars);
    }
  }

  function createLiveRun(threadId, turnId) {
    return {
      identity: randomUUID(),
      threadId,
      turnId: turnId || null,
      latestAssistantPreview: "",
      latestFailurePreview: "",
    };
  }

  function addLiveRun(run) {
    while (liveRunsByIdentity.size >= MAX_LIVE_RUN_ENTRIES) {
      retireRun(liveRunsByIdentity.values().next().value);
    }
    const previousAnonymousRuns = runsForThread(run.threadId)
      .filter((previous) => !previous.turnId && previous.terminalObservedAt != null);
    run.requiresIdentityConfirmation = !run.turnId
      && threadsWithAnonymousCompletions.has(run.threadId);
    for (const previous of previousAnonymousRuns) {
      previous.requiresIdentityConfirmation = true;
      previous.superseded = true;
    }
    liveRunsByIdentity.set(run.identity, run);
    addIndexEntry(runIdentitiesByThreadId, run.threadId, run.identity);
    addIndexEntry(runIdentitiesByTurnId, run.turnId, run.identity);
  }

  function promoteRun(run, turnId) {
    if (!run || run.turnId || !turnId) {
      return run;
    }
    run.turnId = turnId;
    addIndexEntry(runIdentitiesByTurnId, turnId, run.identity);
    return run;
  }

  function readLatestTurnId(run) {
    if (run.identityConfirmation) return run.identityConfirmation;
    if (!pushServiceClient?.hasConfiguredBaseUrl || typeof readThread !== "function") {
      return Promise.resolve(null);
    }
    const confirmation = (async () => {
      try {
        const snapshot = await readThread(run.threadId);
        const thread = snapshot?.thread;
        if (thread?.id !== run.threadId || !Array.isArray(thread.turns)) return null;
        // Remember authoritative terminal history so a later re-announcement
        // cannot re-arm an older anonymous completion after the new run ends.
        for (const turn of thread.turns.slice(-MAX_LIVE_RUN_ENTRIES, -1)) {
          const turnId = readString(turn?.id);
          if (!turnId || canStartLiveRun({ turn })
            || findExactLiveRun({ threadId: run.threadId, turnId })) continue;
          const key = completionReceiptKey({ threadId: run.threadId, turnId });
          historicalTurnKeys.delete(key);
          historicalTurnKeys.add(key);
        }
        while (historicalTurnKeys.size > MAX_LIVE_RUN_ENTRIES) {
          historicalTurnKeys.delete(historicalTurnKeys.values().next().value);
        }
        // thread/read returns turns oldest first. Only the newest turn can
        // identify the latest observed run; older IDs remain historical.
        const latestTurn = thread.turns.at(-1);
        return readString(latestTurn?.id) || null;
      } catch {
        // A later live event can retry the read. Unavailable history is not
        // evidence that an unmatched terminal belongs to the current run.
        return null;
      }
    })();
    run.identityConfirmation = confirmation;
    void confirmation.finally(() => {
      if (run.identityConfirmation === confirmation) run.identityConfirmation = null;
    });
    return confirmation;
  }

  function findLiveRun(message) {
    const { threadId, turnId } = message;
    const exactRun = findExactLiveRun(message);
    if (exactRun) {
      return exactRun;
    }
    if (!threadId) {
      return null;
    }
    if (turnId) {
      const anonymousRun = uniqueAnonymousRun(threadId);
      return uniqueLiveRun(threadId) === anonymousRun
        ? promoteRun(anonymousRun, turnId)
        : null;
    }
    return uniqueLiveRun(threadId);
  }

  function findExactLiveRun({ threadId, turnId }) {
    return findIndexedRun(runIdentitiesByTurnId, turnId, threadId);
  }

  function findIndexedRun(index, value, threadId = null) {
    const identities = value ? index.get(value) : null;
    if (!identities) {
      return null;
    }
    const matches = [...identities]
      .map((identity) => liveRunsByIdentity.get(identity))
      .filter((run) => run && (!threadId || run.threadId === threadId));
    return matches.length === 1 ? matches[0] : null;
  }

  function uniqueLiveRun(threadId) {
    const runs = runsForThreadLookup(threadId);
    return runs.length === 1 ? runs[0] : null;
  }

  function uniqueAnonymousRun(threadId) {
    const anonymousRuns = runsForThreadLookup(threadId).filter((run) => !run.turnId);
    return anonymousRuns.length === 1 ? anonymousRuns[0] : null;
  }

  function runsForThreadLookup(threadId) {
    const runs = runsForThread(threadId);
    const activeRuns = runs.filter((run) => run.terminalObservedAt == null);
    return activeRuns.length > 0 ? activeRuns : runs;
  }

  function runsForThread(threadId) {
    const identities = runIdentitiesByThreadId.get(threadId) || [];
    return [...identities]
      .map((identity) => liveRunsByIdentity.get(identity))
      .filter(Boolean);
  }

  function retireRun(run) {
    if (!run || !liveRunsByIdentity.delete(run.identity)) {
      return;
    }
    removeIndexEntry(runIdentitiesByThreadId, run.threadId, run.identity);
    removeIndexEntry(runIdentitiesByTurnId, run.turnId, run.identity);
  }

  function addIndexEntry(index, key, identity) {
    if (!key) {
      return;
    }
    const identities = index.get(key) || new Set();
    identities.add(identity);
    index.set(key, identities);
  }

  function removeIndexEntry(index, key, identity) {
    const identities = key ? index.get(key) : null;
    if (!identities) {
      return;
    }
    identities.delete(identity);
    if (identities.size === 0) {
      index.delete(key);
    }
  }

  return {
    handleOutbound,
  };
}

module.exports = { createPushNotificationTracker };
