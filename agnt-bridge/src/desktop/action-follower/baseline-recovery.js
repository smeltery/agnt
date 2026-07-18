const {
  applyConversationStateChange,
  createEmptyConversationState,
  desktopLiveStateForProjection,
} = require("../desktop-ipc-action-follower-support");
const { cloneJSON } = require("../desktop-ipc-shared");

function createBaselineRecovery({
  backgroundOnlyThreadIds,
  baselineRecoveryBaseDelayMs,
  baselineRecoveryMaxDelayMs,
  baselineRecoveryStateByThreadId,
  commitRecoveredState,
  conversationProjector,
  createEmptyState = createEmptyConversationState,
  logPrefix,
  maxBaselineRecoveryAttempts,
  maxQueuedChangesPerThread,
  now,
  queuedChangesByThreadId,
  rawStatesByThreadId,
  readConversationState,
  recoveringThreadIds,
}) {
  function queueThreadChange(threadId, change) {
    if (!change || typeof change !== "object") {
      return;
    }

    const queuedChanges = queuedChangesByThreadId.get(threadId) || [];
    queuedChanges.push(change);
    if (queuedChanges.length > maxQueuedChangesPerThread) {
      queuedChanges.splice(0, queuedChanges.length - maxQueuedChangesPerThread);
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
    if (recoveryState.attempts >= maxBaselineRecoveryAttempts || now() < recoveryState.nextAttemptAt) {
      return;
    }
    recoveryState.attempts += 1;
    recoveryState.nextAttemptAt = now() + Math.min(
      baselineRecoveryMaxDelayMs,
      baselineRecoveryBaseDelayMs * (2 ** (recoveryState.attempts - 1))
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
          || recoveryState.attempts === maxBaselineRecoveryAttempts) {
          console.warn(`${logPrefix} desktop IPC baseline recovery failed for ${threadId} (attempt ${recoveryState.attempts}/${maxBaselineRecoveryAttempts}): ${error.message}`);
        }
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
      : createEmptyState();
    for (const change of queuedChanges) {
      nextState = applyConversationStateChange(nextState, change) || nextState;
    }

    if (baselineState && typeof baselineState === "object" && !backgroundOnlyThreadIds.has(threadId)) {
      conversationProjector.seed(threadId, desktopLiveStateForProjection(baselineState));
    }
    commitRecoveredState(threadId, nextState);
  }

  return {
    queueThreadChange,
    recoverThreadBaseline,
  };
}

module.exports = {
  createBaselineRecovery,
};
