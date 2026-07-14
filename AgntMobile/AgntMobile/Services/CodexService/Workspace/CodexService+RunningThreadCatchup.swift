// FILE: CodexService+RunningThreadCatchup.swift
// Purpose: Running-turn catch-up, mirrored refresh permits, and active-thread polling.
// Layer: Service

import Foundation

extension CodexService {
    // Runs the full "running thread catch-up" pipeline once per thread so the
    // display-open, sync-loop, and post-connect flows do not stack duplicate work.
    func catchUpRunningThreadIfNeeded(
        threadId: String,
        shouldForceResume: Bool,
        didRefreshTurnState: Bool = false,
        allowForceRefreshRetry: Bool = true
    ) async -> RunningThreadCatchupOutcome {
        let normalizedThreadID = normalizedInterruptIdentifier(threadId) ?? threadId
        guard !normalizedThreadID.isEmpty else {
            return RunningThreadCatchupOutcome(
                didRefreshTurnState: didRefreshTurnState,
                isRunning: false,
                didRunForcedResume: false
            )
        }

        let refreshGeneration = currentPerThreadRefreshGeneration(for: normalizedThreadID)
        if let existingTask = runningThreadCatchupTaskByThreadID[normalizedThreadID] {
            if shouldForceResume {
                forcedRunningCatchupEscalationThreadIDs.insert(normalizedThreadID)
            }

            let outcome = await existingTask.value
            guard shouldForceResume,
                  allowForceRefreshRetry,
                  outcome.isRunning,
                  !outcome.didRunForcedResume else {
                return outcome
            }

            forcedRunningCatchupEscalationThreadIDs.insert(normalizedThreadID)
            return await catchUpRunningThreadIfNeeded(
                threadId: normalizedThreadID,
                shouldForceResume: true,
                didRefreshTurnState: didRefreshTurnState || outcome.didRefreshTurnState,
                allowForceRefreshRetry: false
            )
        }

        let task = Task<RunningThreadCatchupOutcome, Never> { @MainActor in
            defer {
                // Only the current catch-up task is allowed to clear shared state.
                if isPerThreadRefreshCurrent(for: normalizedThreadID, generation: refreshGeneration) {
                    runningThreadCatchupTaskByThreadID.removeValue(forKey: normalizedThreadID)
                    forcedRunningCatchupEscalationThreadIDs.remove(normalizedThreadID)
                }
            }

            // Evaluate the async fallback explicitly so Swift does not form an async autoclosure for `||`.
            var didRefresh = didRefreshTurnState
            if !didRefresh {
                didRefresh = await refreshInFlightTurnState(threadId: normalizedThreadID)
            }
            guard !Task.isCancelled,
                  isPerThreadRefreshCurrent(for: normalizedThreadID, generation: refreshGeneration) else {
                return RunningThreadCatchupOutcome(
                    didRefreshTurnState: didRefresh,
                    isRunning: false,
                    didRunForcedResume: false
                )
            }

            let isRunning = threadHasActiveOrRunningTurn(normalizedThreadID)
            let effectiveShouldForceResume = shouldForceResume
                || forcedRunningCatchupEscalationThreadIDs.contains(normalizedThreadID)
            guard isRunning, effectiveShouldForceResume else {
                return RunningThreadCatchupOutcome(
                    didRefreshTurnState: didRefresh,
                    isRunning: isRunning,
                    didRunForcedResume: false
                )
            }

            guard takeForcedRunningResumePermit(for: normalizedThreadID) else {
                return RunningThreadCatchupOutcome(
                    didRefreshTurnState: didRefresh,
                    isRunning: true,
                    didRunForcedResume: false
                )
            }

            do {
                _ = try await ensureThreadResumed(threadId: normalizedThreadID, force: true)
                guard !Task.isCancelled,
                      isPerThreadRefreshCurrent(for: normalizedThreadID, generation: refreshGeneration) else {
                    return RunningThreadCatchupOutcome(
                        didRefreshTurnState: didRefresh,
                        isRunning: false,
                        didRunForcedResume: false
                    )
                }
                return RunningThreadCatchupOutcome(
                    didRefreshTurnState: didRefresh,
                    isRunning: threadHasActiveOrRunningTurn(normalizedThreadID),
                    didRunForcedResume: true
                )
            } catch {
                return RunningThreadCatchupOutcome(
                    didRefreshTurnState: didRefresh,
                    isRunning: threadHasActiveOrRunningTurn(normalizedThreadID),
                    didRunForcedResume: false
                )
            }
        }

        runningThreadCatchupTaskByThreadID[normalizedThreadID] = task
        return await task.value
    }

    func shouldTreatAsThreadNotFound(_ error: Error) -> Bool {
        let message: String
        if let serviceError = error as? CodexServiceError,
           case .rpcError(let rpcError) = serviceError {
            message = rpcError.message.lowercased()
        } else {
            message = error.localizedDescription.lowercased()
        }

        if message.contains("not materialized") || message.contains("not yet materialized") {
            return false
        }
        return message.contains("thread not found") || message.contains("unknown thread")
    }

    // Preserves locally derived metadata keys (for example repo context) when server payload is sparse.
    func mergedThreadMetadata(
        serverMetadata: [String: JSONValue]?,
        localMetadata: [String: JSONValue]?
    ) -> [String: JSONValue]? {
        var merged = serverMetadata ?? [:]
        for (key, value) in localMetadata ?? [:] where merged[key] == nil {
            merged[key] = value
        }
        return merged.isEmpty ? nil : merged
    }

