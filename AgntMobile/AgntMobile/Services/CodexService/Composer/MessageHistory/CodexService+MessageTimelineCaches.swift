// FILE: CodexService+MessageTimelineCaches.swift
// Purpose: Service-owned timeline cache lifecycle and streaming projection updates.
// Layer: Service

import Foundation

extension CodexService {
    // Returns a lightweight per-thread revision token for any message timeline mutation.
    func messageRevision(for threadId: String) -> Int {
        messageRevisionByThread[threadId] ?? 0
    }

    // Returns the service-owned timeline state for a single thread.
    func timelineState(for threadId: String) -> ThreadTimelineState {
        if let existing = threadTimelineStateByThread[threadId] {
            return existing
        }

        let state = ThreadTimelineState(threadID: threadId)
        threadTimelineStateByThread[threadId] = state
        refreshThreadTimelineState(for: threadId)
        return state
    }

    // Prunes service-owned render caches so removed/archived threads do not keep stale snapshots alive.
    func removeThreadTimelineState(for threadId: String) {
        threadTimelineStateByThread.removeValue(forKey: threadId)
        stoppedTurnIDsByThread.removeValue(forKey: threadId)
        messageIndexCacheByThread.removeValue(forKey: threadId)
        latestAssistantOutputByThread.removeValue(forKey: threadId)
        latestAssistantMessageIDByThread.removeValue(forKey: threadId)
        latestRepoAffectingMessageSignalByThread.removeValue(forKey: threadId)
        assistantRevertStateCacheByThread.removeValue(forKey: threadId)
        projectedTerminalStateByThreadID.removeValue(forKey: threadId)
        cancelPendingStreamingDeltaFlushes(for: threadId)
        threadsPendingCompletionHaptic.remove(threadId)
        threadsNeedingCanonicalHistoryReconcile.remove(threadId)
        provisionalPaginatedHistoryThreadIDs.remove(threadId)
        pendingCanonicalSourceReplacementThreadIDs.remove(threadId)
        canonicalHistoryReconcileRetryAttemptByThreadID.removeValue(forKey: threadId)
        threadsWithSatisfiedDeferredHistoryHydration.remove(threadId)
        olderThreadHistoryCursorByThreadID.removeValue(forKey: threadId)
        exhaustedOlderThreadHistoryCursorByThreadID.removeValue(forKey: threadId)
        loadingOlderThreadHistoryIDs.remove(threadId)
        threadTimelineProjectionLimitByThreadID.removeValue(forKey: threadId)
        initialTurnsLoadedByThreadID.remove(threadId)
        threadsWithAuthoritativeLocalHistoryStart.remove(threadId)
        olderHistoryLoadErrorByThreadID.removeValue(forKey: threadId)
        persistThreadHistoryPaginationState()
        canonicalHistoryReconcileTaskByThreadID[threadId]?.cancel()
        canonicalHistoryReconcileTaskByThreadID.removeValue(forKey: threadId)
        canonicalHistoryReconcileRetryTaskByThreadID[threadId]?.cancel()
        canonicalHistoryReconcileRetryTaskByThreadID.removeValue(forKey: threadId)
        cancelPerThreadRefreshWork(for: threadId)
    }

    // Clears every service-owned timeline cache during global teardown.
    func removeAllThreadTimelineState() {
        threadTimelineStateByThread.removeAll()
        stoppedTurnIDsByThread.removeAll()
        messageIndexCacheByThread.removeAll()
        latestAssistantOutputByThread.removeAll()
        latestAssistantMessageIDByThread.removeAll()
        latestRepoAffectingMessageSignalByThread.removeAll()
        assistantRevertStateCacheByThread.removeAll()
        projectedTerminalStateByThreadID.removeAll()
        cancelAllPendingStreamingDeltaFlushes()
        threadsNeedingCanonicalHistoryReconcile.removeAll()
        provisionalPaginatedHistoryThreadIDs.removeAll()
        pendingCanonicalSourceReplacementThreadIDs.removeAll()
        canonicalHistoryReconcileRetryAttemptByThreadID.removeAll()
        threadsWithSatisfiedDeferredHistoryHydration.removeAll()
        olderThreadHistoryCursorByThreadID.removeAll()
        exhaustedOlderThreadHistoryCursorByThreadID.removeAll()
        loadingOlderThreadHistoryIDs.removeAll()
        threadTimelineProjectionLimitByThreadID.removeAll()
        initialTurnsLoadedByThreadID.removeAll()
        threadsWithAuthoritativeLocalHistoryStart.removeAll()
        olderHistoryLoadErrorByThreadID.removeAll()
        persistThreadHistoryPaginationState()
        canonicalHistoryReconcileTaskByThreadID.values.forEach { $0.cancel() }
        canonicalHistoryReconcileTaskByThreadID.removeAll()
        canonicalHistoryReconcileRetryTaskByThreadID.values.forEach { $0.cancel() }
        canonicalHistoryReconcileRetryTaskByThreadID.removeAll()
        cancelAllPerThreadRefreshWork()
    }

