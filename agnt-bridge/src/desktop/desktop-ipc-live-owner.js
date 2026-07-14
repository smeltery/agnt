const net = require("net");

const {
  cloneJSON,
  normalizeToken,
  readString,
  resolveDefaultIpcSocketPath,
  safeParseJSON,
} = require("./desktop-ipc-shared");
const {
  LOCAL_HOST_ID,
  applyAppServerMessageToConversationState,
  buildConversationStateFromThread,
  readThreadIdFromParams,
} = require("./desktop-ipc-conversation-adapter");
const {
  DEFAULT_MAX_PATCH_BYTES,
  DEFAULT_MAX_PATCH_COUNT,
  buildConversationStatePatches,
} = require("./desktop-ipc-state-patches");
const {
  createDesktopOwnerIpcClient,
} = require("./desktop-ipc-owner-transport");
const {
  createFollowerRuntimeState,
} = require("./desktop-ipc-live-owner-runtime");
const {
  createLiveOwnerListMetadataState,
} = require("./desktop-ipc-live-owner-list-metadata");
const {
  createDisabledDesktopIpcLiveOwner,
} = require("./desktop-ipc-live-owner-support");
const {
  readThreadFromResponse,
} = require("./desktop-ipc-live-owner-utils");
const {
  createPendingTurnStartState,
} = require("./desktop-ipc-live-owner-pending-turns");
const {
  createLiveOwnerFollowerRequestHandler,
} = require("./live-owner/follower-requests");
const {
  createInitialHistoryState,
} = require("./live-owner/initial-history");
const {
  createLiveOwnerSnapshotState,
} = require("./live-owner/snapshots");
const {
  createOwnedThreadState,
} = require("./live-owner/owned-threads");
const {
  createLiveOwnerThreadState,
} = require("./live-owner/thread-state");
const {
  createLiveOwnerLifecycle,
} = require("./live-owner/lifecycle");
const {
  createLiveOwnerInboundObserver,
} = require("./live-owner/inbound");

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_MS = 1_500;
const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 75;
const DEFAULT_INITIAL_HISTORY_RETRY_MS = 1_000;
const DEFAULT_INITIAL_HISTORY_MAX_ATTEMPTS = 5;
const DEFAULT_SIDEBAR_REFRESH_DELAY_MS = 1_200;
const MAX_CACHED_THREADS = 30;

