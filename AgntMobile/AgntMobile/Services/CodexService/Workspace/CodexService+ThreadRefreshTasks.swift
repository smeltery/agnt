// FILE: CodexService+ThreadRefreshTasks.swift
// Purpose: Per-thread refresh generation and cancellation bookkeeping.
// Layer: Service

import Foundation

extension CodexService {
    func clearHydrationCaches() {
        hydratedThreadIDs.removeAll()
        loadingThreadIDs.removeAll()
        cancelAllPerThreadRefreshWork()
    }

    // Bumps the invalidation token used to reject stale async refresh completions.
    func invalidatePerThreadRefreshGeneration(for threadId: String) {
        threadRefreshGenerationByThreadID[threadId, default: 0] &+= 1
    }

    // Captures the current invalidation token for a thread-local refresh task.
    func currentPerThreadRefreshGeneration(for threadId: String) -> UInt64 {
        threadRefreshGenerationByThreadID[threadId] ?? 0
    }

    // Rejects async completions that finished after the thread refresh state was torn down.
    func isPerThreadRefreshCurrent(for threadId: String, generation: UInt64) -> Bool {
        currentPerThreadRefreshGeneration(for: threadId) == generation
    }

    // Stops thread-local refresh tasks when a chat disappears so stale async work cannot write back later.
    func cancelPerThreadRefreshWork(for threadId: String) {
        invalidatePerThreadRefreshGeneration(for: threadId)
        loadingThreadIDs.remove(threadId)
        threadHistoryLoadTaskByThreadID[threadId]?.cancel()
        threadHistoryLoadTaskByThreadID.removeValue(forKey: threadId)
        forcedHistoryLoadThreadIDs.remove(threadId)
        deferHydratedMarkForNotMaterializedThreadIDs.remove(threadId)
        threadResumeTaskByThreadID[threadId]?.cancel()
        threadResumeTaskByThreadID.removeValue(forKey: threadId)
        threadResumeRequestSignatureByThreadID.removeValue(forKey: threadId)
        forcedResumeEscalationThreadIDs.remove(threadId)
        turnStateRefreshTaskByThreadID[threadId]?.cancel()
        turnStateRefreshTaskByThreadID.removeValue(forKey: threadId)
        runningThreadCatchupTaskByThreadID[threadId]?.cancel()
        runningThreadCatchupTaskByThreadID.removeValue(forKey: threadId)
        forcedRunningCatchupEscalationThreadIDs.remove(threadId)
        lastForcedRunningResumeAtByThread.removeValue(forKey: threadId)
        canonicalHistoryReconcileRetryTaskByThreadID[threadId]?.cancel()
        canonicalHistoryReconcileRetryTaskByThreadID.removeValue(forKey: threadId)
        canonicalHistoryReconcileRetryAttemptByThreadID.removeValue(forKey: threadId)
    }

    // Clears all in-flight thread refresh work during reconnect/disconnect baselines.
    func cancelAllPerThreadRefreshWork() {
        let invalidatedThreadIDs = Set(threadHistoryLoadTaskByThreadID.keys)
            .union(threadResumeTaskByThreadID.keys)
            .union(turnStateRefreshTaskByThreadID.keys)
            .union(runningThreadCatchupTaskByThreadID.keys)
            .union(forcedHistoryLoadThreadIDs)
            .union(deferHydratedMarkForNotMaterializedThreadIDs)
            .union(forcedResumeEscalationThreadIDs)
            .union(forcedRunningCatchupEscalationThreadIDs)
            .union(threadResumeRequestSignatureByThreadID.keys)
            .union(lastForcedRunningResumeAtByThread.keys)
            .union(canonicalHistoryReconcileRetryTaskByThreadID.keys)
        invalidatedThreadIDs.forEach { invalidatePerThreadRefreshGeneration(for: $0) }
        loadingThreadIDs.removeAll()
        threadHistoryLoadTaskByThreadID.values.forEach { $0.cancel() }
        threadHistoryLoadTaskByThreadID.removeAll()
        forcedHistoryLoadThreadIDs.removeAll()
        deferHydratedMarkForNotMaterializedThreadIDs.removeAll()
        threadResumeTaskByThreadID.values.forEach { $0.cancel() }
        threadResumeTaskByThreadID.removeAll()
        threadResumeRequestSignatureByThreadID.removeAll()
        forcedResumeEscalationThreadIDs.removeAll()
        turnStateRefreshTaskByThreadID.values.forEach { $0.cancel() }
        turnStateRefreshTaskByThreadID.removeAll()
        runningThreadCatchupTaskByThreadID.values.forEach { $0.cancel() }
        runningThreadCatchupTaskByThreadID.removeAll()
        forcedRunningCatchupEscalationThreadIDs.removeAll()
        lastForcedRunningResumeAtByThread.removeAll()
        workspaceCheckpointCopyTaskByTurnID.values.forEach { $0.cancel() }
        workspaceCheckpointCopyTaskByTurnID.removeAll()
        canonicalHistoryReconcileRetryTaskByThreadID.values.forEach { $0.cancel() }
        canonicalHistoryReconcileRetryTaskByThreadID.removeAll()
        canonicalHistoryReconcileRetryAttemptByThreadID.removeAll()
    }
}
