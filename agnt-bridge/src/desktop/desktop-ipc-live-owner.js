// FILE: desktop-ipc-live-owner.js
// Purpose: Exposes bridge-owned Codex app-server streams to Codex Desktop/VSCode over the local IPC bus.
// Layer: CLI helper
// Exports: createDesktopIpcLiveOwner (plus adapter/patch re-exports for compatibility)
// Depends on: net, ./desktop-ipc-conversation-adapter, ./desktop-ipc-owner-transport, ./desktop-ipc-state-patches, ./desktop-ipc-shared

const net = require("net");

const {
  CLIENT_STATUS_CHANGED,
  DESKTOP_IPC_METHOD_VERSIONS: METHOD_VERSION_BY_NAME,
  cloneJSON,
  conversationSnapshotShowsActiveTurn,
  normalizeToken,
  readString,
  resolveDefaultIpcSocketPath,
  safeParseJSON,
} = require("./desktop-ipc-shared");
const {
  LOCAL_HOST_ID,
  applyAppServerMessageToConversationState,
  buildConversationStateFromThread,
  createEmptyConversationState,
  readThreadIdFromParams,
} = require("./desktop-ipc-conversation-adapter");
const {
  DEFAULT_MAX_PATCH_BYTES,
  DEFAULT_MAX_PATCH_COUNT,
  applyPatchesToBaselineState,
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
  AGNT_LIVE_OWNER_SOURCE,
  OWNER_INBOUND_METHODS,
  THREAD_READ_METHODS,
  THREAD_READ_STATE_CHANGED,
  THREAD_STREAM_STATE_CHANGED,
  createDisabledDesktopIpcLiveOwner,
  isPeerOwnershipBroadcast,
} = require("./desktop-ipc-live-owner-support");
const {
  readThreadFromPayload,
  readThreadFromResponse,
} = require("./desktop-ipc-live-owner-utils");
const {
  createPendingTurnStartState,
} = require("./desktop-ipc-live-owner-pending-turns");
const {
  createLiveOwnerFollowerRequestHandler,
} = require("./desktop-ipc-live-owner-follower-requests");

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_MS = 1_500;
const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 75;
const DEFAULT_INITIAL_HISTORY_RETRY_MS = 1_000;
const DEFAULT_INITIAL_HISTORY_MAX_ATTEMPTS = 5;
// Desktop's webview refreshes its recent-conversations list when it receives a
// thread-unarchived broadcast for its host. Give the rollout writer a moment to
// persist session_meta + the first user event so the refreshed thread/list scan
// can actually see the thread.
const DEFAULT_SIDEBAR_REFRESH_DELAY_MS = 1_200;
// Cached thread/read responses are only a hydration convenience; owned threads
// are never evicted, so a small cap keeps long browsing sessions bounded.
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
  // Pending local thread/start requests in FIFO order, keyed by request id with
  // the requested cwd so notification-only thread/started events pair correctly.
  const pendingThreadStartRequestIds = new Map();
  const pendingThreadReadRequestIds = new Set();
  const pendingThreadHydrationsByThreadId = new Map();
  // Unknown existing threads need a real history baseline before the first
  // Desktop snapshot; any seeded partial state can replace all desktop rows.
  const threadsAwaitingInitialHistoryByThreadId = new Set();
  const initialHistoryRetryAfterByThreadId = new Map();
  const initialHistoryRetryTimersByThreadId = new Map();
  const initialHistoryAttemptCountByThreadId = new Map();
  const cachedThreadsByThreadId = new Map();
  const lastBroadcastStatesByThreadId = new Map();
  const fallbackTurnIdsByThreadId = new Map();
  // Desktop followers track monotonic stream revisions: patches apply only when
  // baseRevision matches their last-seen revision, and load-complete-history
  // waits for the snapshot carrying the returned revision.
  const streamRevisionsByThreadId = new Map();
  const pendingTurnStartParamsByThreadId = new Map();
  const pendingTurnStartEntriesByRequestId = new Map();
  const followerRuntimeOverridesByThreadId = new Map();
  // Desktop delegates queued follow-ups to the stream owner: followers push the
  // whole queue state here and expect the owner to run entries between turns.
  const queuedFollowUpsByThreadId = new Map();
  const runningQueuedFollowUpThreadIds = new Set();
  const announcedReadStateThreadIds = new Set();
  const dirtyThreadIds = new Set();
  let snapshotTimer = null;
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
    rememberCachedThread,
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

  function observeInbound(rawMessage, parsedMessage = null) {
    const message = parsedMessage ?? safeParseJSON(rawMessage);
    const method = readString(message?.method);
    if (THREAD_READ_METHODS.has(method)) {
      if (message?.id != null) {
        pendingThreadReadRequestIds.add(String(message.id));
      }
      markThreadReadByPhone(readThreadIdFromParams(message?.params));
      return;
    }

    if (!method || !OWNER_INBOUND_METHODS.has(method)) {
      return;
    }

    if (method === "thread/start") {
      if (message?.id != null) {
        pendingThreadStartRequestIds.set(String(message.id), readString(message?.params?.cwd));
      }
      ipc.ensureConnected();
      return;
    }

    const threadId = readThreadIdFromParams(message?.params);
    if (!threadId) {
      return;
    }

    if (method === "thread/archive") {
      listMetadata.broadcastThreadArchived(threadId, listMetadata.readArchiveCwd(threadId, message?.params));
      removeOwnedThread(threadId, {
        broadcastRemoval: true,
        reason: method,
        skipArchiveMetadataBroadcast: true,
      });
      return;
    }
    if (method === "thread/unsubscribe") {
      // The phone leaving the screen releases idle threads, but a thread whose
      // local turn is still executing stays owned: dropping it mid-run lets
      // fallback mirrors and Desktop routing corrupt the timeline on reopen.
      if (!followerRequests.hasActiveLocalTurn(threadId)) {
        removeOwnedThread(threadId, { broadcastRemoval: true, reason: method });
      }
      return;
    }
    if (method === "thread/unarchive") {
      listMetadata.broadcastThreadUnarchived(threadId);
      return;
    }

    const hadConversation = conversations.has(threadId);
    const hadCachedThread = cachedThreadsByThreadId.has(threadId);
    markOwnedThread(threadId);
    if (!hadConversation && !hadCachedThread) {
      threadsAwaitingInitialHistoryByThreadId.add(threadId);
    }
    let pendingTurnStartEntry = null;
    if (method === "turn/start") {
      pendingTurnStartEntry = pendingTurnStarts.remember(threadId, message?.params, message?.id);
      listMetadata.scheduleSidebarAnnouncement(threadId);
    }
    if (method === "turn/interrupt") {
      markTurnInterruptedOptimistically(threadId, message?.params);
    }
    seedOwnedConversation(threadId, {
      cwd: readString(message?.params?.cwd),
    });
    if (pendingTurnStartEntry) {
      pendingTurnStarts.insertOptimistic(threadId, pendingTurnStartEntry);
    }
    if (!hadConversation && !hadCachedThread) {
      requestInitialHistoryBaselineIfDue(threadId);
    }
    scheduleSnapshot(threadId);
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
        rememberCachedThread(thread.id, thread);
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
      // Mirror Desktop's pause-after-interrupt semantics: a stopped turn means
      // the user wants things halted, so queued follow-ups wait for the next
      // explicit trigger (queue edit or a normally completed turn).
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
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    dirtyThreadIds.clear();
    pendingThreadStartRequestIds.clear();
    pendingThreadReadRequestIds.clear();
    pendingThreadHydrationsByThreadId.clear();
    threadsAwaitingInitialHistoryByThreadId.clear();
    initialHistoryRetryAfterByThreadId.clear();
    initialHistoryAttemptCountByThreadId.clear();
    for (const timer of initialHistoryRetryTimersByThreadId.values()) {
      clearTimeout(timer);
    }
    initialHistoryRetryTimersByThreadId.clear();
    cachedThreadsByThreadId.clear();
    lastBroadcastStatesByThreadId.clear();
    fallbackTurnIdsByThreadId.clear();
    streamRevisionsByThreadId.clear();
    listMetadata.clearAll();
    pendingTurnStarts.clear();
    followerRuntimeOverridesByThreadId.clear();
    queuedFollowUpsByThreadId.clear();
    runningQueuedFollowUpThreadIds.clear();
    announcedReadStateThreadIds.clear();
    ownedThreadIds.clear();
    conversations.clear();
    ipc.close();
  }

  // Desktop's sidebar tracks unread markers via thread-read-state-changed; tell
  // it when the phone opens an owned thread so badges clear on both devices.
  // Repeated reads of an already-clean thread stay silent to avoid IPC noise.
  function markThreadReadByPhone(threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId || !ownedThreadIds.has(normalizedThreadId)) {
      return;
    }
    const conversation = conversations.get(normalizedThreadId);
    const hadUnread = Boolean(conversation
      && (conversation.hasUnreadTurn || conversation.unreadMessageCount > 0));
    if (hadUnread) {
      conversation.hasUnreadTurn = false;
      conversation.unreadMessageCount = 0;
      scheduleSnapshot(normalizedThreadId);
    } else if (announcedReadStateThreadIds.has(normalizedThreadId)) {
      return;
    }
    if (ipc.sendBroadcast(THREAD_READ_STATE_CHANGED, {
      conversationId: normalizedThreadId,
      hasUnreadTurn: false,
    })) {
      announcedReadStateThreadIds.add(normalizedThreadId);
    }
  }

  // Snappier Stop UX on Desktop: flip the active turn to interrupted right away;
  // authoritative app-server events overwrite this if the interrupt fails.
  function markTurnInterruptedOptimistically(threadId, params) {
    const conversation = conversations.get(readString(threadId));
    if (!conversation) {
      return;
    }
    const requestedTurnId = readString(params?.turnId) || readString(params?.turn_id);
    for (let index = conversation.turns.length - 1; index >= 0; index -= 1) {
      const turn = conversation.turns[index];
      const turnId = readString(turn?.turnId) || readString(turn?.id);
      const matchesRequest = requestedTurnId ? turnId === requestedTurnId : true;
      if (matchesRequest && normalizeToken(turn?.status) === "inprogress") {
        turn.status = "interrupted";
        conversation.threadRuntimeStatus = { type: "idle" };
        conversation.updatedAt = now();
        return;
      }
      if (requestedTurnId && turnId === requestedTurnId) {
        return;
      }
    }
  }

  function markOwnedThread(threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId) {
      return;
    }
    ownedThreadIds.add(normalizedThreadId);
    ipc.ensureConnected();
  }

  // Notification-only thread/start paths do not echo a request id, so consume the
  // oldest pending local start whose cwd matches the started thread. Requiring a
  // cwd match keeps overlapping starts from claiming threads created elsewhere.
  function claimStartedThreadForPendingLocalStart(message) {
    if (readString(message?.method) !== "thread/started" || pendingThreadStartRequestIds.size === 0) {
      return;
    }
    const thread = message?.params?.thread;
    const threadId = readString(thread?.id);
    if (!threadId || ownedThreadIds.has(threadId)) {
      return;
    }
    const threadCwd = readString(thread?.cwd);
    for (const [pendingRequestId, pendingCwd] of pendingThreadStartRequestIds) {
      if (pendingCwd && threadCwd && pendingCwd !== threadCwd) {
        continue;
      }
      pendingThreadStartRequestIds.delete(pendingRequestId);
      markOwnedThread(threadId);
      return;
    }
  }

  function removeOwnedThread(threadId, { broadcastRemoval = false, reason = "", skipArchiveMetadataBroadcast = false } = {}) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId) {
      return;
    }
    if (broadcastRemoval && ownedThreadIds.has(normalizedThreadId)) {
      broadcastRemovedConversationState(normalizedThreadId, {
        reason,
        skipArchiveMetadataBroadcast,
      });
    }
    ownedThreadIds.delete(normalizedThreadId);
    conversations.delete(normalizedThreadId);
    cachedThreadsByThreadId.delete(normalizedThreadId);
    pendingThreadHydrationsByThreadId.delete(normalizedThreadId);
    stopAwaitingInitialHistory(normalizedThreadId);
    lastBroadcastStatesByThreadId.delete(normalizedThreadId);
    fallbackTurnIdsByThreadId.delete(normalizedThreadId);
    streamRevisionsByThreadId.delete(normalizedThreadId);
    // An active-peer takeover can still drop a non-empty queue (hasActiveLocalTurn
    // only shields idle yields); announce the emptied queue instead of letting
    // clients keep rendering drafts the bridge will never run.
    const droppedQueuedFollowUps = (queuedFollowUpsByThreadId.get(normalizedThreadId) || []).length > 0;
    queuedFollowUpsByThreadId.delete(normalizedThreadId);
    if (droppedQueuedFollowUps) {
      followerRequests.broadcastQueuedFollowUps(normalizedThreadId);
    }
    runningQueuedFollowUpThreadIds.delete(normalizedThreadId);
    announcedReadStateThreadIds.delete(normalizedThreadId);
    listMetadata.forgetThread(normalizedThreadId);
    pendingTurnStarts.removeThread(normalizedThreadId);
    followerRuntimeOverridesByThreadId.delete(normalizedThreadId);
    dirtyThreadIds.delete(normalizedThreadId);
  }

  function broadcastRemovedConversationState(threadId, { reason = "", skipArchiveMetadataBroadcast = false } = {}) {
    const previousState = conversations.get(threadId)
      || lastBroadcastStatesByThreadId.get(threadId)
      || createEmptyConversationState(threadId, { hostId, now });
    if (reason === "thread/archive" && !skipArchiveMetadataBroadcast) {
      listMetadata.broadcastThreadArchived(threadId, readString(previousState?.cwd));
    }
    const removedState = {
      ...cloneJSON(previousState),
      id: threadId,
      hostId,
      turns: [],
      requests: [],
      hasUnreadTurn: false,
      unreadMessageCount: 0,
      updatedAt: now(),
      agntRemoved: true,
      agntRemovalReason: reason || null,
      archived: reason === "thread/archive" || Boolean(previousState?.archived),
      unsubscribed: reason === "thread/unsubscribe" || Boolean(previousState?.unsubscribed),
    };
    ipc.sendBroadcast(THREAD_STREAM_STATE_CHANGED, {
      conversationId: threadId,
      version: METHOD_VERSION_BY_NAME.get(THREAD_STREAM_STATE_CHANGED) || 1,
      agntOwnerSource: AGNT_LIVE_OWNER_SOURCE,
      agntOwnerReleased: true,
      change: {
        type: "snapshot",
        conversationState: removedState,
      },
    });
  }

  function upsertConversationFromThread(thread) {
    const threadId = readString(thread?.id);
    if (!threadId) {
      return null;
    }
    const previous = conversations.get(threadId) || null;
    const next = buildConversationStateFromThread(thread, {
      previous,
      hostId,
      now,
    });
    runtimeSettingsStore?.attachToConversation?.(threadId, next);
    conversations.set(threadId, next);
    stopAwaitingInitialHistory(threadId);
    return next;
  }

  function ensureConversation(threadId, seed = {}) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    let conversation = conversations.get(normalizedThreadId);
    if (!conversation) {
      conversation = createEmptyConversationState(normalizedThreadId, {
        hostId,
        now,
        cwd: seed.cwd,
      });
      conversations.set(normalizedThreadId, conversation);
    }
    runtimeSettingsStore?.attachToConversation?.(normalizedThreadId, conversation);
    return conversation;
  }

  function seedOwnedConversation(threadId, seed = {}) {
    const normalizedThreadId = readString(threadId);
    const existingConversation = normalizedThreadId ? conversations.get(normalizedThreadId) : null;
    if (existingConversation) {
      return existingConversation;
    }
    const cachedThread = normalizedThreadId ? cachedThreadsByThreadId.get(normalizedThreadId) : null;
    if (cachedThread) {
      return upsertConversationFromThread(cachedThread);
    }
    return ensureConversation(normalizedThreadId, seed);
  }

  function scheduleSnapshot(threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId || !ownedThreadIds.has(normalizedThreadId)) {
      return;
    }
    dirtyThreadIds.add(normalizedThreadId);
    ipc.ensureConnected();
    if (snapshotTimer) {
      return;
    }
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      flushSnapshots();
    }, Math.max(0, snapshotDebounceMs));
    snapshotTimer.unref?.();
  }

  function flushSnapshots() {
    const pendingThreadIds = Array.from(dirtyThreadIds);
    dirtyThreadIds.clear();
    for (const threadId of pendingThreadIds) {
      if (shouldDelayInitialSnapshotForHistory(threadId)) {
        dirtyThreadIds.add(threadId);
        continue;
      }
      if (!broadcastConversationState(threadId)) {
        // Keep unsent snapshots dirty so the reconnect rebroadcast can retry them.
        dirtyThreadIds.add(threadId);
      }
    }
  }

  function shouldDelayInitialSnapshotForHistory(threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId || !threadsAwaitingInitialHistoryByThreadId.has(normalizedThreadId)) {
      return false;
    }
    if (lastBroadcastStatesByThreadId.has(normalizedThreadId)) {
      stopAwaitingInitialHistory(normalizedThreadId);
      return false;
    }
    requestInitialHistoryBaselineIfDue(normalizedThreadId);
    return ownedThreadIds.has(normalizedThreadId)
      && threadsAwaitingInitialHistoryByThreadId.has(normalizedThreadId);
  }

  function requestInitialHistoryBaselineIfDue(threadId) {
    if (pendingThreadHydrationsByThreadId.has(threadId)) {
      return;
    }
    const maxAttempts = Number.isFinite(initialHistoryMaxAttempts)
      ? Math.max(1, Math.floor(initialHistoryMaxAttempts))
      : DEFAULT_INITIAL_HISTORY_MAX_ATTEMPTS;
    const attemptCount = initialHistoryAttemptCountByThreadId.get(threadId) || 0;
    if (attemptCount >= maxAttempts) {
      removeOwnedThread(threadId);
      return;
    }
    const currentTime = now();
    const retryAfter = initialHistoryRetryAfterByThreadId.get(threadId) || 0;
    if (currentTime < retryAfter) {
      scheduleInitialHistoryRetryWakeup(threadId, retryAfter - currentTime);
      return;
    }
    clearInitialHistoryRetryWakeup(threadId);
    const retryBaseMs = Number.isFinite(initialHistoryRetryMs)
      ? Math.max(0, initialHistoryRetryMs)
      : DEFAULT_INITIAL_HISTORY_RETRY_MS;
    const retryDelayMs = retryBaseMs * (2 ** Math.min(attemptCount, 5));
    initialHistoryAttemptCountByThreadId.set(threadId, attemptCount + 1);
    initialHistoryRetryAfterByThreadId.set(threadId, currentTime + retryDelayMs);
    hydrateOwnedThreadFromRead(threadId);
  }

  function stopAwaitingInitialHistory(threadId) {
    threadsAwaitingInitialHistoryByThreadId.delete(threadId);
    initialHistoryRetryAfterByThreadId.delete(threadId);
    initialHistoryAttemptCountByThreadId.delete(threadId);
    clearInitialHistoryRetryWakeup(threadId);
  }

  function scheduleInitialHistoryRetryWakeup(threadId, delayMs) {
    if (initialHistoryRetryTimersByThreadId.has(threadId)) {
      return;
    }
    const timer = setTimeout(() => {
      initialHistoryRetryTimersByThreadId.delete(threadId);
      if (ownedThreadIds.has(threadId) && threadsAwaitingInitialHistoryByThreadId.has(threadId)) {
        scheduleSnapshot(threadId);
      }
    }, Math.max(0, delayMs));
    timer.unref?.();
    initialHistoryRetryTimersByThreadId.set(threadId, timer);
  }

  function clearInitialHistoryRetryWakeup(threadId) {
    const timer = initialHistoryRetryTimersByThreadId.get(threadId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    initialHistoryRetryTimersByThreadId.delete(threadId);
  }

  // Refreshing insertion order makes the Map behave as an LRU; owned threads
  // are exempt from eviction because their cache backs live snapshot rebuilds.
  function rememberCachedThread(threadId, thread) {
    cachedThreadsByThreadId.delete(threadId);
    cachedThreadsByThreadId.set(threadId, cloneJSON(thread));
    if (cachedThreadsByThreadId.size <= MAX_CACHED_THREADS) {
      return;
    }
    for (const cachedThreadId of cachedThreadsByThreadId.keys()) {
      if (cachedThreadsByThreadId.size <= MAX_CACHED_THREADS) {
        return;
      }
      if (!ownedThreadIds.has(cachedThreadId)) {
        cachedThreadsByThreadId.delete(cachedThreadId);
      }
    }
  }

  function hydrateOwnedThreadFromRead(threadId) {
    const normalizedThreadId = readString(threadId);
    if (!normalizedThreadId || pendingThreadHydrationsByThreadId.has(normalizedThreadId)) {
      return;
    }
    const hydration = Promise.resolve()
      .then(() => sendCodexRequest("thread/read", { threadId: normalizedThreadId }))
      .then((result) => {
        const thread = readThreadFromPayload(result);
        if (!thread?.id) {
          return;
        }
        rememberCachedThread(thread.id, thread);
        if (ownedThreadIds.has(thread.id)) {
          upsertConversationFromThread(thread);
        }
      })
      .catch((error) => {
        console.warn(`${logPrefix} desktop IPC live owner thread/read hydration failed for ${normalizedThreadId}: ${error?.message || "unknown error"}`);
      })
      .finally(() => {
        pendingThreadHydrationsByThreadId.delete(normalizedThreadId);
        if (dirtyThreadIds.has(normalizedThreadId) && ownedThreadIds.has(normalizedThreadId)) {
          scheduleSnapshot(normalizedThreadId);
        }
      });
    pendingThreadHydrationsByThreadId.set(normalizedThreadId, hydration);
  }

  function broadcastAllOwnedSnapshots() {
    for (const threadId of ownedThreadIds) {
      if (shouldDelayInitialSnapshotForHistory(threadId)) {
        dirtyThreadIds.add(threadId);
        continue;
      }
      if (broadcastConversationState(threadId, { forceSnapshot: true })) {
        dirtyThreadIds.delete(threadId);
      } else {
        dirtyThreadIds.add(threadId);
      }
    }
  }

  // Returns false only when a pending state change could not be delivered yet.
  function broadcastConversationState(threadId, { forceSnapshot = false } = {}) {
    const conversationState = conversations.get(threadId);
    if (!conversationState || !ownedThreadIds.has(threadId)) {
      return true;
    }
    runtimeSettingsStore?.attachToConversation?.(threadId, conversationState);
    if (shouldDelayInitialSnapshotForHistory(threadId)) {
      return false;
    }
    const currentRevision = streamRevisionsByThreadId.get(threadId) ?? 0;
    const previousState = lastBroadcastStatesByThreadId.get(threadId) || null;
    if (!forceSnapshot && previousState) {
      // Diff straight against the live state: every patch value is deep-cloned
      // as it is collected, so the per-flush O(state) snapshot clone is not
      // needed on the streaming path.
      const patches = buildConversationStatePatches(previousState, conversationState, {
        maxPatchCount,
        maxPatchBytes,
      });
      if (patches && patches.length === 0) {
        return true;
      }
      if (patches && ipc.sendBroadcast(THREAD_STREAM_STATE_CHANGED, {
        conversationId: threadId,
        hostId,
        version: METHOD_VERSION_BY_NAME.get(THREAD_STREAM_STATE_CHANGED) || 1,
        agntOwnerSource: AGNT_LIVE_OWNER_SOURCE,
        change: {
          type: "patches",
          baseRevision: currentRevision,
          revision: currentRevision + 1,
          patches,
        },
      })) {
        streamRevisionsByThreadId.set(threadId, currentRevision + 1);
        // The baseline advances by replaying the emitted patches (their values
        // are already private clones); a full clone happens only if that fails.
        if (!applyPatchesToBaselineState(previousState, patches)) {
          lastBroadcastStatesByThreadId.set(threadId, cloneJSON(conversationState));
        }
        return true;
      }
    }

    // Snapshot broadcasts serialize synchronously, so the live state can be
    // passed through; only the retained baseline needs its own copy.
    if (ipc.sendBroadcast(THREAD_STREAM_STATE_CHANGED, {
      conversationId: threadId,
      hostId,
      version: METHOD_VERSION_BY_NAME.get(THREAD_STREAM_STATE_CHANGED) || 1,
      agntOwnerSource: AGNT_LIVE_OWNER_SOURCE,
      change: {
        type: "snapshot",
        revision: currentRevision + 1,
        conversationState,
      },
    })) {
      streamRevisionsByThreadId.set(threadId, currentRevision + 1);
      lastBroadcastStatesByThreadId.set(threadId, cloneJSON(conversationState));
      return true;
    }
    return false;
  }

  function handlePeerBroadcast(envelope) {
    if (envelope?.method === CLIENT_STATUS_CHANGED) {
      broadcastAllOwnedSnapshots();
      return;
    }
    if (listMetadata.maybeYieldOwnedThreadForPeerArchive(envelope)) {
      return;
    }
    if (envelope?.method !== THREAD_STREAM_STATE_CHANGED) {
      return;
    }
    const params = envelope.params || {};
    const threadId = readString(params.conversationId) || readString(params.conversation_id);
    if (!threadId || !ownedThreadIds.has(threadId)) {
      return;
    }
    if (envelope.sourceClientId && envelope.sourceClientId === ipc.clientId) {
      return;
    }
    if (!isPeerOwnershipBroadcast(params, { normalizeToken, readString })) {
      return;
    }
    if (followerRequests.hasActiveLocalTurn(threadId) && !conversationSnapshotShowsActiveTurn(params.change)) {
      // Desktop re-broadcasts idle snapshots for threads the user merely viewed
      // (and replays them on reconnect). Those may claim an idle thread, but a
      // thread whose local turn is still running yields only to a peer snapshot
      // proving the peer runtime is executing it.
      return;
    }

    // Another Codex frontend is actively owning this stream. Drop bridge ownership
    // and all cached conversation state so a later re-claim rehydrates fresh data
    // instead of republishing stale turns and requests.
    removeOwnedThread(threadId);
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
    // True while the bridge's app-server stream is authoritative for this
    // thread; used to keep fallback mirrors (rollout tail) silent.
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