    func debugSyncLog(_ message: String) {
#if DEBUG
        print("[CodexSync] \(message)")
#endif
    }

    // Treats thread as active while a real turn id exists or while protected fallback
    // is keeping the run recoverable before the server publishes that turn id.
    func threadHasActiveOrRunningTurn(_ threadId: String) -> Bool {
        activeTurnID(for: threadId) != nil
            || runningThreadIDs.contains(threadId)
            || protectedRunningFallbackThreadIDs.contains(threadId)
    }

    // Keeps short-lived background execution alive when a run is still in flight.
    var hasAnyRunningTurn: Bool {
        !runningThreadIDs.isEmpty
            || !protectedRunningFallbackThreadIDs.isEmpty
            || !activeTurnIdByThread.isEmpty
    }

    var canRunRealtimeSyncLoop: Bool {
        syncRealtimeEnabled && isConnected && isInitialized
    }

    // Prioritizes only desktop-mirrored runs that still lack authoritative assistant deltas.
    func shouldPrioritizeMirroredRunningCatchup(_ threadId: String) -> Bool {
        mirroredRunningCatchupThreadIDs.contains(threadId) && threadHasActiveOrRunningTurn(threadId)
    }

    // Grants one bounded catch-up slot so mirrored desktop runs can refresh via
    // thread/resume without hammering the server every loop tick.
    func takeMirroredRunningCatchupPermit(
        for threadId: String,
        minInterval: TimeInterval = 1.0,
        now: Date = Date()
    ) -> Bool {
        guard shouldPrioritizeMirroredRunningCatchup(threadId) else {
            return false
        }

        if let lastSyncAt = lastMirroredRunningCatchupAtByThread[threadId],
           now.timeIntervalSince(lastSyncAt) < minInterval {
            return false
        }

        lastMirroredRunningCatchupAtByThread[threadId] = now
        return true
    }

    // Polls the currently displayed thread even while it is running so missed socket events can recover.
    // If the live snapshot fails, fall back to a history refresh instead of trusting stale running state.
    func syncActiveThreadState(threadId: String) async {
        var wasRunning = threadHasActiveOrRunningTurn(threadId)
        var didRunMirroredCatchup = false
        let shouldPreferDeferredClosedHydration = shouldDeferHeavyDisplayHydration(threadId: threadId)
            || threadsNeedingCanonicalHistoryReconcile.contains(threadId)

        if !wasRunning,
           hydratedThreadIDs.contains(threadId),
           hasSatisfiedInitialThreadHistoryLoad(threadId: threadId),
           !threadsNeedingCanonicalHistoryReconcile.contains(threadId) {
            return
        }

        // Long closed chats already have usable local rows. Avoid forcing a full thread/read
        // every sync tick after selection, which can reproduce the same open-chat crash.
        if !wasRunning, shouldPreferDeferredClosedHydration {
            let outcome = await catchUpRunningThreadIfNeeded(
                threadId: threadId,
                shouldForceResume: false
            )
            wasRunning = outcome.isRunning
            let shouldTrustClosedState = shouldTrustClosedStateAfterTurnRefresh(
                threadId: threadId,
                didRefreshTurnState: outcome.didRefreshTurnState
            )
            if shouldTrustClosedState {
                // Keep deferred-hydration chats on the lightweight foreground path.
                if threadsNeedingCanonicalHistoryReconcile.contains(threadId) {
                    scheduleCanonicalHistoryReconcileIfNeeded(for: threadId)
                } else if !threadsWithSatisfiedDeferredHistoryHydration.contains(threadId),
                          hasLargePersistedTranscript(threadId: threadId) {
                    markThreadNeedingCanonicalHistoryReconcile(threadId)
                }
                return
            }
        }

        let shouldRunMirroredCatchup = wasRunning && takeMirroredRunningCatchupPermit(for: threadId)

        if wasRunning {
            let outcome = await catchUpRunningThreadIfNeeded(
                threadId: threadId,
                shouldForceResume: shouldRunMirroredCatchup
            )
            didRunMirroredCatchup = outcome.didRunForcedResume

            guard !outcome.didRefreshTurnState || !outcome.isRunning else {
                return
            }
        }

        if !didRunMirroredCatchup {
            await syncThreadHistory(threadId: threadId, force: true)
        }
    }

    func refreshInactiveRunningBadgeThreads(limit: Int = 3) async {
        pruneRunningThreadWatchlist()

        let availableThreadIDs = Set(threads.map(\.id))
        let candidateThreadIDs = runningThreadWatchByID.values
            .sorted { lhs, rhs in
                lhs.expiresAt < rhs.expiresAt
            }
            .map(\.threadId)
            .filter { threadId in
                threadId != activeThreadId
                    && availableThreadIDs.contains(threadId)
                    && runningThreadIDs.contains(threadId)
            }
            .prefix(limit)

        for threadId in candidateThreadIDs {
            let wasRunning = threadHasActiveOrRunningTurn(threadId)
            let didRefresh = await refreshInFlightTurnState(threadId: threadId)

            guard !didRefresh || !wasRunning || !threadHasActiveOrRunningTurn(threadId) else {
                continue
            }

            await syncThreadHistory(threadId: threadId, force: true)
            if !failedThreadIDs.contains(threadId) {
                markReadyIfUnread(threadId: threadId)
            }
            clearRunningThreadWatch(threadId)
        }
    }

    func pruneRunningThreadWatchlist(now: Date = Date()) {
        runningThreadWatchByID = runningThreadWatchByID.filter { _, watch in
            watch.expiresAt > now
        }
    }
}
