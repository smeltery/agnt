// FILE: CodexService+MessageHistory.swift
// Purpose: Owns per-thread display, hydration, running-state, and history reconciliation helpers.
// Layer: Service
// Exports: CodexService thread history helpers
// Depends on: CodexMessage, JSONValue

import Foundation
import UIKit

enum CanonicalHistoryReconcileRetryPolicy {
    static let initialDelayNanoseconds: UInt64 = 1_500_000_000
    static let maximumDelayNanoseconds: UInt64 = 60_000_000_000

    // Giant histories can take tens of seconds per attempt. Exponential spacing
    // keeps recovery persistent without hammering the bridge forever.
    static func delayNanoseconds(forAttempt attempt: Int) -> UInt64 {
        var delay = initialDelayNanoseconds
        for _ in 1..<max(1, min(attempt, 7)) {
            delay = min(delay * 2, maximumDelayNanoseconds)
        }
        return delay
    }
}

enum StreamingDeltaCoalescingPolicy {
    // One display-frame worth of buffering keeps streaming lively while reducing UI invalidations.
    static let flushDelayNanoseconds: UInt64 = 16_000_000
    // Assistant prose gets one quick first paint, then a calmer cadence once text is visible.
    static let assistantInitialFlushDelayNanoseconds: UInt64 = 50_000_000
    static let assistantStreamingFlushDelayNanoseconds: UInt64 = 80_000_000
    static let assistantLargeStreamingFlushDelayNanoseconds: UInt64 = 100_000_000
    static let interactionFlushDelayNanoseconds: UInt64 = 80_000_000
    static let assistantLargePendingDeltaByteCount = 12_000
    static let assistantLargeVisibleTextByteCount = 32_000
}

extension Array where Element == CodexMessage {
    func messageIndexByID() -> [String: Int] {
        var result: [String: Int] = [:]
        result.reserveCapacity(count)
        for (index, message) in enumerated() {
            result[message.id] = index
        }
        return result
    }
}

extension CodexService {
    enum ThreadHistoryLoadOutcome: Equatable {
        case alreadyHydrated
        case notMaterialized
        case skippedForRunningThread
        case loadedCanonicalHistory
        case loadedRecentWindow
        case loadedPaginatedWindow
        case loadedProvisionalPaginatedWindow
        case deferredAfterTimeout
        case deferredAfterEmptyPage
        case deferredAfterUnavailablePage

        var didCompleteCanonicalReconcile: Bool {
            self == .loadedCanonicalHistory
        }

        var needsCanonicalRetry: Bool {
            self == .loadedRecentWindow
                || self == .loadedProvisionalPaginatedWindow
                || self == .skippedForRunningThread
                || self == .deferredAfterTimeout
                || self == .deferredAfterEmptyPage
                || self == .deferredAfterUnavailablePage
        }
    }

    enum ThreadDisplayPhase: Equatable {
        case loading
        case empty
        case ready
    }

    // Returns the full persisted timeline for a single thread.
    func messages(for threadId: String) -> [CodexMessage] {
        messagesByThread[threadId] ?? []
    }

    // Centralizes first-open display state so reconnect jitter does not bounce
    // an existing chat between loading and the empty placeholder.
    func threadDisplayPhase(threadId: String) -> ThreadDisplayPhase {
        threadDisplayPhase(
            threadId: threadId,
            hasVisibleMessages: !messages(for: threadId).isEmpty,
            isThreadRunning: threadHasActiveOrRunningTurn(threadId)
        )
    }

