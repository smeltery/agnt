// FILE: CodexService+ThreadDisplayLifecycle.swift
// Purpose: Active-thread display preparation, deferred hydration decisions, and running-thread watch helpers.
// Layer: Service

import Foundation

extension CodexService {
    // Sets the active thread and lazily hydrates old messages from server history.
    
    func prepareThreadForDisplay(threadId: String) async -> Bool {
        activeThreadId = threadId
        presentRuntimeSettingsError(for: threadId)
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
}
