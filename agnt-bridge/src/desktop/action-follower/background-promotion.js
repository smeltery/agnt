const {
  desktopLiveStateForProjection,
  hasNormalizedHistoryOutsideRawTurns,
} = require("../desktop-ipc-action-follower-support");
const { readString } = require("../desktop-ipc-shared");
const { desktopThreadReplacedNotification } = require("./read-serving");

function createBackgroundPromotion({
  announcedBackgroundTurnsByThreadId,
  backgroundOnlyThreadIds,
  canonicalHistoryReplacementSentThreadIds,
  canonicalHistoryThreadIds,
  clearBackgroundDisconnectTimer,
  conversationProjector,
  rememberCanonicalActiveTurns,
  sendApplicationResponse,
  settleAnnouncedBackgroundTurn,
  syncBackgroundThreadLifecycle,
}) {
  function promoteBackgroundThreadOnRead(threadId, rawState) {
    if (!backgroundOnlyThreadIds.delete(threadId)) {
      return;
    }
    if (!rawState) {
      settleAnnouncedBackgroundTurn(threadId, "interrupted");
      return;
    }

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
      sendApplicationResponse(JSON.stringify(desktopThreadReplacedNotification(threadId)));
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
  }

  return {
    promoteBackgroundThreadOnRead,
  };
}

module.exports = {
  createBackgroundPromotion,
};
