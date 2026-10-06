const { desktopLiveStateForProjection } = require("./action-follower/state");
const net = require("net");

const { createDesktopConversationProjector, projectDesktopConversationStateToThread } = require("./desktop-ipc-conversation-projector");
const {
  createDesktopIpcClient,
  isDeliveryFailureError,
  markDeliveryFailureError,
} = require("./desktop-ipc-client");
const { buildDesktopTurnsListResult } = require("./desktop-turns-pagination");
const { createBackgroundPromotion } = require("./action-follower/background-promotion");
const { createBaselineRecovery } = require("./action-follower/baseline-recovery");
const { createDesktopLifecycleSync } = require("./action-follower/lifecycle");
const { createDesktopReadServer } = require("./action-follower/read-serving");
const { createDesktopRequestRouter } = require("./action-follower/request-routing");
const { createProjectionSync } = require("./action-follower/projection-sync");
const { createThreadStateManager } = require("./action-follower/thread-state");
const { createPendingSnapshotScheduler } = require("./action-follower/pending-snapshots");
const {
  projectDesktopAssistantDeltaNotifications,
  projectPendingDesktopActions,
} = require("./desktop-action-projection");
const { createActiveThreadCache } = require("./desktop-ipc-action-follower-active-threads");
const { createHeldFollowerRequestState } = require("./desktop-ipc-action-follower-held-requests");
const {
  applyConversationStateChange,
  buildDesktopFollowerRoute,
  createEmptyConversationState,
  desktopFollowerPayloadForResponse,
  isPatchChange,
  isPeerOwnershipSnapshot,
  isSnapshotChange,
  isagntLiveOwnerBroadcast,
  readThreadId,
  seedConversationStateFromThreadRead,
} = require("./desktop-ipc-action-follower-support");
const {
  CLIENT_STATUS_CHANGED,
  DESKTOP_IPC_METHOD_VERSIONS: METHOD_VERSION_BY_NAME,
  THREAD_STREAM_FOLLOWING_CHANGED,
  THREAD_STREAM_FOLLOWING_STATUS_REQUESTED,
  cloneJSON,
  normalizeToken,
  readString,
  resolveDefaultIpcSocketPath,
  safeParseJSON,
} = require("./desktop-ipc-shared");
const { createFollowerStateTracker } = require("./desktop-ipc-follower-tracker");

const REQUEST_TIMEOUT_MS = 10_000;
const OWNERSHIP_PROBE_TIMEOUT_MS = 1_500;
const BACKGROUND_DISCONNECT_GRACE_MS = 30_000;
const MAX_BASELINE_RECOVERY_ATTEMPTS = 5;
const BASELINE_RECOVERY_BASE_DELAY_MS = 1_000;
const BASELINE_RECOVERY_MAX_DELAY_MS = 15_000;
const MAX_QUEUED_CHANGES_PER_THREAD = 300;
const MAX_ACTIVE_THREAD_IDS = 512;
const DESKTOP_STATE_READ_METHODS = new Set([
  "thread/read",
  "thread/resume",
  "thread/turns/list",
  "thread/goal/get",
]);
const DESKTOP_BACKGROUND_DISCOVERY_METHODS = new Set(["thread/list"]);
const STALE_ACTIVE_READ_MAX_AGE_MS = 20_000;
const CONNECTED_IPC_ACTIVITY_LEASE_MS = 5 * 60_000;
const DESKTOP_FOLLOWER_REQUEST_METHODS = new Set([
  "thread/settings/update",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/compact/start",
]);
const DESKTOP_OWNER_UNSUPPORTED_MUTATION_ERRORS = new Map([
  ["review/start", "Start this review in Codex Desktop."],
  ["thread/approveGuardianDeniedAction", "Approve this retry in Codex Desktop."],
]);

