function createThreadStateManager({
  activeThreads,
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
  backgroundDisconnectTimersByThreadId,
  announcedBackgroundTurnsByThreadId,
}) {
  function forgetEvictedThreadState(threadId) {
    clearDesktopThreadCaches(threadId);
    recoveringThreadIds.delete(threadId);
    heldFollowerRequests.forgetThread(threadId);
  }

  function releaseDesktopThreadState(threadId) {
    clearDesktopThreadCaches(threadId);
    liveOwnerThreadIds.add(threadId);
    heldFollowerRequests.forgetThread(threadId);
    heldFollowerRequests.release(threadId, { toDesktop: false });
  }

  function removeDesktopThreadState(threadId) {
    clearDesktopThreadCaches(threadId);
    liveOwnerThreadIds.delete(threadId);
    heldFollowerRequests.forgetThread(threadId);
    heldFollowerRequests.reject(threadId, "This thread is no longer available for Desktop routing.");
  }

  function clearDesktopThreadCaches(threadId) {
    settleAnnouncedBackgroundTurn(threadId, "interrupted");
    if (backgroundOnlyThreadIds.delete(threadId)) {
      activeThreads.delete(threadId);
    }
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
  }

  function onDisconnect() {
    rawStatesByThreadId.clear();
    rawStateUpdatedAtByThreadId.clear();
    canonicalHistoryReplacementSentThreadIds.clear();
    canonicalActiveTurnsByThreadId.clear();
    recoveringThreadIds.clear();
    baselineRecoveryStateByThreadId.clear();
    queuedChangesByThreadId.clear();
    heldFollowerRequests.clearConnectionProbeState();
    // A lost IPC connection is not evidence that Desktop stopped the turn.
    // Keep announced lifecycle state until a reconnect snapshot, archive, or
    // another authoritative state transition supplies a real terminal status.
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
    heldFollowerRequests.clearAll();
    ipc.close();
  }

  return {
    forgetEvictedThreadState,
    onDisconnect,
    releaseDesktopThreadState,
    removeDesktopThreadState,
    stopAll,
  };
}

module.exports = {
  createThreadStateManager,
};