    // Variant for active SwiftUI views that already hold a per-thread render snapshot.
    // It avoids subscribing that view to the global messagesByThread dictionary.
    func threadDisplayPhase(
        threadId: String,
        hasVisibleMessages: Bool,
        isThreadRunning: Bool
    ) -> ThreadDisplayPhase {
        if hasVisibleMessages || isThreadRunning {
            return .ready
        }

        if loadingThreadIDs.contains(threadId) {
            return .loading
        }

        let shouldShowBlankComposer = shouldShowImmediateEmptyPlaceholder(
            threadId: threadId,
            hasVisibleMessages: hasVisibleMessages,
            isThreadRunning: isThreadRunning
        )
        if supportsTurnPagination,
           !initialTurnsLoadedByThreadID.contains(threadId),
           !shouldShowBlankComposer {
            return .loading
        }

        if shouldSkipInitialDisplayHydration(
            threadId: threadId,
            hasVisibleMessages: hasVisibleMessages,
            isThreadRunning: isThreadRunning
        ) || shouldShowBlankComposer {
            return .empty
        }

        if !hydratedThreadIDs.contains(threadId) {
            return .loading
        }

        return .empty
    }

    // Treats placeholder-only chats as intentionally blank so the UI does not flash
    // a loading state before the thread-open preparation path can confirm the skip.
    func shouldShowImmediateEmptyPlaceholder(threadId: String) -> Bool {
        shouldShowImmediateEmptyPlaceholder(
            threadId: threadId,
            hasVisibleMessages: !messages(for: threadId).isEmpty,
            isThreadRunning: threadHasActiveOrRunningTurn(threadId)
        )
    }

    func shouldShowImmediateEmptyPlaceholder(
        threadId: String,
        hasVisibleMessages: Bool,
        isThreadRunning: Bool
    ) -> Bool {
        guard !isThreadRunning,
              !hasVisibleMessages,
              let thread = thread(for: threadId),
              thread.syncState == .live else {
            return false
        }

        let preview = thread.preview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard preview.isEmpty else {
            return false
        }

        // Keep a brand-new blank chat on the empty composer even if a hydration
        // race briefly toggled the thread into a loading state behind the scenes.
        return thread.displayTitle == CodexThread.defaultDisplayTitle
    }

