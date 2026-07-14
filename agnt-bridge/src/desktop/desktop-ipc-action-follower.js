// FILE: desktop-ipc-action-follower.js
// Purpose: Mirrors live Codex Desktop IPC pending actions to the phone and routes replies back to the desktop runtime.
// Layer: CLI helper
// Exports: createDesktopIpcActionFollower, projectPendingDesktopActions
// Depends on: net, ./desktop-ipc-conversation-projector, ./desktop-ipc-shared

const net = require("net");

const {
  createDesktopConversationProjector,
  projectDesktopConversationStateToGoal,
  projectDesktopConversationStateToThread,
} = require("./desktop-ipc-conversation-projector");
const {
  createDesktopIpcClient,
  isDeliveryFailureError,
  markDeliveryFailureError,
} = require("./desktop-ipc-client");
const {
  buildDesktopTurnsListResult,
  isDesktopTurnsCursor,
} = require("./desktop-turns-pagination");
const {
  projectDesktopAssistantDeltaNotifications,
  projectPendingDesktopActions,
} = require("./desktop-action-projection");
const {
  createActiveThreadCache,
} = require("./desktop-ipc-action-follower-active-threads");
const {
  DESKTOP_IPC_ACTION_SOURCE,
  activeCanonicalTurnsById,
  appServerResultForFollowerRequest,
  applyConversationStateChange,
  backgroundRawTurn,
  backgroundRawTurnById,
  backgroundTurnLifecycleNotification,
  buildDesktopFollowerRoute,
  canonicalTurnById,
  createEmptyConversationState,
  desktopFollowerPayloadForResponse,
  desktopLiveStateForProjection,
  hasNormalizedHistoryOutsideRawTurns,
  isPatchChange,
  isPeerOwnershipSnapshot,
  isSnapshotChange,
  isagntLiveOwnerBroadcast,
  latestActiveBackgroundTurn,
  projectedResolvedNotification,
  readThreadId,
  seedConversationStateFromThreadRead,
} = require("./desktop-ipc-action-follower-support");
const {
  DESKTOP_IPC_METHOD_VERSIONS: METHOD_VERSION_BY_NAME,
  cloneJSON,
  readString,
  requestIdKey,
  resolveDefaultIpcSocketPath,
  safeParseJSON,
} = require("./desktop-ipc-shared");

const REQUEST_TIMEOUT_MS = 10_000;
const OWNERSHIP_PROBE_TIMEOUT_MS = 1_500;
const BACKGROUND_DISCONNECT_GRACE_MS = 30_000;
// Fresh Desktop threads are not materialized in the local thread store yet, so
// baseline reads fail until the rollout flushes; retry with backoff instead of
// hammering thread/read on every patch broadcast.
const MAX_BASELINE_RECOVERY_ATTEMPTS = 5;
const BASELINE_RECOVERY_BASE_DELAY_MS = 1_000;
const BASELINE_RECOVERY_MAX_DELAY_MS = 15_000;
const MAX_QUEUED_CHANGES_PER_THREAD = 300;
// Phone interest survives per-thread release by design, so cap the set to keep a
// marathon single Desktop connection from accumulating every thread id forever.
const MAX_ACTIVE_THREAD_IDS = 512;
const DESKTOP_STATE_READ_METHODS = new Set([
  "thread/read",
  "thread/resume",
  "thread/turns/list",
  "thread/goal/get",
]);
const DESKTOP_BACKGROUND_DISCOVERY_METHODS = new Set(["thread/list"]);
// A cached Desktop state that claims an active turn is only trustworthy while
// Desktop keeps streaming updates for it. Live runs broadcast deltas far more
// often than this window; a silent "active" cache is a stale reconnect echo
// (e.g. Desktop never saw the turn finish) and must not answer phone reads, or
// the phone shows a phantom running indicator until real history loads.
const STALE_ACTIVE_READ_MAX_AGE_MS = 20_000;
const DESKTOP_FOLLOWER_REQUEST_METHODS = new Set([
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/compact/start",
]);

