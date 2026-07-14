function createPendingSnapshotScheduler({
  commitConversationState,
  pendingSnapshotsByThreadId,
  snapshotDebounceMs,
}) {
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

  return {
    cancelPendingSnapshot,
    schedulePendingSnapshot,
  };
}

module.exports = {
  createPendingSnapshotScheduler,
};
