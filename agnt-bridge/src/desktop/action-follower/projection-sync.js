const { projectPendingDesktopActions } = require("../desktop-action-projection");
const {
  desktopLiveStateForProjection,
  hasNormalizedHistoryOutsideRawTurns,
  projectedResolvedNotification,
} = require("../desktop-ipc-action-follower-support");
const { desktopThreadReplacedNotification } = require("./read-serving");

function createProjectionSync({
  canonicalHistoryReplacementSentThreadIds,
  canonicalHistoryThreadIds,
  conversationProjector,
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
    if (isFullSnapshot
      && canonicalHistoryThreadIds.has(threadId)
      && canonicalHistoryReplacementSentThreadIds.has(threadId)) {
      syncCanonicalSnapshotLifecycle(threadId, liveState);
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
    const output = conversationProjector.project(threadId, liveState);
    if (resumedAfterStaleYield || output.type === "fullReplace" || output.type === "baseline") {
      sendApplicationResponse(JSON.stringify(desktopThreadReplacedNotification(threadId)));
    }
    for (const notification of output.notifications || []) {
      sendApplicationResponse(JSON.stringify(notification));
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

module.exports = {
  createProjectionSync,
};