// Opens the Desktop IPC bus on demand and exposes Mac-owned pending actions as normal app-server requests.
function createDesktopIpcActionFollower({
  sendApplicationResponse,
  readConversationState = null,
  forwardToLocalCodex = null,
  // Synchronous authority check against the bridge's own live owner: threads
  // streamed by the local app-server must never be held, served, or routed as
  // Desktop-owned. Broadcast-driven liveOwnerThreadIds lags this check, so it
  // alone cannot close the race between a local claim and a Desktop echo.
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
} = {}) {
  const ipc = createDesktopIpcClient({
    socketPath,
    netModule,
    now,
    requestTimeoutMs,
    logPrefix,
    onEnvelope,
    onConnected() {
      probeHeldFollowerRequests();
    },
    onDisconnect,
  });
  const rawStatesByThreadId = new Map();
  const rawStateUpdatedAtByThreadId = new Map();
  const pendingSnapshotsByThreadId = new Map();
  const conversationProjector = createDesktopConversationProjector({ now });
  const pendingRoutesByRequestId = new Map();
  const backgroundOnlyThreadIds = new Set();
  const announcedBackgroundTurnsByThreadId = new Map();
  const backgroundDisconnectTimersByThreadId = new Map();
  const canonicalHistoryThreadIds = new Set();
  const canonicalHistoryReplacementSentThreadIds = new Set();
  const canonicalActiveTurnsByThreadId = new Map();
  const staleYieldedThreadIds = new Set();
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
    onEvict: forgetEvictedThreadState,
  });

  // Cleanup for cap-evicted threads only: clears follower caches without touching
  // liveOwnerThreadIds (still-owned local streams must not become hijackable) and
  // without rejecting held requests (removeDesktopThreadState handles real removal).
  function forgetEvictedThreadState(threadId) {
    settleAnnouncedBackgroundTurn(threadId, "interrupted");
    backgroundOnlyThreadIds.delete(threadId);
    rawStatesByThreadId.delete(threadId);
    rawStateUpdatedAtByThreadId.delete(threadId);
    cancelPendingSnapshot(threadId);
    canonicalHistoryThreadIds.delete(threadId);
    canonicalHistoryReplacementSentThreadIds.delete(threadId);
    canonicalActiveTurnsByThreadId.delete(threadId);
    staleYieldedThreadIds.delete(threadId);
    conversationProjector.remove(threadId);
    queuedChangesByThreadId.delete(threadId);
    baselineRecoveryStateByThreadId.delete(threadId);
    recoveringThreadIds.delete(threadId);
    ownershipProbeDeadlinesByThreadId.delete(threadId);
    pendingOwnershipProbeTokensByThreadId.delete(threadId);
    desktopOwnedByProbeThreadIds.delete(threadId);
  }
  const recoveringThreadIds = new Set();
  const queuedChangesByThreadId = new Map();
  const baselineRecoveryStateByThreadId = new Map();
  const liveOwnerThreadIds = new Set();
  const heldFollowerRequestsByThreadId = new Map();
  const ownershipProbeDeadlinesByThreadId = new Map();
  const pendingOwnershipProbeTokensByThreadId = new Map();
  const desktopOwnedByProbeThreadIds = new Set();
  let nextOwnershipProbeToken = 0;

  function observeInbound(rawMessage, parsedMessage = null) {
    const message = parsedMessage ?? safeParseJSON(rawMessage);
    const responseRoute = desktopRouteForResponse(message);
    if (responseRoute) {
      submitDesktopActionResponse(responseRoute, message);
      return true;
    }

    const method = readString(message?.method);
    if (DESKTOP_BACKGROUND_DISCOVERY_METHODS.has(method)) {
      ipc.ensureConnected();
    }
    if (DESKTOP_STATE_READ_METHODS.has(method)) {
      const threadId = readThreadId(message?.params);
      if (threadId && backgroundOnlyThreadIds.delete(threadId)) {
        const rawState = rawStatesByThreadId.get(threadId);
        if (rawState) {
          syncBackgroundThreadLifecycle(threadId, rawState);
          const announcedBackgroundTurn = announcedBackgroundTurnsByThreadId.get(threadId) || null;
          const announcedBackgroundTurnId = readString(announcedBackgroundTurn?.id);
          const hasCanonicalNormalizedHistory = canonicalHistoryThreadIds.has(threadId)
            || hasNormalizedHistoryOutsideRawTurns(rawState);
          const liveState = desktopLiveStateForProjection(rawState);
          if (hasCanonicalNormalizedHistory) {
            canonicalHistoryThreadIds.add(threadId);
            canonicalHistoryReplacementSentThreadIds.add(threadId);
            conversationProjector.remove(threadId);
            sendApplicationResponse(JSON.stringify({
              method: "thread/replaced",
              params: {
                threadId,
                agntDesktopMirror: true,
                agntDesktopIpcMirror: true,
                agntActionSource: DESKTOP_IPC_ACTION_SOURCE,
              },
            }));
            const output = conversationProjector.project(threadId, liveState, {
              includeAllActiveTurns: true,
            });
            for (const notification of output.notifications || []) {
              const isDuplicateBackgroundStart = notification.method === "turn/started"
                && readString(notification.params?.turnId) === announcedBackgroundTurnId;
              if (!isDuplicateBackgroundStart) {
                sendApplicationResponse(JSON.stringify(notification));
              }
            }
            rememberCanonicalActiveTurns(threadId, liveState);
          } else {
            conversationProjector.seed(threadId, liveState);
          }
          clearBackgroundDisconnectTimer(threadId);
          announcedBackgroundTurnsByThreadId.delete(threadId);
        } else {
          settleAnnouncedBackgroundTurn(threadId, "interrupted");
        }
      }
    }
    if (DESKTOP_FOLLOWER_REQUEST_METHODS.has(method)) {
      const route = buildDesktopFollowerRoute(message);
      if (route && isDesktopRoutableThread(route.threadId)) {
        submitDesktopFollowerRequest(route, message);
        return true;
      }
      if (route && shouldHoldFollowerRequest(message, route.threadId)) {
        holdFollowerRequest(route.threadId, rawMessage);
        probeDesktopOwnership(route);
        return true;
      }
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
      ownershipProbeDeadlinesByThreadId.set(threadId, now() + ownershipProbeTimeoutMs);
    }
    ipc.ensureConnected();
    return false;
  }

  function stopAll() {
    rawStatesByThreadId.clear();
    rawStateUpdatedAtByThreadId.clear();
    for (const threadId of pendingSnapshotsByThreadId.keys()) {
      cancelPendingSnapshot(threadId);
    }
    canonicalHistoryThreadIds.clear();
    canonicalHistoryReplacementSentThreadIds.clear();
    canonicalActiveTurnsByThreadId.clear();
    staleYieldedThreadIds.clear();
    conversationProjector.reset();
    pendingRoutesByRequestId.clear();
    activeThreads.clear();
    backgroundOnlyThreadIds.clear();
    announcedBackgroundTurnsByThreadId.clear();
    for (const timer of backgroundDisconnectTimersByThreadId.values()) {
      clearTimeout(timer);
    }
    backgroundDisconnectTimersByThreadId.clear();
    recoveringThreadIds.clear();
    baselineRecoveryStateByThreadId.clear();
    queuedChangesByThreadId.clear();
    liveOwnerThreadIds.clear();
    ownershipProbeDeadlinesByThreadId.clear();
    pendingOwnershipProbeTokensByThreadId.clear();
    desktopOwnedByProbeThreadIds.clear();
    for (const queue of heldFollowerRequestsByThreadId.values()) {
      for (const entry of queue) {
        clearTimeout(entry.timer);
      }
    }
    heldFollowerRequestsByThreadId.clear();
    ipc.close();
  }

  // Desktop broadcasts carry the live conversation state Litter projects from.
  function onEnvelope(envelope) {
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
      ownershipProbeDeadlinesByThreadId.delete(threadId);
      desktopOwnedByProbeThreadIds.delete(threadId);
    } else if (liveOwnerThreadIds.has(threadId) || isLocallyOwnedThread(threadId)) {
      // Desktop echoes of a locally-streamed thread must not become follower
      // state: they would shadow the app-server as the source for reads and
      // mirror ghost rows the phone already has.
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
          releaseHeldFollowerRequests(threadId, { toDesktop: true });
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

  function schedulePendingSnapshot(threadId, state) {
    cancelPendingSnapshot(threadId);
    const timer = setTimeout(() => {
      const pending = pendingSnapshotsByThreadId.get(threadId);
      if (!pending || pending.timer !== timer) {
        return;
      }
      pendingSnapshotsByThreadId.delete(threadId);
      commitConversationState(threadId, pending.state, {
        isFullSnapshot: true,
        isPatch: false,
      });
    }, Math.max(0, snapshotDebounceMs));
    timer.unref?.();
    pendingSnapshotsByThreadId.set(threadId, { state, timer });
  }

  function cancelPendingSnapshot(threadId) {
    const pending = pendingSnapshotsByThreadId.get(threadId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    pendingSnapshotsByThreadId.delete(threadId);
    return true;
  }

  function commitConversationState(threadId, nextState, {
    isFullSnapshot = false,
    isPatch = false,
  } = {}) {
    if (liveOwnerThreadIds.has(threadId) || isLocallyOwnedThread(threadId)) {
      return false;
    }

    rawStatesByThreadId.set(threadId, nextState);
    rawStateUpdatedAtByThreadId.set(threadId, now());
    // A usable state arrived: recovery bookkeeping and pre-baseline queued
    // patches are obsolete (snapshots replace state wholesale).
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
    releaseHeldFollowerRequests(threadId, { toDesktop: true });
    return true;
  }

  function onDisconnect() {
    // Patch baselines are connection-scoped (Desktop re-sends a snapshot after
    // reconnect), but the projector cache is not: keeping it lets the reconnect
    // snapshot diff against already-mirrored content instead of replaying it.
    rawStatesByThreadId.clear();
    rawStateUpdatedAtByThreadId.clear();
    canonicalHistoryReplacementSentThreadIds.clear();
    canonicalActiveTurnsByThreadId.clear();
    recoveringThreadIds.clear();
    baselineRecoveryStateByThreadId.clear();
    queuedChangesByThreadId.clear();
    pendingOwnershipProbeTokensByThreadId.clear();
    desktopOwnedByProbeThreadIds.clear();
    for (const threadId of announcedBackgroundTurnsByThreadId.keys()) {
      scheduleBackgroundDisconnectSettlement(threadId);
    }
    // Keep activeThreads: phone interest is phone-scoped, not connection-scoped.
    // Clearing it here would make reconnect snapshots for a thread the phone is
    // still viewing fail the activeThreads.has() guard until the phone happens
    // to issue a fresh read. Growth is bounded by the LRU cap instead.
    // Keep pending approval routes too: a transient disconnect proves nothing
    // about the prompt's outcome, and falsely resolving it would dismiss a
    // still-blocking approval on the phone. Reconnect snapshots reconcile them.
    // Keep held turns queued: a disconnect proves nothing about ownership. Their
    // hold timers route them through the bus (with a reconnect attempt), and only
    // a proven delivery failure falls back to the local app-server.
  }

  // The bridge's own live owner just claimed this thread's stream, so drop stale
  // Desktop state instead of hijacking future phone requests into Desktop IPC.
  function releaseDesktopThreadState(threadId) {
    settleAnnouncedBackgroundTurn(threadId, "interrupted");
    if (backgroundOnlyThreadIds.delete(threadId)) {
      activeThreads.delete(threadId);
    }
    liveOwnerThreadIds.add(threadId);
    ownershipProbeDeadlinesByThreadId.delete(threadId);
    pendingOwnershipProbeTokensByThreadId.delete(threadId);
    desktopOwnedByProbeThreadIds.delete(threadId);
    syncProjectedActions(threadId, []);
    rawStatesByThreadId.delete(threadId);
    rawStateUpdatedAtByThreadId.delete(threadId);
    cancelPendingSnapshot(threadId);
    canonicalHistoryThreadIds.delete(threadId);
    canonicalHistoryReplacementSentThreadIds.delete(threadId);
    canonicalActiveTurnsByThreadId.delete(threadId);
    staleYieldedThreadIds.delete(threadId);
    conversationProjector.remove(threadId);
    queuedChangesByThreadId.delete(threadId);
    baselineRecoveryStateByThreadId.delete(threadId);
    releaseHeldFollowerRequests(threadId, { toDesktop: false });
  }

  // The live owner is releasing/removing its stream, not claiming it; cancel any
  // speculative phone request instead of routing it to either runtime. Phone
  // interest (activeThreads) deliberately survives the release: if Desktop
  // picks the thread up next, its broadcasts must be processed immediately
  // instead of being dropped until the phone happens to issue another read.
  function removeDesktopThreadState(threadId) {
    settleAnnouncedBackgroundTurn(threadId, "interrupted");
    if (backgroundOnlyThreadIds.delete(threadId)) {
      activeThreads.delete(threadId);
    }
    liveOwnerThreadIds.delete(threadId);
    ownershipProbeDeadlinesByThreadId.delete(threadId);
    pendingOwnershipProbeTokensByThreadId.delete(threadId);
    desktopOwnedByProbeThreadIds.delete(threadId);
    syncProjectedActions(threadId, []);
    rawStatesByThreadId.delete(threadId);
    rawStateUpdatedAtByThreadId.delete(threadId);
    cancelPendingSnapshot(threadId);
    canonicalHistoryThreadIds.delete(threadId);
    canonicalHistoryReplacementSentThreadIds.delete(threadId);
    canonicalActiveTurnsByThreadId.delete(threadId);
    staleYieldedThreadIds.delete(threadId);
    conversationProjector.remove(threadId);
    queuedChangesByThreadId.delete(threadId);
    baselineRecoveryStateByThreadId.delete(threadId);
    rejectHeldFollowerRequests(threadId, "This thread is no longer available for Desktop routing.");
  }

  // A just-resumed Desktop-owned thread has no snapshot yet, so hold phone turn
  // requests briefly instead of racing them into the local app-server. Holding is
  // bounded to a short window after resume so purely local threads stay fast.
  function shouldHoldFollowerRequest(message, threadId) {
    if (typeof forwardToLocalCodex !== "function" || message?.id == null) {
      return false;
    }
    if (!threadId
      || !activeThreads.has(threadId)
      || rawStatesByThreadId.has(threadId)
      || liveOwnerThreadIds.has(threadId)
      || isLocallyOwnedThread(threadId)) {
      return false;
    }
    const probeDeadline = ownershipProbeDeadlinesByThreadId.get(threadId);
    if (!probeDeadline || now() > probeDeadline) {
      ownershipProbeDeadlinesByThreadId.delete(threadId);
      return false;
    }
    return true;
  }

  // Asks the IPC bus whether any client owns this thread so held requests resolve
  // as soon as possible instead of waiting out the full post-resume window.
  function probeDesktopOwnership(route) {
    const threadId = route.threadId;
    if (pendingOwnershipProbeTokensByThreadId.has(threadId)) {
      return;
    }
    const probeToken = ++nextOwnershipProbeToken;
    pendingOwnershipProbeTokensByThreadId.set(threadId, probeToken);
    ipc.sendDiscoveryRequest({
      type: "request",
      method: route.method,
      // Codex Desktop rejects discovery unless the nested request version matches
      // the method version, so mirror the normal request envelope here.
      version: METHOD_VERSION_BY_NAME.get(route.method) || 1,
      params: route.params,
    }, ownershipProbeTimeoutMs)
      .then((canHandle) => {
        if (pendingOwnershipProbeTokensByThreadId.get(threadId) !== probeToken) {
          return;
        }
        pendingOwnershipProbeTokensByThreadId.delete(threadId);
        if (liveOwnerThreadIds.has(threadId) || isLocallyOwnedThread(threadId)) {
          return;
        }
        if (canHandle === true) {
          desktopOwnedByProbeThreadIds.add(threadId);
          releaseHeldFollowerRequests(threadId, { toDesktop: true });
          return;
        }
        // A negative discovery answer only means no currently connected client
        // claimed the request. Keep holding so the bounded timer can route the
        // request through the bus and only fall back locally after no-client-found.
      });
  }

  // IPC may finish connecting after the first probe returned no answer; retry
  // still-held phone turns once the bus can actually discover peer owners.
  function probeHeldFollowerRequests() {
    for (const [threadId, queue] of heldFollowerRequestsByThreadId.entries()) {
      if (!queue || queue.length === 0 || liveOwnerThreadIds.has(threadId)) {
        continue;
      }
      const message = safeParseJSON(queue[0].rawMessage);
      const route = message ? buildDesktopFollowerRoute(message) : null;
      if (route && shouldHoldFollowerRequest(message, threadId)) {
        probeDesktopOwnership(route);
      }
    }
  }

  function isDesktopRoutableThread(threadId) {
    return !liveOwnerThreadIds.has(threadId)
      && !isLocallyOwnedThread(threadId)
      && (rawStatesByThreadId.has(threadId) || desktopOwnedByProbeThreadIds.has(threadId));
  }

  function holdFollowerRequest(threadId, rawMessage) {
    const probeDeadline = ownershipProbeDeadlinesByThreadId.get(threadId) || 0;
    const message = safeParseJSON(rawMessage);
    const method = readString(message?.method);
    const entry = {
      rawMessage,
      timer: setTimeout(() => {
        const queue = heldFollowerRequestsByThreadId.get(threadId) || [];
        const index = queue.indexOf(entry);
        if (index < 0) {
          return;
        }
        queue.splice(index, 1);
        if (queue.length === 0) {
          heldFollowerRequestsByThreadId.delete(threadId);
        }
        routeExpiredHeldRequestThroughBus(rawMessage);
      }, Math.max(0, probeDeadline - now())),
    };
    entry.timer.unref?.();
    const queue = heldFollowerRequestsByThreadId.get(threadId) || [];
    if (method === "turn/start") {
      rejectQueuedHeldTurnStarts(queue);
    }
    queue.push(entry);
    heldFollowerRequestsByThreadId.set(threadId, queue);
  }

  function rejectQueuedHeldTurnStarts(queue) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index];
      const message = safeParseJSON(entry.rawMessage);
      if (readString(message?.method) !== "turn/start") {
        continue;
      }
      queue.splice(index, 1);
      clearTimeout(entry.timer);
      rejectHeldFollowerRequest(message, "Superseded by a newer held turn/start request.");
    }
  }

  // Codex Desktop's real IPC router ignores client-origin discovery probes, so an
  // unanswered probe proves nothing. Route the expired request through the bus as
  // a normal request: the router discovers a Desktop owner itself, and a proven
  // no-handler error falls back to the local app-server via the delivery-failure
  // path instead of double-running the turn on both runtimes.
  function routeExpiredHeldRequestThroughBus(rawMessage) {
    const message = safeParseJSON(rawMessage);
    const route = message ? buildDesktopFollowerRoute(message) : null;
    if (route) {
      // The request is being routed definitively now, so a late discovery answer
      // must not retroactively mark the thread Desktop-owned.
      pendingOwnershipProbeTokensByThreadId.delete(route.threadId);
    }
    if (!route || liveOwnerThreadIds.has(route.threadId) || isLocallyOwnedThread(route.threadId)) {
      forwardToLocalCodex(rawMessage);
      return;
    }
    submitDesktopFollowerRequest(route, message);
  }

  function releaseHeldFollowerRequests(threadId, { toDesktop } = {}) {
    const queue = heldFollowerRequestsByThreadId.get(threadId);
    if (!queue || queue.length === 0) {
      heldFollowerRequestsByThreadId.delete(threadId);
      return;
    }

    heldFollowerRequestsByThreadId.delete(threadId);
    let releasedTurnStart = false;
    for (const entry of queue) {
      clearTimeout(entry.timer);
      const originalMessage = safeParseJSON(entry.rawMessage);
      if (readString(originalMessage?.method) === "turn/start") {
        if (releasedTurnStart) {
          rejectHeldFollowerRequest(originalMessage, "Superseded by another held turn/start request.");
          continue;
        }
        releasedTurnStart = true;
      }
      const message = toDesktop ? originalMessage : null;
      const route = message ? buildDesktopFollowerRoute(message) : null;
      if (route && isDesktopRoutableThread(route.threadId)) {
        submitDesktopFollowerRequest(route, message);
      } else {
        forwardToLocalCodex?.(entry.rawMessage);
      }
    }
  }

  function rejectHeldFollowerRequests(threadId, reason) {
    const queue = heldFollowerRequestsByThreadId.get(threadId);
    if (!queue || queue.length === 0) {
      heldFollowerRequestsByThreadId.delete(threadId);
      return;
    }
    heldFollowerRequestsByThreadId.delete(threadId);
    for (const entry of queue) {
      clearTimeout(entry.timer);
      rejectHeldFollowerRequest(safeParseJSON(entry.rawMessage), reason);
    }
  }

  function rejectHeldFollowerRequest(message, reason) {
    if (message?.id == null) {
      return;
    }
    sendApplicationResponse(JSON.stringify({
      id: message.id,
      error: {
        code: -32000,
        message: reason,
      },
    }));
  }

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

  // Serves Desktop-owned history/read requests from the cached IPC snapshot so
  // mobile can backfill threads that only exist in Codex Desktop.
  function tryServeDesktopOwnedRead(message) {
    const method = readString(message?.method);
    if (!DESKTOP_STATE_READ_METHODS.has(method) || message?.id == null) {
      return false;
    }
    const threadId = readThreadId(message.params);
    const ownsDesktopCursor = method === "thread/turns/list"
      && isDesktopTurnsCursor(message.params?.cursor);
    if (!threadId || liveOwnerThreadIds.has(threadId) || isLocallyOwnedThread(threadId)) {
      return ownsDesktopCursor ? rejectDesktopTurnsCursor(message) : false;
    }
    const rawState = rawStatesByThreadId.get(threadId);
    if (!rawState) {
      return ownsDesktopCursor ? rejectDesktopTurnsCursor(message) : false;
    }

    activeThreads.remember(threadId);
    if (method === "thread/goal/get") {
      sendApplicationResponse(JSON.stringify({
        id: message.id,
        result: { goal: projectDesktopConversationStateToGoal(threadId, rawState) },
      }));
      return true;
    }
    if (hasNormalizedHistoryOutsideRawTurns(rawState)) {
      canonicalHistoryThreadIds.add(threadId);
    }
    if (canonicalHistoryThreadIds.has(threadId)) {
      return ownsDesktopCursor ? rejectDesktopTurnsCursor(message) : false;
    }

    const thread = projectDesktopConversationStateToThread(threadId, rawState, { now });
    // A run that Desktop stopped streaming updates for is not a live run: serving
    // it from cache would answer thread-list refreshes with a phantom "running"
    // turn until real history loads. Let the local app-server answer instead.
    if (hasActiveProjectedTurn(thread)
      && isRawStateStaleForActiveRead(threadId)
      && !ownsDesktopCursor) {
      staleYieldedThreadIds.add(threadId);
      return false;
    }
    const result = method === "thread/turns/list"
      ? buildDesktopTurnsListResult(thread.turns, message.params)
      : {
          // The projected thread is the entire payload the phone decodes;
          // echoing the raw Desktop conversationState alongside it doubled
          // heavy threads past the relay frame limit for nothing.
          thread,
        };
    if (!result) {
      return ownsDesktopCursor ? rejectDesktopTurnsCursor(message) : false;
    }
    sendApplicationResponse(JSON.stringify({
      id: message.id,
      result,
    }));
    return true;
  }

  function rejectDesktopTurnsCursor(message) {
    sendApplicationResponse(JSON.stringify({
      id: message.id,
      error: {
        code: -32602,
        message: "Desktop history changed while paging. Reload this thread to restart history pagination.",
      },
    }));
    return true;
  }

  function hasActiveProjectedTurn(thread) {
    return (thread?.turns || []).some((turn) => turn?.status === "inProgress")
      || readString(thread?.status?.type) === "active";
  }

  function isRawStateStaleForActiveRead(threadId) {
    const updatedAt = rawStateUpdatedAtByThreadId.get(threadId) || 0;
    return now() - updatedAt > STALE_ACTIVE_READ_MAX_AGE_MS;
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
      conversationProjector.seed(threadId, liveState);
      sendApplicationResponse(JSON.stringify({
        method: "thread/replaced",
        params: {
          threadId,
          agntDesktopMirror: true,
          agntDesktopIpcMirror: true,
          agntActionSource: DESKTOP_IPC_ACTION_SOURCE,
        },
      }));
      syncCanonicalSnapshotLifecycle(threadId, liveState);
      return;
    }

    if (resumedAfterStaleYield) {
      // Switching back from rollout/app-server history to fresh Desktop state is
      // a source epoch change. Force a baseline repair instead of completing a
      // stale in-progress turn from the old cache.
      conversationProjector.remove(threadId);
    }
    const output = conversationProjector.project(threadId, liveState);
    if (resumedAfterStaleYield || output.type === "fullReplace" || output.type === "baseline") {
      // fullReplace: synthesized turn ids just became real, stale rows must go.
      // baseline: the projector cache was evicted, so updates that arrived while
      // unobserved were never mirrored. Both cases need the phone to rebuild the
      // thread from canonical history instead of trusting incremental rows.
      // The phone reacts to thread/replaced by re-reading canonical history;
      // it never decodes an embedded thread, and heavy threads would blow the
      // relay frame limit if we shipped one.
      sendApplicationResponse(JSON.stringify({
        method: "thread/replaced",
        params: {
          threadId,
          agntDesktopMirror: true,
          agntDesktopIpcMirror: true,
          agntActionSource: DESKTOP_IPC_ACTION_SOURCE,
        },
      }));
    }
    for (const notification of output.notifications || []) {
      sendApplicationResponse(JSON.stringify(notification));
    }
  }

  function syncCanonicalSnapshotLifecycle(threadId, liveState) {
    const previousTurns = canonicalActiveTurnsByThreadId.get(threadId) || new Map();
    const nextTurns = activeCanonicalTurnsById(liveState);

    for (const [turnId, previousTurn] of previousTurns.entries()) {
      if (nextTurns.has(turnId)) {
        continue;
      }
      const settledTurn = canonicalTurnById(liveState, turnId) || previousTurn;
      const settledStatus = readString(settledTurn?.status);
      sendApplicationResponse(JSON.stringify(backgroundTurnLifecycleNotification(
        "turn/completed",
        threadId,
        {
          ...settledTurn,
          id: turnId,
          status: settledStatus === "failed" || settledStatus === "interrupted"
            ? settledStatus
            : "completed",
        }
      )));
    }

    for (const [turnId, nextTurn] of nextTurns.entries()) {
      if (previousTurns.has(turnId)) {
        continue;
      }
      sendApplicationResponse(JSON.stringify(backgroundTurnLifecycleNotification(
        "turn/started",
        threadId,
        nextTurn
      )));
    }

    if (nextTurns.size > 0) {
      canonicalActiveTurnsByThreadId.set(threadId, nextTurns);
    } else {
      canonicalActiveTurnsByThreadId.delete(threadId);
    }
  }

  function rememberCanonicalActiveTurns(threadId, liveState) {
    const activeTurns = activeCanonicalTurnsById(liveState);
    if (activeTurns.size > 0) {
      canonicalActiveTurnsByThreadId.set(threadId, activeTurns);
    } else {
      canonicalActiveTurnsByThreadId.delete(threadId);
    }
  }

  function syncBackgroundThreadLifecycle(threadId, nextState) {
    const announcedTurn = announcedBackgroundTurnsByThreadId.get(threadId) || null;
    const previousTurnId = readString(announcedTurn?.id);
    const nextActiveTurn = latestActiveBackgroundTurn(nextState);
    const nextTurnId = readString(nextActiveTurn?.id);

    if (previousTurnId && previousTurnId !== nextTurnId) {
      const settledTurn = backgroundRawTurnById(nextState, previousTurnId) || announcedTurn;
      const settledStatus = readString(settledTurn?.status);
      settleAnnouncedBackgroundTurn(
        threadId,
        settledStatus === "failed" || settledStatus === "interrupted"
          ? settledStatus
          : "completed",
        settledTurn
      );
    }

    if (nextTurnId && nextTurnId !== previousTurnId) {
      sendApplicationResponse(JSON.stringify(backgroundTurnLifecycleNotification(
        "turn/started",
        threadId,
        nextActiveTurn
      )));
      announcedBackgroundTurnsByThreadId.set(threadId, nextActiveTurn);
      clearBackgroundDisconnectTimer(threadId);
    }
  }

  function settleAnnouncedBackgroundTurn(threadId, status = "interrupted", turn = null) {
    const announcedTurn = announcedBackgroundTurnsByThreadId.get(threadId);
    if (!announcedTurn) {
      clearBackgroundDisconnectTimer(threadId);
      return false;
    }
    const settledTurn = {
      ...announcedTurn,
      ...(turn && typeof turn === "object" ? turn : {}),
      id: announcedTurn.id,
      status,
    };
    sendApplicationResponse(JSON.stringify(backgroundTurnLifecycleNotification(
      "turn/completed",
      threadId,
      settledTurn
    )));
    announcedBackgroundTurnsByThreadId.delete(threadId);
    clearBackgroundDisconnectTimer(threadId);
    return true;
  }

  function scheduleBackgroundDisconnectSettlement(threadId) {
    if (!announcedBackgroundTurnsByThreadId.has(threadId)
      || backgroundDisconnectTimersByThreadId.has(threadId)) {
      return;
    }
    const expectedTurnId = announcedBackgroundTurnsByThreadId.get(threadId)?.id;
    const timer = setTimeout(() => {
      backgroundDisconnectTimersByThreadId.delete(threadId);
      if (announcedBackgroundTurnsByThreadId.get(threadId)?.id !== expectedTurnId) {
        return;
      }
      settleAnnouncedBackgroundTurn(threadId, "interrupted");
    }, Math.max(0, backgroundDisconnectGraceMs));
    timer.unref?.();
    backgroundDisconnectTimersByThreadId.set(threadId, timer);
  }

  function clearBackgroundDisconnectTimer(threadId) {
    const timer = backgroundDisconnectTimersByThreadId.get(threadId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    backgroundDisconnectTimersByThreadId.delete(threadId);
  }

  function syncThreadArchiveBroadcast(envelope) {
    const params = envelope.params || {};
    const threadId = readString(params.conversationId) || readString(params.conversation_id);
    if (!threadId) {
      return;
    }
    if (envelope.method === "thread-archived") {
      settleAnnouncedBackgroundTurn(threadId, "interrupted");
      if (backgroundOnlyThreadIds.delete(threadId)) {
        activeThreads.delete(threadId);
      }
      rawStatesByThreadId.delete(threadId);
      rawStateUpdatedAtByThreadId.delete(threadId);
      conversationProjector.remove(threadId);
      syncProjectedActions(threadId, []);
    }
    sendApplicationResponse(JSON.stringify({
      method: envelope.method === "thread-archived" ? "thread/archived" : "thread/unarchived",
      params: {
        threadId,
        conversationId: threadId,
        cwd: readString(params.cwd),
        agntDesktopMirror: true,
        agntDesktopIpcMirror: true,
        agntActionSource: DESKTOP_IPC_ACTION_SOURCE,
      },
    }));
  }

  function desktopRouteForResponse(message) {
    if (!message || typeof message !== "object" || message.method) {
      return null;
    }

    const requestId = requestIdKey(message.id);
    return requestId ? pendingRoutesByRequestId.get(requestId) || null : null;
  }

  function submitDesktopActionResponse(route, responseMessage) {
    const payload = desktopFollowerPayloadForResponse(route, responseMessage);
    if (!payload) {
      sendApplicationResponse(JSON.stringify({
        id: responseMessage?.id ?? route.requestId,
        error: {
          code: -32602,
          message: "Invalid desktop action response.",
        },
      }));
      return;
    }

    ipc.sendRequest(payload.method, payload.params)
      .then(() => {
        pendingRoutesByRequestId.delete(route.requestId);
        sendApplicationResponse(JSON.stringify(
          projectedResolvedNotification(route.threadId, route.requestId)
        ));
      })
      .catch((error) => {
        console.warn(`${logPrefix} desktop action reply failed for ${route.threadId}: ${error.message}`);
        sendApplicationResponse(JSON.stringify({
          id: responseMessage.id,
          error: {
            code: -32000,
            message: "Could not send this action to Codex on the Mac.",
          },
        }));
      });
  }

  function submitDesktopFollowerRequest(route, originalMessage) {
    Promise.resolve()
      .then(() => resolveFollowerRequestParams(route))
      .then(async (params) => {
        if (route.method === "thread-follower-start-turn") {
          await syncDesktopOwnerRuntimeSettings(route.threadId, params.turnStartParams)
            .catch((error) => { throw markDeliveryFailureError(error); });
        }
        return ipc.sendRequest(route.method, params);
      })
      .then((result) => {
        sendApplicationResponse(JSON.stringify({
          id: originalMessage.id,
          result: appServerResultForFollowerRequest(route.method, result),
        }));
      })
      .catch((error) => {
        console.warn(`${logPrefix} desktop follower request failed: ${error.message}`);
        // Only rerun the request locally when we know Desktop never received it.
        // Timeouts and explicit remote errors stay errors: the turn may already be
        // running on Desktop, and executing it again locally would duplicate it.
        if (typeof forwardToLocalCodex === "function" && isDeliveryFailureError(error)) {
          const threadId = readString(route.threadId) || readString(route.params?.conversationId);
          if (threadId) {
            releaseDesktopThreadState(threadId);
          }
          forwardToLocalCodex(JSON.stringify(originalMessage));
          return;
        }
        sendApplicationResponse(JSON.stringify({
          id: originalMessage.id,
          error: {
            code: -32000,
            message: "Could not continue this Codex Desktop-owned thread from the phone.",
          },
        }));
      });
  }

  async function syncDesktopOwnerRuntimeSettings(threadId, turnStartParams) {
    const params = turnStartParams && typeof turnStartParams === "object" ? turnStartParams : {};
    const collaborationMode = params.collaborationMode && typeof params.collaborationMode === "object"
      ? cloneJSON(params.collaborationMode) : null;
    const collaborationSettings = collaborationMode?.settings;
    const model = readString(params.model) || readString(collaborationSettings?.model);
    const effort = readString(params.effort) || readString(params.reasoningEffort)
      || readString(collaborationSettings?.reasoning_effort) || readString(collaborationSettings?.reasoningEffort);
    const serviceTier = readString(params.serviceTier) || readString(params.service_tier) || null;
    if (!model && !effort && !collaborationMode) return;
    await ipc.sendRequest("thread-follower-update-thread-settings", {
      conversationId: threadId,
      threadSettings: { ...(model ? { model } : {}), effort: effort || null, serviceTier,
        ...(collaborationMode ? { collaborationMode } : {}) }
    });
  }

  // Desktop-followed turn starts must apply the same param normalization as
  // requests forwarded straight to the local app-server.
  async function resolveFollowerRequestParams(route) {
    if (route.method !== "thread-follower-start-turn") {
      return route.params;
    }

    const normalized = await Promise.resolve(
      normalizeTurnStartParams(cloneJSON(route.params.turnStartParams))
    );
    const turnStartParams = normalized && typeof normalized === "object" && !Array.isArray(normalized)
      ? normalized
      : route.params.turnStartParams;
    return {
      ...route.params,
      turnStartParams,
    };
  }

  function queueThreadChange(threadId, change) {
    if (!change || typeof change !== "object") {
      return;
    }

    const queuedChanges = queuedChangesByThreadId.get(threadId) || [];
    queuedChanges.push(change);
    // Patches without a baseline are useless beyond a bound; keep the tail so
    // memory stays flat while recovery waits for the thread to materialize.
    if (queuedChanges.length > MAX_QUEUED_CHANGES_PER_THREAD) {
      queuedChanges.splice(0, queuedChanges.length - MAX_QUEUED_CHANGES_PER_THREAD);
    }
    queuedChangesByThreadId.set(threadId, queuedChanges);
  }

  function recoverThreadBaseline(threadId) {
    if (recoveringThreadIds.has(threadId)
      || (rawStatesByThreadId.has(threadId) && !backgroundOnlyThreadIds.has(threadId))) {
      return;
    }
    const recoveryState = baselineRecoveryStateByThreadId.get(threadId) || {
      attempts: 0,
      nextAttemptAt: 0,
    };
    if (recoveryState.attempts >= MAX_BASELINE_RECOVERY_ATTEMPTS) {
      // Give up until a snapshot arrives; a fresh snapshot resets this state.
      return;
    }
    if (now() < recoveryState.nextAttemptAt) {
      return;
    }
    recoveryState.attempts += 1;
    recoveryState.nextAttemptAt = now() + Math.min(
      BASELINE_RECOVERY_MAX_DELAY_MS,
      BASELINE_RECOVERY_BASE_DELAY_MS * (2 ** (recoveryState.attempts - 1))
    );
    baselineRecoveryStateByThreadId.set(threadId, recoveryState);

    recoveringThreadIds.add(threadId);
    Promise.resolve()
      .then(() => readConversationState(threadId))
      .then((baselineState) => {
        if (!baselineState || typeof baselineState !== "object") {
          return;
        }

        baselineRecoveryStateByThreadId.delete(threadId);
        recoverThreadBaselineFromQueuedChanges(threadId, baselineState);
      })
      .catch((error) => {
        if (recoveryState.attempts === 1
          || recoveryState.attempts === MAX_BASELINE_RECOVERY_ATTEMPTS) {
          console.warn(`${logPrefix} desktop IPC baseline recovery failed for ${threadId} (attempt ${recoveryState.attempts}/${MAX_BASELINE_RECOVERY_ATTEMPTS}): ${error.message}`);
        }
        // Keep queued changes: a later attempt or snapshot may still recover.
      })
      .finally(() => {
        recoveringThreadIds.delete(threadId);
      });
  }

  function recoverThreadBaselineFromQueuedChanges(threadId, baselineState) {
    const queuedChanges = queuedChangesByThreadId.get(threadId) || [];
    if (queuedChanges.length === 0) {
      return;
    }

    queuedChangesByThreadId.delete(threadId);
    let nextState = baselineState && typeof baselineState === "object"
      ? cloneJSON(baselineState)
      : createEmptyConversationState();
    for (const change of queuedChanges) {
      nextState = applyConversationStateChange(nextState, change) || nextState;
    }

    rawStatesByThreadId.set(threadId, nextState);
    rawStateUpdatedAtByThreadId.set(threadId, now());
    if (baselineState && typeof baselineState === "object" && !backgroundOnlyThreadIds.has(threadId)) {
      conversationProjector.seed(threadId, desktopLiveStateForProjection(baselineState));
    }
    if (backgroundOnlyThreadIds.has(threadId)) {
      syncBackgroundThreadLifecycle(threadId, nextState);
    } else {
      syncProjectedConversationState(threadId, nextState);
    }
    syncProjectedActions(threadId, projectPendingDesktopActions(threadId, nextState));
    releaseHeldFollowerRequests(threadId, { toDesktop: true });
  }

  return {
    observeInbound,
    stopAll,
    // True while this thread has live Desktop-owned IPC state mirrored to the
    // phone; used to keep fallback mirrors (rollout tail) silent.
    hasLiveThreadState(threadId) {
      return rawStatesByThreadId.has(readString(threadId));
    },
    // Fresh = Desktop broadcast within the stale window. A cache Desktop went
    // silent on may hide a stalled stream; fallback mirrors must not stay muted
    // behind it, or a reopened running thread freezes as "finished" until the
    // next broadcast happens to arrive.
    hasFreshLiveThreadState(threadId) {
      const id = readString(threadId);
      if (!rawStatesByThreadId.has(id)) {
        return false;
      }
      return now() - (rawStateUpdatedAtByThreadId.get(id) || 0) <= STALE_ACTIVE_READ_MAX_AGE_MS;
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