function createDesktopIpcLiveOwner({
  enabled = true,
  hostId = LOCAL_HOST_ID,
  sendApplicationResponse = null,
  sendCodexRequest,
  sendRawCodexMessage,
  normalizeTurnStartParams = (params) => params,
  socketPath = resolveDefaultIpcSocketPath(),
  sidebarRefreshDelayMs = DEFAULT_SIDEBAR_REFRESH_DELAY_MS,
  snapshotDebounceMs = DEFAULT_SNAPSHOT_DEBOUNCE_MS,
  maxPatchCount = DEFAULT_MAX_PATCH_COUNT,
  maxPatchBytes = DEFAULT_MAX_PATCH_BYTES,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  reconnectMs = DEFAULT_RECONNECT_MS,
  initialHistoryRetryMs = DEFAULT_INITIAL_HISTORY_RETRY_MS,
  initialHistoryMaxAttempts = DEFAULT_INITIAL_HISTORY_MAX_ATTEMPTS,
  runtimeSettingsStore = null,
  netModule = net,
  now = () => Date.now(),
  logPrefix = "[agnt]",
} = {}) {
  if (!enabled || typeof sendCodexRequest !== "function" || typeof sendRawCodexMessage !== "function") {
    return createDisabledDesktopIpcLiveOwner();
  }
  const sendPhoneNotification = typeof sendApplicationResponse === "function"
    ? sendApplicationResponse
    : () => {};

  const conversations = new Map();
  const ownedThreadIds = new Set();
  const pendingThreadStartRequestIds = new Map();
  const pendingThreadReadRequestIds = new Set();
  const pendingThreadHydrationsByThreadId = new Map();
  const threadsAwaitingInitialHistoryByThreadId = new Set();
  const initialHistoryRetryAfterByThreadId = new Map();
  const initialHistoryRetryTimersByThreadId = new Map();
  const initialHistoryAttemptCountByThreadId = new Map();
  const cachedThreadsByThreadId = new Map();
  const lastBroadcastStatesByThreadId = new Map();
  const fallbackTurnIdsByThreadId = new Map();
  const streamRevisionsByThreadId = new Map();
  const pendingTurnStartParamsByThreadId = new Map();
  const pendingTurnStartEntriesByRequestId = new Map();
  const followerRuntimeOverridesByThreadId = new Map();
  const queuedFollowUpsByThreadId = new Map();
  const runningQueuedFollowUpThreadIds = new Set();
  const announcedReadStateThreadIds = new Set();
  const dirtyThreadIds = new Set();
  let snapshotState = null;
  let ownedThreadState = null;
  let threadState = null;
  let lifecycleState = null;
  let inboundObserver = null;
  const listMetadataRef = { current: null };
  const followerRequestsRef = { current: null };
  threadState = createLiveOwnerThreadState({
    announcedReadStateThreadIds,
    cachedThreadsByThreadId,
    conversations,
    hostId,
    ipc: {
      ensureConnected() {
        return ipc.ensureConnected();
      },
      sendBroadcast(...args) {
        return ipc.sendBroadcast(...args);
      },
    },
    markOwnedThread,
    now,
    ownedThreadIds,
    pendingThreadStartRequestIds,
    runtimeSettingsStore,
    scheduleSnapshot,
    stopAwaitingInitialHistory,
  });
  const pendingTurnStarts = createPendingTurnStartState({
    conversations,
    pendingTurnStartParamsByThreadId,
    pendingTurnStartEntriesByRequestId,
    fallbackTurnIdsByThreadId,
    threadsAwaitingInitialHistoryByThreadId,
    ensureConversation,
    removeOwnedThread,
    scheduleSnapshot,
    now,
  });

  const ipc = createDesktopOwnerIpcClient({
    socketPath,
    netModule,
    now,
    requestTimeoutMs,
    reconnectMs,
    logPrefix,
    onConnected() {
      listMetadata.flushPendingThreadArchiveMetadataBroadcasts();
      broadcastAllOwnedSnapshots();
    },
    onBroadcast(envelope) {
      handlePeerBroadcast(envelope);
    },
    canHandleRequest(envelope) {
      return canHandleFollowerRequest(envelope);
    },
    handleRequest(envelope) {
      return handleFollowerRequest(envelope);
    },
  });
  const followerRuntimeState = createFollowerRuntimeState({
    conversations,
    followerRuntimeOverridesByThreadId,
    runtimeSettingsStore,
    scheduleSnapshot,
    logPrefix,
  });
  const listMetadata = createLiveOwnerListMetadataState({
    conversations,
    hostId,
    ipc,
    lastBroadcastStatesByThreadId,
    ownedThreadIds,
    removeOwnedThread,
    sidebarRefreshDelayMs,
  });
  listMetadataRef.current = listMetadata;
  snapshotState = createLiveOwnerSnapshotState({
    conversations,
    dirtyThreadIds,
    hostId,
    ipc,
    lastBroadcastStatesByThreadId,
    maxPatchBytes,
    maxPatchCount,
    ownedThreadIds,
    runtimeSettingsStore,
    shouldDelayInitialSnapshotForHistory,
    snapshotDebounceMs,
    streamRevisionsByThreadId,
  });
  const initialHistory = createInitialHistoryState({
    cachedThreadsByThreadId,
    conversations,
    defaultMaxAttempts: DEFAULT_INITIAL_HISTORY_MAX_ATTEMPTS,
    defaultRetryMs: DEFAULT_INITIAL_HISTORY_RETRY_MS,
    dirtyThreadIds,
    initialHistoryAttemptCountByThreadId,
    initialHistoryMaxAttempts,
    initialHistoryRetryAfterByThreadId,
    initialHistoryRetryMs,
    initialHistoryRetryTimersByThreadId,
    logPrefix,
    maxCachedThreads: MAX_CACHED_THREADS,
    now,
    ownedThreadIds,
    pendingThreadHydrationsByThreadId,
    scheduleSnapshot,
    sendCodexRequest,
    threadsAwaitingInitialHistoryByThreadId,
    upsertConversationFromThread,
  });
  const followerRequests = createLiveOwnerFollowerRequestHandler({
    conversations,
    followerRuntimeState,
    ipc,
    logPrefix,
    normalizeTurnStartParams,
    now,
    ownedThreadIds,
    pendingTurnStarts,
    queuedFollowUpsByThreadId,
    rememberCachedThread: initialHistory.rememberCachedThread,
    runningQueuedFollowUpThreadIds,
    scheduleSnapshot,
    sendCodexRequest,
    sendPhoneNotification,
    sendRawCodexMessage,
    streamRevisionsByThreadId,
    upsertConversationFromThread,
    markOwnedThread,
    broadcastConversationState,
  });
  followerRequestsRef.current = followerRequests;
  ownedThreadState = createOwnedThreadState({
    announcedReadStateThreadIds,
    cachedThreadsByThreadId,
    conversations,
    dirtyThreadIds,
    fallbackTurnIdsByThreadId,
    followerRequestsRef,
    followerRuntimeOverridesByThreadId,
    hostId,
    ipc,
    lastBroadcastStatesByThreadId,
    listMetadataRef,
    now,
    ownedThreadIds,
    pendingThreadHydrationsByThreadId,
    pendingTurnStarts,
    queuedFollowUpsByThreadId,
    runningQueuedFollowUpThreadIds,
    stopAwaitingInitialHistory,
    streamRevisionsByThreadId,
  });
  lifecycleState = createLiveOwnerLifecycle({
    announcedReadStateThreadIds,
    cachedThreadsByThreadId,
    conversations,
    dirtyThreadIds,
    fallbackTurnIdsByThreadId,
    followerRequests,
    followerRuntimeOverridesByThreadId,
    initialHistoryAttemptCountByThreadId,
    initialHistoryRetryAfterByThreadId,
    initialHistoryRetryTimersByThreadId,
    ipc,
    lastBroadcastStatesByThreadId,
    listMetadata,
    ownedThreadIds,
    pendingThreadHydrationsByThreadId,
    pendingThreadReadRequestIds,
    pendingThreadStartRequestIds,
    pendingTurnStarts,
    queuedFollowUpsByThreadId,
    removeOwnedThread,
    runningQueuedFollowUpThreadIds,
    snapshotState,
    streamRevisionsByThreadId,
    threadsAwaitingInitialHistoryByThreadId,
  });
  inboundObserver = createLiveOwnerInboundObserver({
    cachedThreadsByThreadId,
    conversations,
    followerRequests,
    initialHistory,
    ipc,
    listMetadata,
    markOwnedThread,
    markThreadReadByPhone,
    markTurnInterruptedOptimistically,
    ownedThreadIds,
    pendingThreadReadRequestIds,
    pendingThreadStartRequestIds,
    pendingTurnStarts,
    removeOwnedThread,
    scheduleSnapshot,
    seedOwnedConversation,
    threadsAwaitingInitialHistoryByThreadId,
  });

  function observeInbound(rawMessage, parsedMessage = null) {
    const message = parsedMessage ?? safeParseJSON(rawMessage);
    inboundObserver.observeInbound(message);
  }

  function observeOutbound(rawMessage, parsedMessage = null) {
    const message = parsedMessage ?? safeParseJSON(rawMessage);
    if (!message || typeof message !== "object") {
      return;
    }

    const responseId = message.id == null ? "" : String(message.id);
    if (responseId && !message.method) {
      pendingTurnStarts.resolveResponse(responseId, message);
    }
    if (responseId && pendingThreadReadRequestIds.has(responseId)) {
      pendingThreadReadRequestIds.delete(responseId);
      const thread = readThreadFromResponse(message);
      if (thread?.id) {
        initialHistory.rememberCachedThread(thread.id, thread);
        if (ownedThreadIds.has(thread.id)) {
          upsertConversationFromThread(thread);
          scheduleSnapshot(thread.id);
        }
      }
    }

    if (responseId && pendingThreadStartRequestIds.has(responseId)) {
      pendingThreadStartRequestIds.delete(responseId);
      const thread = readThreadFromResponse(message);
      if (thread?.id) {
        markOwnedThread(thread.id);
        upsertConversationFromThread(thread);
        scheduleSnapshot(thread.id);
      }
    }
    claimStartedThreadForPendingLocalStart(message);

    const update = applyAppServerMessageToConversationState({
      conversations,
      fallbackTurnIdsByThreadId,
      pendingTurnStartParamsByThreadId,
      message,
      hostId,
      now,
      shouldOwnThread(threadId) {
        return ownedThreadIds.has(threadId);
      },
    });

    if (update?.threadId && update.changed) {
      if (readString(message.method) === "thread/started") {
        stopAwaitingInitialHistory(update.threadId);
      }
      pendingTurnStarts.refreshFallback(update.threadId);
      scheduleSnapshot(update.threadId);
    }

    if (readString(message.method) === "turn/completed") {
      const completedThreadId = readThreadIdFromParams(message.params);
      const completedStatus = normalizeToken(message.params?.turn?.status);
      if (completedThreadId
        && ownedThreadIds.has(completedThreadId)
        && completedStatus !== "interrupted"
        && completedStatus !== "cancelled"
        && completedStatus !== "canceled") {
        followerRequests.runNextQueuedFollowUp(completedThreadId);
      }
    }
  }

  function stopAll() {
    lifecycleState.stopAll();
  }

  function markThreadReadByPhone(threadId) {
    threadState.markThreadReadByPhone(threadId);
  }

  function markTurnInterruptedOptimistically(threadId, params) {
    threadState.markTurnInterruptedOptimistically(threadId, params);
  }

  function markOwnedThread(threadId) {
    ownedThreadState.markOwnedThread(threadId);
  }

  function claimStartedThreadForPendingLocalStart(message) {
    threadState.claimStartedThreadForPendingLocalStart(message);
  }

  function removeOwnedThread(threadId, { broadcastRemoval = false, reason = "", skipArchiveMetadataBroadcast = false } = {}) {
    ownedThreadState.removeOwnedThread(threadId, {
      broadcastRemoval,
      reason,
      skipArchiveMetadataBroadcast,
    });
  }

  function upsertConversationFromThread(thread) {
    return threadState.upsertConversationFromThread(thread);
  }

  function ensureConversation(threadId, seed = {}) {
    return threadState.ensureConversation(threadId, seed);
  }

  function seedOwnedConversation(threadId, seed = {}) {
    return threadState.seedOwnedConversation(threadId, seed);
  }

  function scheduleSnapshot(threadId) {
    snapshotState.scheduleSnapshot(readString(threadId));
  }

  function shouldDelayInitialSnapshotForHistory(threadId) {
    const normalizedThreadId = readString(threadId);
    return initialHistory.shouldDelayInitialSnapshotForHistory(normalizedThreadId, {
      hasLastBroadcastState: lastBroadcastStatesByThreadId.has(normalizedThreadId),
      removeOwnedThread,
    });
  }

  function stopAwaitingInitialHistory(threadId) {
    initialHistory.stopAwaitingInitialHistory(threadId);
  }

  function broadcastAllOwnedSnapshots() {
    snapshotState.broadcastAllOwnedSnapshots();
  }

  function broadcastConversationState(threadId, { forceSnapshot = false } = {}) {
    return snapshotState.broadcastConversationState(threadId, { forceSnapshot });
  }

  function handlePeerBroadcast(envelope) {
    lifecycleState.handlePeerBroadcast(envelope);
  }

  function canHandleFollowerRequest(envelope) {
    return followerRequests.canHandleFollowerRequest(envelope);
  }

  async function handleFollowerRequest(envelope) {
    return await followerRequests.handleFollowerRequest(envelope);
  }

  return {
    observeInbound,
    observeOutbound,
    stopAll,
    isThreadOwned(threadId) {
      return ownedThreadIds.has(readString(threadId));
    },
    _debugSnapshot(threadId) {
      return cloneJSON(conversations.get(threadId) || null);
    },
  };
}

module.exports = {
  applyAppServerMessageToConversationState,
  buildConversationStatePatches,
  buildConversationStateFromThread,
  createDesktopIpcLiveOwner,
  resolveDefaultIpcSocketPath,
};
