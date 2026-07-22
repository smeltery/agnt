const {
  buildDesktopTurnsListResult,
  isDesktopTurnsCursor,
} = require("../desktop-turns-pagination");
const {
  projectDesktopConversationStateToGoal,
  projectDesktopConversationStateToThread,
} = require("../desktop-ipc-conversation-projector");
const {
  DESKTOP_IPC_ACTION_SOURCE,
  hasNormalizedHistoryOutsideRawTurns,
  readThreadId,
} = require("../desktop-ipc-action-follower-support");
const { readString } = require("../desktop-ipc-shared");

function createDesktopReadServer({
  activeThreads,
  canonicalHistoryThreadIds,
  isLocallyOwnedThread,
  liveOwnerThreadIds,
  now,
  rawStateUpdatedAtByThreadId,
  rawStatesByThreadId,
  sendApplicationResponse,
  staleActiveReadMaxAgeMs,
  staleYieldedThreadIds,
  stateReadMethods,
  hasResponsiveDesktopIpc = () => false,
}) {
  function tryServeDesktopOwnedRead(message) {
    const method = readString(message?.method);
    if (!stateReadMethods.has(method) || message?.id == null) {
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
    if (hasActiveProjectedTurn(thread)
      && isRawStateStaleForActiveRead(threadId)
      && !hasResponsiveDesktopIpc()
      && !ownsDesktopCursor) {
      staleYieldedThreadIds.add(threadId);
      return false;
    }
    const result = method === "thread/turns/list"
      ? buildDesktopTurnsListResult(thread.turns, message.params)
      : { thread };
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
    return now() - updatedAt > staleActiveReadMaxAgeMs;
  }

  return {
    tryServeDesktopOwnedRead,
  };
}

function desktopThreadReplacedNotification(threadId) {
  return {
    method: "thread/replaced",
    params: {
      threadId,
      agntDesktopMirror: true,
      agntDesktopIpcMirror: true,
      agntActionSource: DESKTOP_IPC_ACTION_SOURCE,
    },
  };
}

module.exports = {
  createDesktopReadServer,
  desktopThreadReplacedNotification,
};