    // Refreshes the derived output cache and bumps the thread timeline revision.
    func updateCurrentOutput(for threadId: String) {
        if var messages = messagesByThread[threadId], messages.contains(where: { $0.asyncUserInput != nil }) {
            CodexAsyncUserInputProjection.reconcile(&messages)
            if messages != messagesByThread[threadId] { messagesByThread[threadId] = messages }
        }
        noteMessagesChanged(for: threadId)

        let latestAssistantText = syncLatestAssistantOutputCache(for: threadId)
        refreshThreadTimelineState(for: threadId)

        guard activeThreadId == threadId else {
            return
        }

        currentOutput = latestAssistantText
    }

    // Fast-paths plain assistant text streaming so one delta does not rebuild every derived row cache.
    // Falls back to the full projection path whenever the visible snapshot shape changed underneath us.
    func updateStreamingAssistantOutput(for threadId: String, messageId: String, rawMessageIndex: Int? = nil) {
        noteMessagesChanged(for: threadId)

        // Keep the visible output anchored to the latest assistant bubble, even if a late
        // delta updates an older item inside the same turn.
        let latestAssistantText = syncLatestAssistantOutputCache(for: threadId)
        if activeThreadId == threadId {
            currentOutput = latestAssistantText
        }

        guard let state = threadTimelineStateByThread[threadId],
              let rawMessages = messagesByThread[threadId],
              let updatedMessageIndex = resolvedMessageIndex(
                  threadId: threadId,
                  messageId: messageId,
                  preferredIndex: rawMessageIndex,
                  in: rawMessages
              ),
              rawMessages.indices.contains(updatedMessageIndex),
              rawMessages[updatedMessageIndex].id == messageId,
              let projectedIndex = state.renderSnapshot.messageIndexByID[messageId],
              state.renderSnapshot.messages.indices.contains(projectedIndex),
              state.renderSnapshot.messages[projectedIndex].id == messageId else {
            refreshThreadTimelineState(for: threadId)
            return
        }
        let updatedMessage = rawMessages[updatedMessageIndex]
        if updatedMessage.role == .assistant,
           let terminalMessageId = assistantReplayTargetMessageId(
               in: rawMessages,
               threadId: threadId,
               turnId: updatedMessage.turnId,
               text: updatedMessage.text,
               excludingMessageID: messageId
           ) {
            var nextRawMessages = rawMessages
            nextRawMessages.remove(at: updatedMessageIndex)
            messagesByThread[threadId] = nextRawMessages
            removeAssistantStreamingLookups(messageId: messageId)
            if let turnId = updatedMessage.turnId {
                noteAssistantMessage(threadId: threadId, turnId: turnId, assistantMessageId: terminalMessageId)
            }
            persistMessages()
            updateCurrentOutput(for: threadId)
            return
        }

        let revision = messageRevisionByThread[threadId] ?? 0
        var projectedMessages = state.renderSnapshot.messages
        projectedMessages[projectedIndex] = updatedMessage

        state.messages = rawMessages
        state.messageRevision = revision
        state.renderSnapshot = TurnTimelineRenderSnapshot(
            threadID: threadId,
            messages: projectedMessages,
            messageIndexByID: state.renderSnapshot.messageIndexByID,
            planMatchingMessages: state.renderSnapshot.planMatchingMessages,
            timelineChangeToken: revision,
            activeTurnID: state.renderSnapshot.activeTurnID,
            isThreadRunning: state.renderSnapshot.isThreadRunning,
            latestTurnTerminalState: state.renderSnapshot.latestTurnTerminalState,
            completedTurnIDs: state.renderSnapshot.completedTurnIDs,
            stoppedTurnIDs: state.renderSnapshot.stoppedTurnIDs,
            assistantRevertStatesByMessageID: state.renderSnapshot.assistantRevertStatesByMessageID,
            repoRefreshSignal: state.renderSnapshot.repoRefreshSignal,
            hasOlderHistory: state.renderSnapshot.hasOlderHistory,
            hasRemoteOlderHistory: state.renderSnapshot.hasRemoteOlderHistory,
            hasLocallyProjectedOlderHistory: state.renderSnapshot.hasLocallyProjectedOlderHistory,
            usesPaginatedHistory: state.renderSnapshot.usesPaginatedHistory,
            isLoadingOlderHistory: state.renderSnapshot.isLoadingOlderHistory,
            initialTurnsLoaded: state.renderSnapshot.initialTurnsLoaded,
            olderHistoryLoadErrorMessage: state.renderSnapshot.olderHistoryLoadErrorMessage
        )
    }