function createDesktopIpcActionFollower({
  sendApplicationResponse,
  readConversationState = null,
  forwardToLocalCodex = null,
  isLocallyOwnedThread = () => false,
  normalizeTurnStartParams = (params) => params,
  logPrefix = "[agnt]",
  socketPath = resolveDefaultIpcSocketPath(),
  netModule = net,
  now = () => Date.now(),
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ownershipProbeTimeoutMs = OWNERSHIP_PROBE_TIMEOUT_MS,
  backgroundDisconnectGraceMs = BACKGROUND_DISCONNECT_GRACE_MS,
  snapshotDebounceMs = 0,
  onFollowerStateChanged = null,
  runtimeSettingsStore = null,
  onActivityObservation = null,
} = {}) {
  let activityGeneration = 0;
  const ipc = createDesktopIpcClient({
    socketPath,
    netModule,
    now,
    requestTimeoutMs,
    logPrefix,
    onEnvelope,
    onConnected() {
      activityGeneration += 1;
      announceDesktopFollowForActiveThreads();
      heldFollowerRequests.probeHeldRequests();
    },
    onDisconnect,
  });
  // Threads this bridge itself is announcing as "following" to Desktop's own
  // renderer(s) — mirrors what Desktop's route-mount lifecycle would do if a
  // human opened the same Desktop-owned thread locally.
  const desktopFollowThreadIds = new Set();
  const followerTracker = createFollowerStateTracker({
    isTrackedThread: (threadId) => !isLocallyOwnedThread(threadId) && !liveOwnerThreadIds.has(threadId),
    onFollowerStateChanged,
  });

  function followDesktopThread(threadId, targetClientIds = undefined) {
    if (!threadId || isLocallyOwnedThread(threadId) || liveOwnerThreadIds.has(threadId)) {
      return false;
    }
    desktopFollowThreadIds.add(threadId);
    return ipc.sendBroadcast(THREAD_STREAM_FOLLOWING_CHANGED, {
      hostId: "local",
      conversationId: threadId,
      following: true,
    }, { targetClientIds });
  }

  function unfollowDesktopThread(threadId) {
    if (!desktopFollowThreadIds.delete(threadId)) {
      return false;
    }
    return ipc.sendBroadcast(THREAD_STREAM_FOLLOWING_CHANGED, {
      hostId: "local",
      conversationId: threadId,
      following: false,
    });
  }

  function announceDesktopFollowForActiveThreads() {
    for (const threadId of desktopFollowThreadIds) {
      followDesktopThread(threadId);
    }
  }
  const rawStatesByThreadId = new Map();
  const rawStateUpdatedAtByThreadId = new Map();
  const pendingSnapshotsByThreadId = new Map();
  const conversationProjector = createDesktopConversationProjector({ now });
  const pendingRoutesByRequestId = new Map();
  let threadStateManager = null;
  const backgroundOnlyThreadIds = new Set();
  const announcedBackgroundTurnsByThreadId = new Map();
  const backgroundDisconnectTimersByThreadId = new Map();
  const canonicalHistoryThreadIds = new Set();
  const canonicalHistoryReplacementSentThreadIds = new Set();
  const canonicalActiveTurnsByThreadId = new Map();
  const staleYieldedThreadIds = new Set();
  const normalizedReviewFingerprintsByThreadId = new Map();
  const activeThreads = createActiveThreadCache({
    maxSize: MAX_ACTIVE_THREAD_IDS,
    isEvictable(threadId) {
      for (const route of pendingRoutesByRequestId.values()) {
        if (route.threadId === threadId) {
          return false;
        }
      }
      return !announcedBackgroundTurnsByThreadId.has(threadId);
    },
    onEvict(threadId) {
      threadStateManager.forgetEvictedThreadState(threadId);
    },
  });
  const recoveringThreadIds = new Set();
  const queuedChangesByThreadId = new Map();
  const baselineRecoveryStateByThreadId = new Map();
  const liveOwnerThreadIds = new Set();
  let requestRouter = null;
  let projectionSync = null;
  const heldFollowerRequests = createHeldFollowerRequestState({
    activeThreads,
    forwardToLocalCodex,
    hasLiveOwnerThread(threadId) {
      return liveOwnerThreadIds.has(threadId);
    },
    hasRawState(threadId) {
      return rawStatesByThreadId.has(threadId);
    },
    isLocallyOwnedThread,
    ipc,
    methodVersionByName: METHOD_VERSION_BY_NAME,
    now,
    ownershipProbeTimeoutMs,
    sendApplicationResponse,
    submitDesktopFollowerRequest(...args) {
      return requestRouter.submitDesktopFollowerRequest(...args);
    },
  });
  requestRouter = createDesktopRequestRouter({
    runtimeSettingsStore,
    isKnownDesktopOwner: (threadId) => rawStatesByThreadId.has(threadId),
    forwardToLocalCodex,
    ipc,
    isDeliveryFailureError,
    logPrefix,
    markDeliveryFailureError,
    normalizeTurnStartParams,
    pendingRoutesByRequestId,
    releaseDesktopThreadState,
    sendApplicationResponse,
  });
  const lifecycleSync = createDesktopLifecycleSync({
    activeThreads,
    announcedBackgroundTurnsByThreadId,
    backgroundDisconnectGraceMs,
    backgroundDisconnectTimersByThreadId,
    backgroundOnlyThreadIds,
    canonicalActiveTurnsByThreadId,
    conversationProjector,
    rawStateUpdatedAtByThreadId,
    rawStatesByThreadId,
    sendApplicationResponse,
    syncProjectedActions(...args) {
      return projectionSync.syncProjectedActions(...args);
    },
  });
  const readServer = createDesktopReadServer({
    activeThreads,
    canonicalHistoryThreadIds,
    isLocallyOwnedThread,
    liveOwnerThreadIds,
    now,
    rawStateUpdatedAtByThreadId,
    rawStatesByThreadId,
    sendApplicationResponse,
    staleActiveReadMaxAgeMs: STALE_ACTIVE_READ_MAX_AGE_MS,
    staleYieldedThreadIds,
    stateReadMethods: DESKTOP_STATE_READ_METHODS,
    hasResponsiveDesktopIpc() {
      return ipc.hasRecentActivity(CONNECTED_IPC_ACTIVITY_LEASE_MS);
    },
  });
  const baselineRecovery = createBaselineRecovery({
    backgroundOnlyThreadIds,
    baselineRecoveryBaseDelayMs: BASELINE_RECOVERY_BASE_DELAY_MS,
    baselineRecoveryMaxDelayMs: BASELINE_RECOVERY_MAX_DELAY_MS,
    baselineRecoveryStateByThreadId,
    commitRecoveredState,
    conversationProjector,
    logPrefix,
    maxBaselineRecoveryAttempts: MAX_BASELINE_RECOVERY_ATTEMPTS,
    maxQueuedChangesPerThread: MAX_QUEUED_CHANGES_PER_THREAD,
    now,
    queuedChangesByThreadId,
    rawStatesByThreadId,
    readConversationState,
    recoveringThreadIds,
  });
  const {
    clearBackgroundDisconnectTimer,
    rememberCanonicalActiveTurns,
    scheduleBackgroundDisconnectSettlement,
    settleAnnouncedBackgroundTurn,
    syncBackgroundThreadLifecycle,
    syncCanonicalSnapshotLifecycle,
    syncThreadArchiveBroadcast,
  } = lifecycleSync;
  projectionSync = createProjectionSync({
    runtimeSettingsStore,
    canonicalHistoryReplacementSentThreadIds,
    canonicalHistoryThreadIds,
    conversationProjector,
    normalizedReviewFingerprintsByThreadId,
    pendingRoutesByRequestId,
    rememberCanonicalActiveTurns,
    sendApplicationResponse,
    staleYieldedThreadIds,
    syncCanonicalSnapshotLifecycle,
  });
  const {
    syncProjectedActions,
    syncProjectedActionsFromState,
    syncProjectedConversationState,
  } = projectionSync;
  const {
    cancelPendingSnapshot,
    schedulePendingSnapshot,
  } = createPendingSnapshotScheduler({
    commitConversationState,
    pendingSnapshotsByThreadId,
    snapshotDebounceMs,
  });
  threadStateManager = createThreadStateManager({
    onActivityObservation,
    activeThreads,
    announcedBackgroundTurnsByThreadId,
    backgroundDisconnectTimersByThreadId,
    backgroundOnlyThreadIds,
    baselineRecoveryStateByThreadId,
    cancelPendingSnapshot,
    canonicalActiveTurnsByThreadId,
    canonicalHistoryReplacementSentThreadIds,
    canonicalHistoryThreadIds,
    conversationProjector,
    heldFollowerRequests,
    ipc,
    liveOwnerThreadIds,
    normalizedReviewFingerprintsByThreadId,
    pendingRoutesByRequestId,
    pendingSnapshotsByThreadId,
    queuedChangesByThreadId,
    rawStateUpdatedAtByThreadId,
    rawStatesByThreadId,
    recoveringThreadIds,
    scheduleBackgroundDisconnectSettlement,
    settleAnnouncedBackgroundTurn,
    staleYieldedThreadIds,
    syncProjectedActions,
    unfollowDesktopThread,
    followerTracker,
  });
  const { tryServeDesktopOwnedRead } = readServer;
  const { queueThreadChange, recoverThreadBaseline } = baselineRecovery;
  const { promoteBackgroundThreadOnRead } = createBackgroundPromotion({
    announcedBackgroundTurnsByThreadId,
    backgroundOnlyThreadIds,
    canonicalHistoryReplacementSentThreadIds,
    canonicalHistoryThreadIds,
    clearBackgroundDisconnectTimer,
    conversationProjector,
    normalizedReviewFingerprintsByThreadId,
    rememberCanonicalActiveTurns,
    sendApplicationResponse,
    settleAnnouncedBackgroundTurn,
    syncBackgroundThreadLifecycle,
  });

  function observeInbound(rawMessage, parsedMessage = null) {
    const message = parsedMessage ?? safeParseJSON(rawMessage);
    const responseRoute = requestRouter.desktopRouteForResponse(message);
    if (responseRoute) {
      requestRouter.submitDesktopActionResponse(responseRoute, message);
      return true;
    }

    const method = readString(message?.method);
    if (DESKTOP_BACKGROUND_DISCOVERY_METHODS.has(method)) {
      ipc.ensureConnected();
    }
    if (DESKTOP_STATE_READ_METHODS.has(method)) {
      const threadId = readThreadId(message?.params);
      if (threadId) {
        promoteBackgroundThreadOnRead(threadId, rawStatesByThreadId.get(threadId));
      }
    }
    if (DESKTOP_FOLLOWER_REQUEST_METHODS.has(method)) {
      const route = buildDesktopFollowerRoute(message);
      if (route && heldFollowerRequests.isDesktopRoutable(route.threadId)) {
        requestRouter.submitDesktopFollowerRequest(route, message);
        return true;
      }
      if (route && heldFollowerRequests.shouldHold(message, route.threadId)) {
        heldFollowerRequests.hold(route.threadId, rawMessage);
        heldFollowerRequests.probeDesktopOwnership(route);
        return true;
      }
    }

    if (tryRejectDesktopOwnedUnsupportedMutation(message, method)) {
      return true;
    }

    if (tryServeDesktopOwnedRead(message)) {
      return true;
    }

    if (!DESKTOP_STATE_READ_METHODS.has(method)) {
      return false;
    }

    const threadId = readThreadId(message?.params);
    if (!threadId) {
      return false;
    }

    activeThreads.remember(threadId);
    if (!rawStatesByThreadId.has(threadId)
      && !liveOwnerThreadIds.has(threadId)
      && !isLocallyOwnedThread(threadId)) {
      heldFollowerRequests.setProbeDeadline(threadId);
    }
    ipc.ensureConnected();
    followDesktopThread(threadId);
    return false;
  }

  function tryRejectDesktopOwnedUnsupportedMutation(message, method) {
    if (!DESKTOP_OWNER_UNSUPPORTED_MUTATION_ERRORS.has(method) || message?.id == null) {
      return false;
    }
    const threadId = readThreadId(message?.params);
    if (!threadId || liveOwnerThreadIds.has(threadId) || isLocallyOwnedThread(threadId)) {
      return false;
    }
    if (!heldFollowerRequests.isDesktopRoutable(threadId)
      && !activeThreads.has(threadId)) {
      return false;
    }
    sendApplicationResponse(JSON.stringify({
      id: message.id,
      error: {
        code: -32004,
        message: DESKTOP_OWNER_UNSUPPORTED_MUTATION_ERRORS.get(method),
      },
    }));
    return true;
  }

  function stopAll() {
    onActivityObservation?.({ type: "disconnected", sourceGeneration: activityGeneration });
    for (const threadId of desktopFollowThreadIds) {
      unfollowDesktopThread(threadId);
    }
    desktopFollowThreadIds.clear();
    followerTracker.clear();
    threadStateManager.stopAll();
  }

  function onEnvelope(envelope) {
    if (envelope?.type === "broadcast" && envelope.method === CLIENT_STATUS_CHANGED) {
      if (normalizeToken(envelope.params?.status) === "disconnected") {
        followerTracker.removeFollowerClient(envelope.params?.clientId || envelope.sourceClientId);
      }
      return;
    }
    if (envelope?.type === "broadcast" && envelope.method === THREAD_STREAM_FOLLOWING_CHANGED) {
      followerTracker.updateFollowerState(envelope, ipc.clientId);
      return;
    }
    if (envelope?.type === "broadcast" && envelope.method === THREAD_STREAM_FOLLOWING_STATUS_REQUESTED) {
      const params = envelope.params || {};
      const threadId = readString(params.conversationId) || readString(params.conversation_id);
      if (threadId && desktopFollowThreadIds.has(threadId)) {
        followDesktopThread(threadId, [envelope.sourceClientId].filter(Boolean));
      }
      return;
    }
    if (envelope?.type === "broadcast"
      && (envelope.method === "thread-archived" || envelope.method === "thread-unarchived")) {
      syncThreadArchiveBroadcast(envelope);
      return;
    }
    if (envelope?.type !== "broadcast" || envelope.method !== "thread-stream-state-changed") {
      return;
    }

    const params = envelope.params || {};
    const threadId = readString(params.conversationId) || readString(params.conversation_id);
    if (isagntLiveOwnerBroadcast(params)) {
      if (threadId) {
        if (params.agntOwnerReleased === true) {
          removeDesktopThreadState(threadId);
        } else {
          releaseDesktopThreadState(threadId);
        }
      }
      return;
    }
    if (!threadId) {
      return;
    }
    const peerOwnershipSnapshot = isPeerOwnershipSnapshot(params);
    if (peerOwnershipSnapshot && !isLocallyOwnedThread(threadId)) {
      liveOwnerThreadIds.delete(threadId);
      heldFollowerRequests.forgetThread(threadId);
    } else if (liveOwnerThreadIds.has(threadId) || isLocallyOwnedThread(threadId)) {
      return;
    }
    if (!activeThreads.has(threadId) && isSnapshotChange(params.change)) {
      activeThreads.remember(threadId);
      backgroundOnlyThreadIds.add(threadId);
    }
    if (!activeThreads.has(threadId)) {
      return;
    }

    if (recoveringThreadIds.has(threadId)) {
      queueThreadChange(threadId, params.change);
      return;
    }

    const pendingSnapshot = pendingSnapshotsByThreadId.get(threadId);
    if (pendingSnapshot && isPatchChange(params.change)) {
      const patchedSnapshot = applyConversationStateChange(pendingSnapshot.state, params.change);
      if (patchedSnapshot) {
        pendingSnapshot.state = patchedSnapshot;
        return;
      }
      cancelPendingSnapshot(threadId);
    }

    const previousState = rawStatesByThreadId.get(threadId) || null;
    const nextState = applyConversationStateChange(previousState, params.change);
    if (!nextState) {
      if (isPatchChange(params.change)) {
        const emptyState = createEmptyConversationState();
        const speculativeState = applyConversationStateChange(emptyState, params.change);
        const speculativeActions = projectPendingDesktopActions(threadId, speculativeState);
        if (speculativeActions.length > 0) {
          rawStatesByThreadId.set(threadId, speculativeState);
          rawStateUpdatedAtByThreadId.set(threadId, now());
          conversationProjector.seed(threadId, speculativeState);
          syncProjectedActions(threadId, speculativeActions);
          heldFollowerRequests.release(threadId, { toDesktop: true });
          return;
        }

        if (typeof readConversationState !== "function") {
          return;
        }

        queueThreadChange(threadId, params.change);
        recoverThreadBaseline(threadId);
      }
      return;
    }

    if (isSnapshotChange(params.change) && snapshotDebounceMs > 0) {
      schedulePendingSnapshot(threadId, nextState);
      return;
    }

    commitConversationState(threadId, nextState, {
      isFullSnapshot: isSnapshotChange(params.change),
      isPatch: isPatchChange(params.change),
    });
  }

  function commitConversationState(threadId, nextState, {
    isFullSnapshot = false,
    isPatch = false,
  } = {}) {
    if (liveOwnerThreadIds.has(threadId) || isLocallyOwnedThread(threadId)) {
      return false;
    }

    rawStatesByThreadId.set(threadId, nextState);
    notifyActivityState(threadId, nextState);
    rawStateUpdatedAtByThreadId.set(threadId, now());
    baselineRecoveryStateByThreadId.delete(threadId);
    if (!isPatch) {
      queuedChangesByThreadId.delete(threadId);
    }
    if (backgroundOnlyThreadIds.has(threadId)) {
      syncBackgroundThreadLifecycle(threadId, nextState);
    } else {
      syncProjectedConversationState(threadId, nextState, {
        isFullSnapshot,
      });
    }
    syncProjectedActions(threadId, projectPendingDesktopActions(threadId, nextState));
    heldFollowerRequests.release(threadId, { toDesktop: true });
    return true;
  }

  function notifyActivityState(threadId, state) {
    if (!onActivityObservation) return;
    const liveState = desktopLiveStateForProjection(state);
    onActivityObservation({ type: "state", threadId, state: liveState, sourceGeneration: Math.max(1, activityGeneration) });
  }

  function onDisconnect() {
    onActivityObservation?.({ type: "disconnected", sourceGeneration: activityGeneration });
    threadStateManager.onDisconnect();
  }

  function releaseDesktopThreadState(threadId) {
    threadStateManager.releaseDesktopThreadState(threadId);
  }

  function removeDesktopThreadState(threadId) {
    threadStateManager.removeDesktopThreadState(threadId);
  }

  function commitRecoveredState(threadId, nextState) {
    rawStatesByThreadId.set(threadId, nextState);
    notifyActivityState(threadId, nextState);
    rawStateUpdatedAtByThreadId.set(threadId, now());
    if (backgroundOnlyThreadIds.has(threadId)) {
      syncBackgroundThreadLifecycle(threadId, nextState);
    } else {
      syncProjectedConversationState(threadId, nextState);
    }
    syncProjectedActionsFromState(threadId, nextState);
    heldFollowerRequests.release(threadId, { toDesktop: true });
  }

  return {
    observeInbound,
    stopAll,
    isLocallyAcquiredThread(threadId) { return liveOwnerThreadIds.has(readString(threadId)); },
    hasLiveThreadState(threadId) {
      return rawStatesByThreadId.has(readString(threadId));
    },
    hasFreshLiveThreadState(threadId, { fallbackActivityAt = 0, probeFallbackActivity = false } = {}) {
      const id = readString(threadId);
      if (pendingSnapshotsByThreadId.has(id)) return Boolean(id);
      const state = rawStatesByThreadId.get(id);
      if (!state) return false;
      const liveState = desktopLiveStateForProjection(state);
      if (!liveState.turns?.length) return false;
      const updatedAt = rawStateUpdatedAtByThreadId.get(id) || 0;
      const fresh = now() - updatedAt <= STALE_ACTIVE_READ_MAX_AGE_MS;
      const projected = projectDesktopConversationStateToThread(id, liveState, { now });
      const active = projected.turns.some((turn) => turn.status === "inProgress")
        || projected.status?.type === "active";
      if (!active) return fresh;
      // Probe stale IPC against the rollout mtime before choosing an emitter.
      // An unrelated Desktop heartbeat must not mute newer work for this thread.
      return ipc.hasRecentActivity(CONNECTED_IPC_ACTIVITY_LEASE_MS)
        && (fresh || (!probeFallbackActivity && Number(fallbackActivityAt) <= updatedAt));
    },
  };
}

module.exports = {
  applyConversationStateChange,
  buildDesktopTurnsListResult,
  createDesktopIpcActionFollower,
  desktopFollowerPayloadForResponse,
  projectDesktopAssistantDeltaNotifications,
  projectPendingDesktopActions,
  resolveDefaultIpcSocketPath,
  seedConversationStateFromThreadRead,
};
