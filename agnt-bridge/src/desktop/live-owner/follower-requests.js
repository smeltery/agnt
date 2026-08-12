// FILE: desktop-ipc-live-owner-follower-requests.js
// Purpose: Handles Desktop follower RPCs for bridge-owned live conversations.
// Layer: CLI helper
// Exports: createLiveOwnerFollowerRequestHandler
// Depends on: ./desktop-ipc-live-owner-support, ./desktop-ipc-live-owner-utils, ./desktop-ipc-shared

const {
  buildCompleteThreadReadParams,
  cloneJSON,
  isPlainJSONObject,
  normalizeToken,
  readString,
  requestIdKey,
  visibleUserPromptFromInputEntries,
} = require("../desktop-ipc-shared");
const {
  AGNT_LIVE_OWNER_SOURCE,
  SUPPORTED_FOLLOWER_REQUEST_METHODS,
  THREAD_QUEUED_FOLLOWUPS_CHANGED,
  activeTurnIdFromConversation,
  conversationHasActiveTurn,
} = require("../desktop-ipc-live-owner-support");
const {
  readConversationIdFromFollowerParams,
  readThreadFromPayload,
  readTurnIdFromResult,
  sanitizeTurnStartParams,
} = require("../desktop-ipc-live-owner-utils");

function createLiveOwnerFollowerRequestHandler({
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
}) {
  function canHandleFollowerRequest(envelope) {
    const method = readString(envelope?.request?.method || envelope?.method);
    const params = envelope?.request?.params || envelope?.params || {};
    if (!SUPPORTED_FOLLOWER_REQUEST_METHODS.has(method)) {
      return false;
    }
    const threadId = readConversationIdFromFollowerParams(params);
    return Boolean(threadId && ownedThreadIds.has(threadId));
  }

  async function handleFollowerRequest(envelope) {
    const method = readString(envelope?.method);
    const params = envelope?.params && typeof envelope.params === "object" ? envelope.params : {};
    const conversationId = readConversationIdFromFollowerParams(params);
    if (!conversationId || !ownedThreadIds.has(conversationId)) {
      throw new Error("conversation-not-owned");
    }

    switch (method) {
      case "thread-follower-start-turn":
        return await handleFollowerStartTurn(conversationId, params);
      case "thread-follower-load-complete-history":
        return await handleFollowerLoadCompleteHistory(conversationId);
      case "thread-follower-compact-thread":
        return await sendCodexRequest("thread/compact/start", { threadId: conversationId });
      case "thread-follower-steer-turn":
        return await handleFollowerSteerTurn(conversationId, params);
      case "thread-follower-interrupt-turn":
        return await handleFollowerInterruptTurn(conversationId, params);
      case "thread-follower-command-approval-decision":
        return sendServerRequestResponse(conversationId, params.requestId, { decision: params.decision });
      case "thread-follower-file-approval-decision":
        return sendServerRequestResponse(
          conversationId,
          params.requestId,
          followerApprovalResultForRequest(conversationId, params)
        );
      case "thread-follower-permissions-request-approval-response":
        return sendServerRequestResponse(conversationId, params.requestId, params.response);
      case "thread-follower-submit-user-input":
        return sendServerRequestResponse(conversationId, params.requestId, params.response);
      case "thread-follower-submit-mcp-server-elicitation-response":
        return sendServerRequestResponse(conversationId, params.requestId, params.response);
      case "thread-follower-set-model-and-reasoning":
        return followerRuntimeState.applyModelAndReasoning(conversationId, params);
      case "thread-follower-set-collaboration-mode":
        return followerRuntimeState.applyCollaborationMode(conversationId, params);
      case "thread-follower-update-thread-settings":
        return followerRuntimeState.applyThreadSettings(conversationId, params.threadSettings);
      case "thread-follower-set-queued-follow-ups-state":
        return applyFollowerQueuedFollowUps(conversationId, params.state);
      case "thread-follower-edit-last-user-turn":
        throw new Error("thread-follower-edit-last-user-turn is not supported by agnt yet.");
      default:
        throw new Error(`Unsupported follower request: ${method}`);
    }
  }

  async function handleFollowerLoadCompleteHistory(conversationId) {
    try {
      const result = await sendCodexRequest("thread/read", buildCompleteThreadReadParams(conversationId));
      const thread = readThreadFromPayload(result);
      if (thread?.id) {
        rememberCachedThread(thread.id, thread);
        if (ownedThreadIds.has(thread.id)) {
          upsertConversationFromThread(thread);
        }
      }
    } catch {
      // Not materialized yet: the live conversation state is still authoritative.
    }
    if (!broadcastConversationState(conversationId, { forceSnapshot: true })) {
      throw new Error("no-client-found: thread stream owner became unavailable");
    }
    const revision = streamRevisionsByThreadId.get(conversationId);
    if (revision == null) {
      throw new Error("no-client-found: thread stream owner became unavailable");
    }
    return { revision };
  }

  async function handleFollowerStartTurn(conversationId, params) {
    const rawTurnStartParams = params.turnStartParams
      || params.turn_start_params
      || params.turnStart
      || params;
    const codexParams = followerRuntimeState.mergeOverrides(conversationId, sanitizeTurnStartParams({
      ...rawTurnStartParams,
      threadId: conversationId,
    }));
    const normalizedParams = await Promise.resolve(normalizeTurnStartParams(cloneJSON(codexParams)));
    const nextCodexParams = normalizedParams && typeof normalizedParams === "object" && !Array.isArray(normalizedParams)
      ? normalizedParams
      : codexParams;
    markOwnedThread(conversationId);
    const senderRequestId = params.senderRequestId || params.sender_request_id;
    const isKnownHeldPhoneStart = Boolean(
      requestIdKey(senderRequestId)
      && pendingTurnStarts.hasRequestId(senderRequestId)
    );
    const pendingEntry = pendingTurnStarts.remember(
      conversationId,
      nextCodexParams,
      senderRequestId
    );
    if (pendingEntry) {
      pendingTurnStarts.insertOptimistic(conversationId, pendingEntry);
      scheduleSnapshot(conversationId);
    }
    try {
      const turnStartResult = await sendCodexRequest("turn/start", nextCodexParams);
      followerRuntimeState.commitAccepted(
        conversationId,
        nextCodexParams,
        isKnownHeldPhoneStart ? "phone" : "desktop",
        readTurnIdFromResult(turnStartResult)
      );
      if (!isKnownHeldPhoneStart) {
        mirrorFollowerUserPromptToPhone(conversationId, nextCodexParams, turnStartResult);
      }
      // Codex Desktop's own thread-follower-start-turn-for-host handler replies
      // with { result: <turnStartResult> }; a follower reads response.result.turn
      // off that wrapper. Returning the raw result made Desktop read `.turn` on
      // undefined ("Error creating task"), even though the turn did start.
      return { result: turnStartResult ?? null };
    } catch (error) {
      pendingTurnStarts.discard(conversationId, pendingEntry);
      throw error;
    }
  }

  function mirrorFollowerUserPromptToPhone(threadId, turnStartParams, turnStartResult = null) {
    const text = visibleUserPromptFromInputEntries(turnStartParams?.input);
    if (!text) {
      return;
    }
    const turnId = readString(turnStartResult?.turn?.id)
      || readString(turnStartResult?.turnId)
      || readString(turnStartResult?.turn_id);
    sendPhoneNotification(JSON.stringify({
      method: "codex/event/user_message",
      params: {
        threadId,
        // Mirror the conversation projector's synthetic prompt identity
        // ("<turnId>:input") so later projected snapshots and history reads
        // reconcile into this row instead of appending a duplicate bubble.
        ...(turnId ? { turnId, id: `${turnId}:input` } : {}),
        message: text,
        text,
        agntDesktopMirror: true,
        agntDesktopIpcMirror: true,
        agntActionSource: AGNT_LIVE_OWNER_SOURCE,
        createdAt: now(),
      },
    }));
  }

  async function handleFollowerSteerTurn(conversationId, params) {
    const rawSteerParams = params.turnSteerParams
      || params.turn_steer_params
      || params;
    const expectedTurnId = readString(rawSteerParams.expectedTurnId)
      || readString(rawSteerParams.expected_turn_id)
      || activeTurnIdForConversation(conversationId);
    if (!expectedTurnId) {
      throw new Error("Missing expectedTurnId for follower steer request.");
    }
    return await sendCodexRequest("turn/steer", {
      threadId: conversationId,
      input: Array.isArray(rawSteerParams.input) ? rawSteerParams.input : [],
      expectedTurnId,
    });
  }

  async function handleFollowerInterruptTurn(conversationId, params) {
    const turnId = readString(params.turnId)
      || readString(params.turn_id)
      || activeTurnIdForConversation(conversationId);
    if (!turnId) {
      throw new Error("Missing turnId for follower interrupt request.");
    }
    return await sendCodexRequest("turn/interrupt", {
      threadId: conversationId,
      turnId,
    });
  }

  // Desktop follower approvals only carry decision-style payloads, but app-server
  // permission prompts expect a grant object, mirroring the phone response path.
  function followerApprovalResultForRequest(conversationId, params) {
    const requestId = requestIdKey(params.requestId);
    const pendingRequest = (conversations.get(conversationId)?.requests || [])
      .find((request) => requestIdKey(request?.id) === requestId);
    if (readString(pendingRequest?.method) !== "item/permissions/requestApproval") {
      return { decision: params.decision };
    }

    const decision = readString(params.decision);
    const grantsRequestedPermissions = decision === "accept" || decision === "acceptForSession";
    const requestedPermissions = pendingRequest?.params?.permissions;
    return {
      permissions: grantsRequestedPermissions && isPlainJSONObject(requestedPermissions)
        ? cloneJSON(requestedPermissions)
        : {},
      scope: decision === "acceptForSession" ? "session" : "turn",
    };
  }

  function sendServerRequestResponse(conversationId, requestId, result) {
    const normalizedRequestId = requestIdKey(requestId);
    if (!normalizedRequestId) {
      throw new Error("Missing requestId for follower server response.");
    }
    // Desktop may echo a coerced (stringified) request id; reply with the exact
    // id the app-server used so the pending server request actually resolves.
    const pendingRequest = (conversations.get(conversationId)?.requests || [])
      .find((request) => requestIdKey(request?.id) === normalizedRequestId);
    sendRawCodexMessage(JSON.stringify({
      id: pendingRequest ? pendingRequest.id : requestId,
      result: result || {},
    }));
    return { ok: true };
  }

  // Desktop followers hand the owner the full queue map and expect it to run
  // entries between turns; store it, mirror it to every window, and let the
  // turn/completed hook drain it.
  function applyFollowerQueuedFollowUps(conversationId, state) {
    const messages = state && typeof state === "object" && !Array.isArray(state)
      ? cloneJSON(state[conversationId] ?? [])
      : [];
    if (Array.isArray(messages) && messages.length > 0) {
      queuedFollowUpsByThreadId.set(conversationId, messages);
    } else {
      queuedFollowUpsByThreadId.delete(conversationId);
    }
    broadcastQueuedFollowUps(conversationId);
    if (!conversationHasActiveTurn(conversations.get(conversationId), { normalizeToken })) {
      runNextQueuedFollowUp(conversationId);
    }
    return { ok: true };
  }

  function broadcastQueuedFollowUps(conversationId) {
    ipc.sendBroadcast(THREAD_QUEUED_FOLLOWUPS_CHANGED, {
      conversationId,
      messages: cloneJSON(queuedFollowUpsByThreadId.get(conversationId) ?? []),
    });
  }

  function runNextQueuedFollowUp(threadId) {
    const queue = queuedFollowUpsByThreadId.get(threadId);
    if (!Array.isArray(queue) || queue.length === 0 || runningQueuedFollowUpThreadIds.has(threadId)) {
      return;
    }
    const entry = queue[0];
    if (entry?.pausedReason) {
      return;
    }
    const text = readString(entry?.context?.text)
      || readString(entry?.text)
      || readString(entry?.prompt);
    if (!text) {
      // Unrecognized entry shape: pause it visibly instead of discarding the
      // user's draft. The queue stays blocked (matching Desktop's first-entry
      // semantics) and the user can edit or resend it from any window.
      if (!entry || typeof entry !== "object") {
        queue.shift();
        if (queue.length === 0) {
          queuedFollowUpsByThreadId.delete(threadId);
        }
        broadcastQueuedFollowUps(threadId);
        return;
      }
      console.warn(`${logPrefix} desktop queued follow-up entry has no extractable text; pausing it for ${threadId}`);
      entry.pausedReason = "agnt-unsupported-entry";
      broadcastQueuedFollowUps(threadId);
      return;
    }

    runningQueuedFollowUpThreadIds.add(threadId);
    const conversation = conversations.get(threadId);
    const startParams = followerRuntimeState.mergeOverrides(threadId, sanitizeTurnStartParams({
      threadId,
      input: [{ type: "text", text }],
      cwd: readString(entry?.cwd) || readString(conversation?.cwd) || undefined,
    }));
    let queuedTurnParams = null;
    Promise.resolve()
      .then(() => normalizeTurnStartParams(cloneJSON(startParams)))
      .then((normalized) => {
        const params = normalized && typeof normalized === "object" && !Array.isArray(normalized)
          ? normalized
          : startParams;
        queuedTurnParams = params;
        const pendingEntry = pendingTurnStarts.remember(threadId, params);
        if (pendingEntry) {
          pendingTurnStarts.insertOptimistic(threadId, pendingEntry);
          scheduleSnapshot(threadId);
        }
        return sendCodexRequest("turn/start", params);
      })
      .then((turnStartResult) => {
        followerRuntimeState.commitAccepted(threadId, queuedTurnParams, "desktop", readTurnIdFromResult(turnStartResult));
        queue.shift();
        if (queue.length === 0) {
          queuedFollowUpsByThreadId.delete(threadId);
        }
        broadcastQueuedFollowUps(threadId);
      })
      .catch((error) => {
        console.warn(`${logPrefix} desktop queued follow-up failed for ${threadId}: ${error?.message || "unknown error"}`);
      })
      .finally(() => {
        runningQueuedFollowUpThreadIds.delete(threadId);
      });
  }

  // True while the bridge's app-server is executing a turn for this thread, or
  // has just been asked to start one (pending starts clear on error or on the
  // matching turn/started snapshot). Queued follow-ups count as active work
  // too: releasing ownership deletes the queue, so yielding an "idle" thread
  // that still holds drafts would silently discard them. Such threads must not
  // be handed to peers or released on unsubscribe.
  function hasActiveLocalTurn(threadId) {
    if (pendingTurnStarts.hasPendingThread(threadId)) {
      return true;
    }
    if ((queuedFollowUpsByThreadId.get(threadId) || []).length > 0) {
      return true;
    }
    return conversationHasActiveTurn(conversations.get(threadId), { normalizeToken });
  }

  function activeTurnIdForConversation(conversationId) {
    return activeTurnIdFromConversation(conversations.get(conversationId), { normalizeToken, readString });
  }

  return {
    canHandleFollowerRequest,
    handleFollowerRequest,
    broadcastQueuedFollowUps,
    runNextQueuedFollowUp,
    hasActiveLocalTurn,
    activeTurnIdForConversation,
  };
}

module.exports = {
  createLiveOwnerFollowerRequestHandler,
};
