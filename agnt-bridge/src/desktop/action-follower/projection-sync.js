const { projectPendingDesktopActions } = require("../desktop-action-projection");
const {
  desktopLiveStateForProjection,
  hasNormalizedHistoryOutsideRawTurns,
  projectedResolvedNotification,
} = require("../desktop-ipc-action-follower-support");
const { desktopThreadReplacedNotification } = require("./read-serving");
const { drainPendingReviewOverlays } = require("./review-overlay-replay");

function createProjectionSync({
  canonicalHistoryReplacementSentThreadIds,
  canonicalHistoryThreadIds,
  conversationProjector,
  normalizedReviewFingerprintsByThreadId,
  pendingRoutesByRequestId,
  rememberCanonicalActiveTurns,
  sendApplicationResponse,
  staleYieldedThreadIds,
  syncCanonicalSnapshotLifecycle,
}) {
  function syncProjectedActions(threadId, actions) {
    const nextRequestIds = new Set(actions.map((action) => action.id));
    for (const [requestId, route] of Array.from(pendingRoutesByRequestId.entries())) {
      if (route.threadId !== threadId || nextRequestIds.has(requestId)) {
        continue;
      }

      pendingRoutesByRequestId.delete(requestId);
      sendApplicationResponse(JSON.stringify(projectedResolvedNotification(threadId, requestId)));
    }

    for (const action of actions) {
      if (pendingRoutesByRequestId.has(action.id)) {
        continue;
      }

      pendingRoutesByRequestId.set(action.id, {
        requestId: action.id,
        method: action.method,
        threadId,
      });
      sendApplicationResponse(JSON.stringify({
        id: action.id,
        method: action.method,
        params: action.params,
      }));
    }
  }

  function syncProjectedConversationState(threadId, nextState, { isFullSnapshot = false } = {}) {
    const resumedAfterStaleYield = staleYieldedThreadIds.delete(threadId);
    if (!canonicalHistoryThreadIds.has(threadId) && hasNormalizedHistoryOutsideRawTurns(nextState)) {
      canonicalHistoryThreadIds.add(threadId);
    }

    const liveState = desktopLiveStateForProjection(nextState);
    // Guardian reviews on normalized-only history turns never appear in
    // canonical thread/read history, so drain their overlays wherever this
    // sync (re)builds the live projection; otherwise a thread that stays
    // idle after this sync never delivers them.
    const drainReviewOverlays = () => drainPendingReviewOverlays({
      threadId,
      rawState: nextState,
      liveTurns: liveState.turns,
      fingerprintsByThreadId: normalizedReviewFingerprintsByThreadId,
      sendApplicationResponse,
    });
    if (isFullSnapshot
      && canonicalHistoryThreadIds.has(threadId)
      && canonicalHistoryReplacementSentThreadIds.has(threadId)) {
      syncCanonicalSnapshotLifecycle(threadId, liveState);
      drainReviewOverlays();
      conversationProjector.seed(threadId, liveState);
      return;
    }
    if (canonicalHistoryThreadIds.has(threadId)
      && !canonicalHistoryReplacementSentThreadIds.has(threadId)) {
      canonicalHistoryReplacementSentThreadIds.add(threadId);
      conversationProjector.remove(threadId);
      const bootstrapOutput = conversationProjector.project(threadId, liveState, {
        includeAllActiveTurns: true,
      });
      sendApplicationResponse(JSON.stringify(desktopThreadReplacedNotification(threadId)));
      drainReviewOverlays();
      syncCanonicalSnapshotLifecycle(threadId, liveState);
      for (const notification of bootstrapOutput.notifications || []) {
        if (String(notification?.method || "").startsWith("item/")) {
          sendApplicationResponse(JSON.stringify(notification));
        }
      }
      return;
    }

    if (resumedAfterStaleYield) {
      conversationProjector.remove(threadId);
    }
    drainReviewOverlays();
    const output = conversationProjector.project(threadId, liveState);
    if (resumedAfterStaleYield || output.type === "fullReplace" || output.type === "baseline") {
      sendApplicationResponse(JSON.stringify(desktopThreadReplacedNotification(threadId)));
    }
    for (const notification of output.notifications || []) {
      const notificationTurnId = String(notification?.params?.turnId || "");
      const projectedNotification = output.turnIdentityContinuityTurnIds?.includes(notificationTurnId)
        ? notificationWithTurnIdentityContinuity(notification)
        : notification;
      sendApplicationResponse(JSON.stringify(projectedNotification));
    }
  }

  function syncProjectedActionsFromState(threadId, nextState) {
    syncProjectedActions(threadId, projectPendingDesktopActions(threadId, nextState));
  }

  return {
    syncProjectedActions,
    syncProjectedActionsFromState,
    syncProjectedConversationState,
  };
}

function notificationWithTurnIdentityContinuity(notification) {
  if (notification?.method !== "turn/started") {
    return notification;
  }
  return {
    ...notification,
    params: {
      ...(notification.params || {}),
      agntTurnIdentityContinuity: true,
    },
  };
}

module.exports = {
  createProjectionSync,
};
