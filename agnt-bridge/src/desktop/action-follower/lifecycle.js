const {
  DESKTOP_IPC_ACTION_SOURCE,
  activeCanonicalTurnsById,
  backgroundRawTurnById,
  backgroundTurnLifecycleNotification,
  canonicalTurnById,
  latestActiveBackgroundTurn,
} = require("../desktop-ipc-action-follower-support");
const { readString } = require("../desktop-ipc-shared");

function createDesktopLifecycleSync({
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
  syncProjectedActions,
}) {
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

    rememberCanonicalActiveTurns(threadId, liveState);
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

  return {
    clearBackgroundDisconnectTimer,
    rememberCanonicalActiveTurns,
    scheduleBackgroundDisconnectSettlement,
    settleAnnouncedBackgroundTurn,
    syncBackgroundThreadLifecycle,
    syncCanonicalSnapshotLifecycle,
    syncThreadArchiveBroadcast,
  };
}

module.exports = {
  createDesktopLifecycleSync,
};