    // Treat an empty paginated response as provisional when local evidence says
    // this thread should already have visible history.
    func shouldDeferEmptyThreadHistoryPage(
        threadId: String,
        loadedViaPagination: Bool
    ) -> Bool {
        let hasPendingSourceReplacement = pendingCanonicalSourceReplacementThreadIDs.contains(threadId)
        guard loadedViaPagination || hasPendingSourceReplacement else {
            return false
        }

        if hasPendingSourceReplacement {
            return true
        }

        if messagesByThread[threadId]?.isEmpty == false {
            return true
        }

        let preview = (thread(for: threadId)?.preview ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return !preview.isEmpty
    }

    // A freshly started thread has metadata but no server history until the
    // first user message materializes it. Treat that as an empty composer state.
    func shouldTreatAsEmptyUnmaterializedThreadHistory(
        _ error: CodexServiceError,
        threadId: String,
        markHydratedWhenNotMaterialized: Bool
    ) -> Bool {
        guard case .rpcError(let rpcError) = error else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("not materialized")
                && message.contains("before first user message")
                && shouldShowImmediateEmptyPlaceholder(
                    threadId: threadId,
                    hasVisibleMessages: !messages(for: threadId).isEmpty,
                    isThreadRunning: threadHasActiveOrRunningTurn(threadId)
                ) else {
            return false
        }

        if markHydratedWhenNotMaterialized
            && !deferHydratedMarkForNotMaterializedThreadIDs.contains(threadId) {
            hydratedThreadIDs.insert(threadId)
        }
        if activeThreadId == threadId {
            lastErrorMessage = nil
        }
        refreshThreadTimelineState(for: threadId)
        return true
    }

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

    // Sets the active thread and lazily hydrates old messages from server history.
    
    func prepareThreadForDisplay(threadId: String) async -> Bool {
        activeThreadId = threadId
        markThreadAsViewed(threadId)
        updateCurrentOutput(for: threadId)
        var didRefreshRunningState = false
        var shouldRequestImmediateSync = true

        guard isConnected else {
            return true
        }

        // Freshly created empty chats do not need an immediate resume/read pass.
        // Skipping that first hydration avoids extra RPC contention when another
        // thread is already running and the user simply wants a blank composer.
        if shouldSkipInitialDisplayHydration(threadId: threadId) {
            return true
        }

        // Reopening a huge, already-materialized chat should prefer local persisted rows over
        // an immediate full resume/read pass, otherwise one tap can freeze the app on-device.
        if shouldDeferHeavyDisplayHydration(threadId: threadId) {
            // Large chats still need one lightweight turn-state ping so reconnect can rediscover
            // a live run before we decide to trust the local persisted transcript.
            didRefreshRunningState = await refreshInFlightTurnState(threadId: threadId)
            guard !Task.isCancelled else {
                return false
            }
            if shouldTrustClosedStateAfterTurnRefresh(
                threadId: threadId,
                didRefreshTurnState: didRefreshRunningState
            ) {
                markThreadNeedingCanonicalHistoryReconcile(
                    threadId,
                    requestImmediateSync: activeThreadId == threadId
                )
                return true
            }
        }

        do {
            try await ensureThreadResumed(threadId: threadId)
        } catch {
            if shouldTreatAsThreadNotFound(error) {
                handleMissingThread(threadId)
            }
            return false
        }
        guard !Task.isCancelled else {
            return false
        }

        let catchupOutcome = await catchUpRunningThreadIfNeeded(
            threadId: threadId,
            shouldForceResume: true,
            didRefreshTurnState: didRefreshRunningState
        )
        guard !Task.isCancelled else {
            return false
        }

        if catchupOutcome.isRunning {
            // When reopening a running thread, force a fresh resume snapshot so the
            // timeline catches up with output produced while the thread was off-screen.
            // Keep a sync fallback only when the shared catch-up pipeline skipped
            // the forced resume for throttling or a transient refresh failure.
            if catchupOutcome.didRunForcedResume {
                shouldRequestImmediateSync = false
            }
            updateCurrentOutput(for: threadId)
        }
        guard !Task.isCancelled, activeThreadId == threadId else {
            return false
        }
        if shouldRequestImmediateSync {
            requestImmediateActiveThreadSync(threadId: threadId)
        }
        return true
    }

    // Detects a brand-new local thread that has no timeline to hydrate yet.
    func shouldSkipInitialDisplayHydration(threadId: String) -> Bool {
        shouldSkipInitialDisplayHydration(
            threadId: threadId,
            hasVisibleMessages: !messages(for: threadId).isEmpty,
            isThreadRunning: threadHasActiveOrRunningTurn(threadId)
        )
    }

    func shouldSkipInitialDisplayHydration(
        threadId: String,
        hasVisibleMessages: Bool,
        isThreadRunning: Bool
    ) -> Bool {
        guard resumedThreadIDs.contains(threadId),
              !hydratedThreadIDs.contains(threadId),
              !isThreadRunning,
              !hasVisibleMessages,
              thread(for: threadId)?.syncState == .live else {
            return false
        }

        return true
    }

    // Prefers the locally persisted transcript when a non-running thread is already huge.
    // The active sync loop can still refresh lighter chats, but giant histories should not
    // block first paint or crash the device just because the user tapped the row.
    func shouldDeferHeavyDisplayHydration(threadId: String) -> Bool {
        guard !threadHasActiveOrRunningTurn(threadId) else {
            return false
        }

        if threadsNeedingCanonicalHistoryReconcile.contains(threadId) {
            return false
        }

        if threadsWithSatisfiedDeferredHistoryHydration.contains(threadId) {
            return true
        }

        guard hasLargePersistedTranscript(threadId: threadId) else {
            return false
        }

        return true
    }

    // Centralizes the "large chat" threshold so deferred hydration only applies to heavy transcripts.
    func hasLargePersistedTranscript(threadId: String) -> Bool {
        messages(for: threadId).count > TurnTimelineProjectionPolicy.eagerHydrationMessageLimit
    }

    // Only trust a "thread is closed" decision when the turn-state refresh actually succeeded.
    // A failed ping means "unknown", so callers should fall back instead of bailing out early.
    func shouldTrustClosedStateAfterTurnRefresh(threadId: String, didRefreshTurnState: Bool) -> Bool {
        didRefreshTurnState && !threadHasActiveOrRunningTurn(threadId)
    }

    // Prevents repeated forced resumes when the user rapidly switches between running chats.
    func takeForcedRunningResumePermit(
        for threadId: String,
        minInterval: TimeInterval = 1.0,
        now: Date = Date()
    ) -> Bool {
        if let lastRefreshAt = lastForcedRunningResumeAtByThread[threadId],
           now.timeIntervalSince(lastRefreshAt) < minInterval {
            return false
        }

        lastForcedRunningResumeAtByThread[threadId] = now
        return true
    }

    // Starts a short-lived watch for a running thread that just went off-screen.
    func watchRunningThreadIfNeeded(_ threadId: String?, ttl: TimeInterval = 30) {
        guard let threadId = normalizedInterruptIdentifier(threadId),
              threadId != activeThreadId,
              threadHasActiveOrRunningTurn(threadId) else {
            return
        }

        runningThreadWatchByID[threadId] = CodexRunningThreadWatch(
            threadId: threadId,
            expiresAt: Date().addingTimeInterval(ttl)
        )
    }

    func clearRunningThreadWatch(_ threadId: String?) {
        guard let threadId = normalizedInterruptIdentifier(threadId) else {
            return
        }
        runningThreadWatchByID.removeValue(forKey: threadId)
    }

    // Keeps a just-left running thread observable for a short time without polling everything.
    func handleDisplayedThreadChange(from previousThreadId: String?, to nextThreadId: String?) {
        let normalizedPrevious = normalizedInterruptIdentifier(previousThreadId)
        let normalizedNext = normalizedInterruptIdentifier(nextThreadId)

        guard normalizedPrevious != normalizedNext else {
            return
        }

        watchRunningThreadIfNeeded(normalizedPrevious)
        clearRunningThreadWatch(normalizedNext)
    }

    // Loads the recent history page once per thread, leaving older pages behind a cursor.
    @discardableResult
    func loadThreadHistoryIfNeeded(
        threadId: String,
        forceRefresh: Bool = false,
        markHydratedWhenNotMaterialized: Bool = true,
        allowForceRefreshRetry: Bool = true
    ) async throws -> ThreadHistoryLoadOutcome {
        if forceRefresh {
            forcedHistoryLoadThreadIDs.insert(threadId)
        }
        if shouldShowImmediateEmptyPlaceholder(
            threadId: threadId,
            hasVisibleMessages: !messages(for: threadId).isEmpty,
            isThreadRunning: threadHasActiveOrRunningTurn(threadId)
        ) {
            forcedHistoryLoadThreadIDs.remove(threadId)
            hydratedThreadIDs.insert(threadId)
            refreshThreadTimelineState(for: threadId)
            return .alreadyHydrated
        }
        if !forceRefresh,
           hydratedThreadIDs.contains(threadId),
           hasSatisfiedInitialThreadHistoryLoad(threadId: threadId) {
            return .alreadyHydrated
        }
        if !markHydratedWhenNotMaterialized {
            deferHydratedMarkForNotMaterializedThreadIDs.insert(threadId)
        }

        if let existingTask = threadHistoryLoadTaskByThreadID[threadId] {
            let outcome = try await existingTask.value
            if forceRefresh,
               allowForceRefreshRetry,
               outcome == .skippedForRunningThread,
               threadHasActiveOrRunningTurn(threadId) {
                forcedHistoryLoadThreadIDs.insert(threadId)
                return try await loadThreadHistoryIfNeeded(
                    threadId: threadId,
                    forceRefresh: true,
                    markHydratedWhenNotMaterialized: markHydratedWhenNotMaterialized,
                    allowForceRefreshRetry: false
                )
            }
            return outcome
        }

        let refreshGeneration = currentPerThreadRefreshGeneration(for: threadId)
        let task = Task<ThreadHistoryLoadOutcome, Error> { @MainActor in
            let hadInitialTurnsLoadedBeforeRefresh = initialTurnsLoadedByThreadID.contains(threadId)
            let hadAuthoritativeLocalStartBeforeRefresh = hasAuthoritativeLocalHistoryStart(threadId: threadId)
            let hadProvisionalPaginatedHistoryBeforeRefresh = provisionalPaginatedHistoryThreadIDs.contains(threadId)
            let requiresCanonicalPaginatedHistory = hadProvisionalPaginatedHistoryBeforeRefresh
                || threadsNeedingCanonicalHistoryReconcile.contains(threadId)
            let initialTurnsTask = supportsTurnPagination
                ? Task { @MainActor in
                    try await self.fetchInitialThreadTurnsHistoryPage(
                        threadId: threadId,
                        requireCanonical: requiresCanonicalPaginatedHistory
                    )
                }
                : nil
            loadingThreadIDs.insert(threadId)
            defer {
                initialTurnsTask?.cancel()
                // Only clear bookkeeping for the latest refresh generation.
                if isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) {
                    loadingThreadIDs.remove(threadId)
                    threadHistoryLoadTaskByThreadID.removeValue(forKey: threadId)
                    forcedHistoryLoadThreadIDs.remove(threadId)
                    deferHydratedMarkForNotMaterializedThreadIDs.remove(threadId)
                }
            }

            // Metadata comes from thread/read without turns; transcript rows come from
            // thread/turns/list so large chats never require one huge app-server response.
            let metadataParams: JSONValue = .object([
                "threadId": .string(threadId),
                "includeTurns": .bool(false),
            ])

            let response: RPCMessage
            do {
                response = try await sendRequest(
                    method: "thread/read",
                    params: metadataParams,
                    timeoutNanoseconds: ThreadHistoryHydrationPolicy.requestTimeoutNanoseconds
                )
            } catch let error as CodexServiceError {
                if shouldTreatAsEmptyUnmaterializedThreadHistory(
                    error,
                    threadId: threadId,
                    markHydratedWhenNotMaterialized: markHydratedWhenNotMaterialized
                ) {
                    return .notMaterialized
                }
                if case .rpcError(let rpcError) = error, rpcError.code == -32600 {
                    // Sidebar/timeline metadata fetches should keep retrying while the child thread
                    // is still materializing, but full history hydration can stop here.
                    let shouldMarkHydrated = markHydratedWhenNotMaterialized
                        && !deferHydratedMarkForNotMaterializedThreadIDs.contains(threadId)
                    if shouldMarkHydrated {
                        hydratedThreadIDs.insert(threadId)
                        initialTurnsLoadedByThreadID.insert(threadId)
                    }
                    return .notMaterialized
                }
                if shouldDeferThreadHistoryAfterTimeout(error) {
                    markThreadHistoryDeferredAfterTimeout(threadId: threadId)
                    debugSyncLog("thread/read timed out for thread=\(threadId); showing local timeline while canonical history is deferred")
                    return .deferredAfterTimeout
                }
                throw error
            }

            guard !Task.isCancelled,
                  isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                throw CancellationError()
            }

            guard let resultObject = response.result?.objectValue,
                  var threadObject = resultObject["thread"]?.objectValue else {
                throw CodexServiceError.invalidResponse("thread/read response missing thread payload")
            }

            extractContextWindowUsageIfAvailable(threadId: threadId, threadObject: threadObject)

            // Upsert thread metadata (name, agentNickname, agentRole, model, etc.)
            // so subagent identity resolves without navigating into the child thread.
            if let threadData = try? JSONEncoder().encode(JSONValue.object(threadObject)),
               let decoded = try? JSONDecoder().decode(CodexThread.self, from: threadData) {
                upsertThread(decoded, treatAsServerState: true)
            }

            let shouldForceRefresh = forceRefresh || forcedHistoryLoadThreadIDs.contains(threadId)

            // A turn may have started while thread/read was in flight. Normal background
            // history loads should still stay out of the way, but forced refreshes are
            // used when reopening a running thread and need to merge the latest snapshot.
            if threadHasActiveOrRunningTurn(threadId) && !shouldForceRefresh {
                hydratedThreadIDs.insert(threadId)
                if !supportsTurnPagination {
                    initialTurnsLoadedByThreadID.insert(threadId)
                }
                return .skippedForRunningThread
            }

            var loadedViaPagination = false
            var loadedProvisionalJsonlFallback = false
            if supportsTurnPagination {
                do {
                    let turnsPage: ThreadTurnsHistoryPage
                    if let initialTurnsTask {
                        turnsPage = try await initialTurnsTask.value
                    } else {
                        turnsPage = try await fetchInitialThreadTurnsHistoryPage(
                            threadId: threadId,
                            requireCanonical: requiresCanonicalPaginatedHistory
                        )
                    }
                    loadedViaPagination = true
                    loadedProvisionalJsonlFallback = turnsPage.isProvisionalJsonlFallback
                    let shouldSeedInitialCursor = !hadInitialTurnsLoadedBeforeRefresh
                        || hadProvisionalPaginatedHistoryBeforeRefresh
                        || (
                            !hasRemoteOlderThreadHistoryCursor(threadId: threadId)
                                && !hadAuthoritativeLocalStartBeforeRefresh
                        )
                    if !loadedProvisionalJsonlFallback {
                        updateOlderThreadHistoryCursorFromInitialPage(
                            threadId: threadId,
                            cursor: turnsPage.nextCursor,
                            isFreshInitialLoad: shouldSeedInitialCursor
                        )
                    }
                    threadObject["turns"] = .array(chronologicalTurnsFromDescendingPage(turnsPage.turns))
                } catch let error as CodexServiceError {
                    if shouldTreatAsEmptyUnmaterializedThreadHistory(
                        error,
                        threadId: threadId,
                        markHydratedWhenNotMaterialized: markHydratedWhenNotMaterialized
                    ) {
                        return .notMaterialized
                    }
                    if case .rpcError(let rpcError) = error, rpcError.code == -32600 {
                        let shouldMarkHydrated = markHydratedWhenNotMaterialized
                            && !deferHydratedMarkForNotMaterializedThreadIDs.contains(threadId)
                        if shouldMarkHydrated {
                            hydratedThreadIDs.insert(threadId)
                            initialTurnsLoadedByThreadID.insert(threadId)
                        }
                        return .notMaterialized
                    }
                    if shouldDeferThreadHistoryAfterTimeout(error) {
                        markThreadHistoryDeferredAfterTimeout(threadId: threadId)
                        debugSyncLog("thread/turns/list timed out for thread=\(threadId); showing local timeline while history is deferred")
                        return .deferredAfterTimeout
                    }
                    if shouldDeferThreadHistoryAfterBridgeFailure(error) {
                        markThreadHistoryDeferredAfterUnavailablePage(threadId: threadId)
                        debugSyncLog("bridge could not supply thread/turns/list for thread=\(threadId); keeping local timeline while history retries")
                        return .deferredAfterUnavailablePage
                    }
                    if consumeUnsupportedTurnPagination(error, attemptedMethod: "thread/turns/list") {
                        do {
                            threadObject = try await fetchLegacyThreadHistoryObject(threadId: threadId)
                        } catch let legacyError as CodexServiceError {
                            if shouldTreatAsEmptyUnmaterializedThreadHistory(
                                legacyError,
                                threadId: threadId,
                                markHydratedWhenNotMaterialized: markHydratedWhenNotMaterialized
                            ) {
                                return .notMaterialized
                            }
                            if case .rpcError(let rpcError) = legacyError, rpcError.code == -32600 {
                                let shouldMarkHydrated = markHydratedWhenNotMaterialized
                                    && !deferHydratedMarkForNotMaterializedThreadIDs.contains(threadId)
                                if shouldMarkHydrated {
                                    hydratedThreadIDs.insert(threadId)
                                    initialTurnsLoadedByThreadID.insert(threadId)
                                }
                                return .notMaterialized
                            }
                            if shouldDeferThreadHistoryAfterTimeout(legacyError) {
                                markThreadHistoryDeferredAfterTimeout(threadId: threadId)
                                debugSyncLog("legacy thread/read timed out for thread=\(threadId); showing local timeline while history is deferred")
                                return .deferredAfterTimeout
                            }
                            throw legacyError
                        }
                        extractContextWindowUsageIfAvailable(threadId: threadId, threadObject: threadObject)
                    } else {
                        throw error
                    }
                }
            } else {
                do {
                    threadObject = try await fetchLegacyThreadHistoryObject(threadId: threadId)
                } catch let error as CodexServiceError {
                    if shouldTreatAsEmptyUnmaterializedThreadHistory(
                        error,
                        threadId: threadId,
                        markHydratedWhenNotMaterialized: markHydratedWhenNotMaterialized
                    ) {
                        return .notMaterialized
                    }
                    if case .rpcError(let rpcError) = error, rpcError.code == -32600 {
                        let shouldMarkHydrated = markHydratedWhenNotMaterialized
                            && !deferHydratedMarkForNotMaterializedThreadIDs.contains(threadId)
                        if shouldMarkHydrated {
                            hydratedThreadIDs.insert(threadId)
                            initialTurnsLoadedByThreadID.insert(threadId)
                        }
                        return .notMaterialized
                    }
                    if shouldDeferThreadHistoryAfterTimeout(error) {
                        markThreadHistoryDeferredAfterTimeout(threadId: threadId)
                        debugSyncLog("legacy thread/read timed out for thread=\(threadId); showing local timeline while history is deferred")
                        return .deferredAfterTimeout
                    }
                    throw error
                }
                extractContextWindowUsageIfAvailable(threadId: threadId, threadObject: threadObject)
            }

            let historyTerminalStates = decodeTurnTerminalStatesFromThreadRead(threadObject)
            let didUpdateTerminalStates = mergeHistoryTurnTerminalStates(
                threadId: threadId,
                terminalStatesByTurnID: historyTerminalStates
            )
            let historyMessages = decodeMessagesFromThreadRead(threadId: threadId, threadObject: threadObject)
            let isSuspiciousEmptyHistory = historyMessages.isEmpty
                && shouldDeferEmptyThreadHistoryPage(
                    threadId: threadId,
                    loadedViaPagination: loadedViaPagination
                )
            if isSuspiciousEmptyHistory {
                markThreadHistoryDeferredAfterEmptyPage(threadId: threadId)
                debugSyncLog("thread history returned no visible rows despite prior-content evidence thread=\(threadId); keeping cached timeline and retrying")
                return .deferredAfterEmptyPage
            }
            registerSubagentThreads(from: historyMessages, parentThreadId: threadId)
            if loadedViaPagination {
                seedThreadTimelineProjectionForPaginatedHistory(
                    threadId: threadId,
                    decodedMessageCount: historyMessages.count
                )
                initialTurnsLoadedByThreadID.insert(threadId)
            } else {
                updateThreadTimelineProjectionForEmbeddedHistory(threadId: threadId, decodedMessageCount: historyMessages.count)
            }
            var outcome: ThreadHistoryLoadOutcome = loadedViaPagination
                ? (loadedProvisionalJsonlFallback
                    ? .loadedProvisionalPaginatedWindow
                    : .loadedPaginatedWindow)
                : .loadedCanonicalHistory
            if !historyMessages.isEmpty {
                let cachedMessages = messagesByThread[threadId] ?? []
                let replacesMirroredSourceEpoch = !loadedProvisionalJsonlFallback
                    && pendingCanonicalSourceReplacementThreadIDs.contains(threadId)
                let existingMessages = replacesMirroredSourceEpoch
                    ? Self.existingMessagesForCanonicalSourceReplacement(cachedMessages, history: historyMessages)
                    : cachedMessages
                let activeThreadIDs = Set(activeTurnIdByThread.keys)
                let runningIDs = runningThreadIDs
                let usedRecentWindow = !replacesMirroredSourceEpoch
                    && shouldForceRefresh
                    && threadHasActiveOrRunningTurn(threadId)
                    && Self.shouldPreferRecentHistoryWindow(
                        existingCount: existingMessages.count,
                        historyCount: historyMessages.count
                    )
                if loadedViaPagination,
                   shouldTrustExistingCacheAsPrePaginationFullHistory(
                    threadId: threadId,
                    existingMessages: existingMessages,
                    paginatedMessages: historyMessages,
                    hadInitialTurnsLoadedBeforeRefresh: hadInitialTurnsLoadedBeforeRefresh,
                    hadAuthoritativeLocalStartBeforeRefresh: hadAuthoritativeLocalStartBeforeRefresh
                   ) {
                    markThreadLocalHistoryStartAuthoritative(threadId, clearRemoteCursor: true)
                    debugSyncLog("thread history migrated pre-pagination full cache thread=\(threadId) local=\(existingMessages.count) firstPage=\(historyMessages.count)")
                } else if !loadedViaPagination, !usedRecentWindow {
                    markThreadLocalHistoryStartAuthoritative(threadId, clearRemoteCursor: true)
                }
                if usedRecentWindow {
                    markThreadNeedingCanonicalHistoryReconcile(threadId)
                }
                let merged = try await mergeHistoryMessagesOffMainActor(
                    existing: existingMessages,
                    history: historyMessages,
                    activeThreadIDs: activeThreadIDs,
                    runningThreadIDs: runningIDs,
                    preferRecentWindow: usedRecentWindow
                )
                guard !Task.isCancelled,
                      isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                    throw CancellationError()
                }
                guard shouldForceRefresh || !threadHasActiveOrRunningTurn(threadId) else {
                    hydratedThreadIDs.insert(threadId)
                    return .skippedForRunningThread
                }

                // Keep any already-hydrated local transcript and merge pages into it. Do not
                // shrink a legacy/full local cache down to only the first paginated page.
                let nextMessages = merged
                if nextMessages != cachedMessages {
                    messagesByThread[threadId] = nextMessages
                    persistMessages()
                    updateCurrentOutput(for: threadId)
                } else if didUpdateTerminalStates {
                    refreshThreadTimelineState(for: threadId)
                }
                if usedRecentWindow {
                    outcome = .loadedRecentWindow
                    if !threadHasActiveOrRunningTurn(threadId) {
                        scheduleCanonicalHistoryReconcileIfNeeded(for: threadId)
                    }
                } else if outcome.didCompleteCanonicalReconcile, !threadHasActiveOrRunningTurn(threadId) {
                    markThreadCanonicalHistoryReconciled(threadId)
                }
                if loadedProvisionalJsonlFallback {
                    provisionalPaginatedHistoryThreadIDs.insert(threadId)
                    markThreadNeedingCanonicalHistoryReconcile(threadId)
                } else if loadedViaPagination {
                    provisionalPaginatedHistoryThreadIDs.remove(threadId)
                }
                if replacesMirroredSourceEpoch {
                    pendingCanonicalSourceReplacementThreadIDs.remove(threadId)
                }
            } else if didUpdateTerminalStates {
                refreshThreadTimelineState(for: threadId)
            } else if loadedProvisionalJsonlFallback {
                provisionalPaginatedHistoryThreadIDs.insert(threadId)
                markThreadNeedingCanonicalHistoryReconcile(threadId)
            } else if loadedViaPagination {
                provisionalPaginatedHistoryThreadIDs.remove(threadId)
            }

            guard !Task.isCancelled,
                  isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                throw CancellationError()
            }
            if outcome == .loadedPaginatedWindow, !threadHasActiveOrRunningTurn(threadId) {
                markThreadPaginatedHistorySatisfied(threadId)
            } else if outcome.didCompleteCanonicalReconcile, !threadHasActiveOrRunningTurn(threadId) {
                markThreadCanonicalHistoryReconciled(threadId)
            }
            clearDeferredThreadHistoryErrorIfNeeded(threadId: threadId)
            initialTurnsLoadedByThreadID.insert(threadId)
            hydratedThreadIDs.insert(threadId)
            refreshThreadTimelineState(for: threadId)
            return outcome
        }

        threadHistoryLoadTaskByThreadID[threadId] = task
        return try await task.value
    }

    // Extracts context window usage from thread/read response if the runtime includes it.
    func extractContextWindowUsageIfAvailable(threadId: String, threadObject: [String: JSONValue]) {
        guard let usage = extractContextWindowUsage(from: threadObject) else { return }
        contextWindowUsageByThread[threadId] = usage
    }
}