    // Patches an already-projected streaming system row without rerunning the reducer.
    func updateStreamingSystemOutput(for threadId: String, messageId: String, rawMessageIndex: Int? = nil) {
        noteMessagesChanged(for: threadId)

        if activeThreadId == threadId {
            currentOutput = latestAssistantOutputByThread[threadId] ?? syncLatestAssistantOutputCache(for: threadId)
        }

        guard let state = threadTimelineStateByThread[threadId],
              let rawMessages = messagesByThread[threadId],
              let updatedMessageIndex = resolvedMessageIndex(
                  threadId: threadId,
                  messageId: messageId,
                  preferredIndex: rawMessageIndex,
                  in: rawMessages
              ),
              rawMessages.indices.contains(updatedMessageIndex),
              rawMessages[updatedMessageIndex].id == messageId,
              let projectedIndex = state.renderSnapshot.messageIndexByID[messageId],
              state.renderSnapshot.messages.indices.contains(projectedIndex),
              state.renderSnapshot.messages[projectedIndex].id == messageId else {
            refreshThreadTimelineState(for: threadId)
            return
        }

        let revision = messageRevisionByThread[threadId] ?? 0
        var projectedMessages = state.renderSnapshot.messages
        projectedMessages[projectedIndex] = rawMessages[updatedMessageIndex]

        state.messages = rawMessages
        state.messageRevision = revision
        state.renderSnapshot = TurnTimelineRenderSnapshot(
            threadID: threadId,
            messages: projectedMessages,
            messageIndexByID: state.renderSnapshot.messageIndexByID,
            planMatchingMessages: state.renderSnapshot.planMatchingMessages,
            timelineChangeToken: revision,
            activeTurnID: state.renderSnapshot.activeTurnID,
            isThreadRunning: state.renderSnapshot.isThreadRunning,
            latestTurnTerminalState: state.renderSnapshot.latestTurnTerminalState,
            completedTurnIDs: state.renderSnapshot.completedTurnIDs,
            stoppedTurnIDs: state.renderSnapshot.stoppedTurnIDs,
            assistantRevertStatesByMessageID: state.renderSnapshot.assistantRevertStatesByMessageID,
            repoRefreshSignal: state.renderSnapshot.repoRefreshSignal,
            hasOlderHistory: state.renderSnapshot.hasOlderHistory,
            hasRemoteOlderHistory: state.renderSnapshot.hasRemoteOlderHistory,
            hasLocallyProjectedOlderHistory: state.renderSnapshot.hasLocallyProjectedOlderHistory,
            usesPaginatedHistory: state.renderSnapshot.usesPaginatedHistory,
            isLoadingOlderHistory: state.renderSnapshot.isLoadingOlderHistory,
            initialTurnsLoaded: state.renderSnapshot.initialTurnsLoaded,
            olderHistoryLoadErrorMessage: state.renderSnapshot.olderHistoryLoadErrorMessage
        )
    }
}
