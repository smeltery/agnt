// FILE: CodexService+MessageRunningState.swift
// Purpose: Owns active-turn, running badge, terminal state, and reconcile retry helpers.
// Layer: Service
// Exports: CodexService running-state helpers
// Depends on: CodexMessage

import Foundation

extension CodexService {
    // Returns the currently running turn id for a specific thread, if any.
    func activeTurnID(for threadId: String) -> String? {
        activeTurnIdByThread[threadId]
    }

    // Updates the per-thread active turn mapping and refreshes dependent repo/timeline state.
    func setActiveTurnID(_ turnId: String?, for threadId: String) {
        let wasActive = activeTurnIdByThread[threadId] != nil
        if let turnId, !turnId.isEmpty {
            activeTurnIdByThread[threadId] = turnId
        } else {
            activeTurnIdByThread.removeValue(forKey: threadId)
        }
        let isActive = activeTurnIdByThread[threadId] != nil
        refreshBusyRepoRootsAndDependentTimelineStates()
        refreshThreadTimelineState(for: threadId)
        // Mirror only the active/idle edge into the Lock Screen Live Activity.
        if wasActive != isActive {
            syncLiveActivity(threadId: threadId, turnActive: isActive)
        }
    }

    // Toggles the fallback running marker for pre-turn activity while keeping repo-busy state in sync.
    func setProtectedRunningFallback(_ isActive: Bool, for threadId: String) {
        if isActive {
            protectedRunningFallbackThreadIDs.insert(threadId)
        } else {
            protectedRunningFallbackThreadIDs.remove(threadId)
        }
        refreshBusyRepoRootsAndDependentTimelineStates()
        refreshThreadTimelineState(for: threadId)
    }

    func provisionalIDLessTurnID(for threadId: String, startsNewRun: Bool) -> String {
        if !startsNewRun, let existing = provisionalIDLessTurnIDByThread[threadId] {
            return existing
        }
        let provisionalTurnID = CodexSyntheticIdentifiers.provisionalIDLessTurnID()
        provisionalIDLessTurnIDByThread[threadId] = provisionalTurnID
        threadIdByTurnID[provisionalTurnID] = threadId
        return provisionalTurnID
    }

    func promoteProvisionalIDLessTurnIfNeeded(threadId: String, canonicalTurnID: String) {
        guard let provisionalTurnID = provisionalIDLessTurnIDByThread.removeValue(forKey: threadId),
              provisionalTurnID != canonicalTurnID else {
            return
        }

        flushPendingAssistantDeltas(for: threadId, turnId: provisionalTurnID)
        flushPendingSystemDeltasForTurn(threadId: threadId, turnId: provisionalTurnID)

        if var threadMessages = messagesByThread[threadId] {
            var didMutate = false
            for index in threadMessages.indices where threadMessages[index].turnId == provisionalTurnID {
                threadMessages[index].turnId = canonicalTurnID
                didMutate = true
            }
            if didMutate {
                messagesByThread[threadId] = threadMessages
                persistMessages()
                updateCurrentOutput(for: threadId)
            }
        }

        let provisionalTurnKey = streamingMessageKey(threadId: threadId, turnId: provisionalTurnID)
        let canonicalTurnKey = streamingMessageKey(threadId: threadId, turnId: canonicalTurnID)
        if let messageID = streamingAssistantFallbackMessageByTurnID.removeValue(forKey: provisionalTurnKey) {
            streamingAssistantFallbackMessageByTurnID[canonicalTurnKey] = messageID
        }
        let provisionalItemPrefix = "\(provisionalTurnKey)|item:"
        let provisionalItemKeys = streamingAssistantMessageByItemKey.keys.filter {
            $0.hasPrefix(provisionalItemPrefix)
        }
        for provisionalKey in provisionalItemKeys {
            guard let messageID = streamingAssistantMessageByItemKey.removeValue(forKey: provisionalKey) else {
                continue
            }
            let itemSuffix = provisionalKey.dropFirst(provisionalTurnKey.count)
            streamingAssistantMessageByItemKey[canonicalTurnKey + itemSuffix] = messageID
        }
        threadIdByTurnID.removeValue(forKey: provisionalTurnID)
        threadIdByTurnID[canonicalTurnID] = threadId
    }

    @discardableResult
    func promoteDisplacedActiveTurnIfNeeded(threadId: String, completedTurnId: String?) -> Bool {
        guard let completedTurnId else {
            return false
        }

        displacedActiveTurnIDsByThread[threadId]?.remove(completedTurnId)
        guard activeTurnIdByThread[threadId] == completedTurnId,
              let promotedTurnId = displacedActiveTurnIDsByThread[threadId]?.popFirst() else {
            if displacedActiveTurnIDsByThread[threadId]?.isEmpty == true {
                displacedActiveTurnIDsByThread.removeValue(forKey: threadId)
            }
            return false
        }

        if displacedActiveTurnIDsByThread[threadId]?.isEmpty == true {
            displacedActiveTurnIDsByThread.removeValue(forKey: threadId)
        }
        setActiveTurnID(promotedTurnId, for: threadId)
        threadIdByTurnID[promotedTurnId] = threadId
        markThreadAsRunning(threadId)
        setProtectedRunningFallback(false, for: threadId)
        if activeTurnId == completedTurnId {
            activeTurnId = promotedTurnId
        }
        return true
    }

    func turnCompletionMatchesCurrentThreadRun(
        threadId: String,
        completedTurnId: String?,
        currentActiveTurnId: String?
    ) -> Bool {
        guard let completedTurnId else {
            return true
        }
        if let currentActiveTurnId {
            return completedTurnId == currentActiveTurnId
        }
        if supersededTurnIDsByIDLessRunByThread[threadId]?.contains(completedTurnId) == true,
           protectedRunningFallbackThreadIDs.contains(threadId) {
            return false
        }
        return true
    }

    // Marks a rollout-mirrored run for extra thread/resume catch-up until a real
    // assistant delta arrives or the turn completes.
    func markMirroredRunningCatchupNeeded(for threadId: String) {
        mirroredRunningCatchupThreadIDs.insert(threadId)
        lastMirroredRunningCatchupAtByThread.removeValue(forKey: threadId)
    }

    // Stops extra catch-up polling once a live assistant stream exists or the run ends.
    func clearMirroredRunningCatchupNeeded(for threadId: String) {
        mirroredRunningCatchupThreadIDs.remove(threadId)
        lastMirroredRunningCatchupAtByThread.removeValue(forKey: threadId)
    }

    // Clears running/fallback flags together when a thread finishes or disappears.
    func clearRunningState(for threadId: String) {
        runningThreadIDs.remove(threadId)
        protectedRunningFallbackThreadIDs.remove(threadId)
        displacedActiveTurnIDsByThread.removeValue(forKey: threadId)
        supersededTurnIDsByIDLessRunByThread.removeValue(forKey: threadId)
        provisionalIDLessTurnIDByThread.removeValue(forKey: threadId)
        clearMirroredRunningCatchupNeeded(for: threadId)
        refreshBusyRepoRootsAndDependentTimelineStates()
        refreshThreadTimelineState(for: threadId)
        scheduleCanonicalHistoryReconcileIfNeeded(for: threadId)
    }

    // Clears every running marker during disconnect/cleanup so stale repo-busy state cannot leak.
    func clearAllRunningState() {
        runningThreadIDs.removeAll()
        protectedRunningFallbackThreadIDs.removeAll()
        displacedActiveTurnIDsByThread.removeAll()
        supersededTurnIDsByIDLessRunByThread.removeAll()
        provisionalIDLessTurnIDByThread.removeAll()
        mirroredRunningCatchupThreadIDs.removeAll()
        lastMirroredRunningCatchupAtByThread.removeAll()
        refreshBusyRepoRootsAndDependentTimelineStates()
        // Always refresh all threads: threads without a gitWorkingDirectory won't appear in
        // changedRoots but still need their isThreadRunning flag updated after clearing.
        refreshAllThreadTimelineStates()
        for threadId in threadsNeedingCanonicalHistoryReconcile {
            scheduleCanonicalHistoryReconcileIfNeeded(for: threadId)
        }
    }

    // Schedules one full reconcile after a lightweight running catch-up once the thread settles.
    func scheduleCanonicalHistoryReconcileIfNeeded(for threadId: String) {
        guard threadsNeedingCanonicalHistoryReconcile.contains(threadId),
              canonicalHistoryReconcileTaskByThreadID[threadId] == nil,
              canonicalHistoryReconcileRetryTaskByThreadID[threadId] == nil,
              isConnected,
              !threadHasActiveOrRunningTurn(threadId),
              thread(for: threadId)?.syncState == .live else {
            return
        }

        canonicalHistoryReconcileTaskByThreadID[threadId] = Task { @MainActor [weak self] in
            var shouldRetry = false
            var retryDelayNanoseconds: UInt64 = 0
            defer {
                self?.canonicalHistoryReconcileTaskByThreadID.removeValue(forKey: threadId)
                if shouldRetry {
                    self?.canonicalHistoryReconcileRetryTaskByThreadID[threadId]?.cancel()
                    self?.canonicalHistoryReconcileRetryTaskByThreadID[threadId] = Task { @MainActor [weak self] in
                        defer {
                            self?.canonicalHistoryReconcileRetryTaskByThreadID.removeValue(forKey: threadId)
                        }
                        if retryDelayNanoseconds > 0 {
                            try? await Task.sleep(nanoseconds: retryDelayNanoseconds)
                        }
                        guard !Task.isCancelled else {
                            return
                        }
                        // Release this timer's single-flight slot before asking the scheduler
                        // to create the next reconcile attempt.
                        self?.canonicalHistoryReconcileRetryTaskByThreadID.removeValue(forKey: threadId)
                        self?.scheduleCanonicalHistoryReconcileIfNeeded(for: threadId)
                    }
                }
            }

            guard let self,
                  self.threadsNeedingCanonicalHistoryReconcile.contains(threadId),
                  self.isConnected,
                  !self.threadHasActiveOrRunningTurn(threadId),
                  self.thread(for: threadId)?.syncState == .live else {
                return
            }

            do {
                let outcome = try await self.loadThreadHistoryIfNeeded(threadId: threadId, forceRefresh: true)
                guard !Task.isCancelled else { return }
                if outcome.didCompleteCanonicalReconcile {
                    self.markThreadCanonicalHistoryReconciled(threadId)
                } else if outcome == .loadedPaginatedWindow {
                    self.markThreadPaginatedHistorySatisfied(threadId)
                } else if outcome.needsCanonicalRetry,
                          self.threadsNeedingCanonicalHistoryReconcile.contains(threadId),
                          self.isConnected,
                          !self.threadHasActiveOrRunningTurn(threadId),
                          self.thread(for: threadId)?.syncState == .live {
                    shouldRetry = true
                }
            } catch is CancellationError {
                return
            } catch {
                if self.shouldTreatAsThreadNotFound(error) {
                    self.threadsNeedingCanonicalHistoryReconcile.remove(threadId)
                    self.threadsWithSatisfiedDeferredHistoryHydration.remove(threadId)
                    self.canonicalHistoryReconcileRetryAttemptByThreadID.removeValue(forKey: threadId)
                    self.handleMissingThread(threadId)
                } else if self.threadsNeedingCanonicalHistoryReconcile.contains(threadId),
                          self.isConnected,
                          !self.threadHasActiveOrRunningTurn(threadId),
                          self.thread(for: threadId)?.syncState == .live {
                    shouldRetry = true
                    retryDelayNanoseconds = self.nextCanonicalHistoryReconcileRetryDelay(for: threadId)
                }
            }
        }
    }

    private func nextCanonicalHistoryReconcileRetryDelay(for threadId: String) -> UInt64 {
        let nextAttempt = min((canonicalHistoryReconcileRetryAttemptByThreadID[threadId] ?? 0) + 1, 7)
        canonicalHistoryReconcileRetryAttemptByThreadID[threadId] = nextAttempt
        return CanonicalHistoryReconcileRetryPolicy.delayNanoseconds(forAttempt: nextAttempt)
    }

    // Marks a large chat as "local-first for now, but still needs one authoritative server merge".
    func markThreadNeedingCanonicalHistoryReconcile(
        _ threadId: String,
        requestImmediateSync: Bool = false
    ) {
        threadsWithSatisfiedDeferredHistoryHydration.remove(threadId)
        let inserted = threadsNeedingCanonicalHistoryReconcile.insert(threadId).inserted
        if inserted {
            canonicalHistoryReconcileRetryAttemptByThreadID.removeValue(forKey: threadId)
        }
        scheduleCanonicalHistoryReconcileIfNeeded(for: threadId)

        guard requestImmediateSync else {
            return
        }

        requestImmediateActiveThreadSync(threadId: threadId)
    }

    // Clears the deferred-hydration pending flag only after a full canonical merge succeeds.
    func markThreadCanonicalHistoryReconciled(_ threadId: String) {
        guard threadsNeedingCanonicalHistoryReconcile.contains(threadId)
                || threadsWithSatisfiedDeferredHistoryHydration.contains(threadId)
                || hasLargePersistedTranscript(threadId: threadId) else {
            threadsNeedingCanonicalHistoryReconcile.remove(threadId)
            threadsWithSatisfiedDeferredHistoryHydration.remove(threadId)
            return
        }

        threadsNeedingCanonicalHistoryReconcile.remove(threadId)
        threadsWithSatisfiedDeferredHistoryHydration.insert(threadId)
    }

    // With turn pagination, the cursor-backed store replaces one-shot full-history reconciliation.
    func markThreadPaginatedHistorySatisfied(_ threadId: String) {
        threadsNeedingCanonicalHistoryReconcile.remove(threadId)
    }

    // Returns the latest real terminal outcome seen for a thread.
    func latestTurnTerminalState(for threadId: String) -> CodexTurnTerminalState? {
        latestTurnTerminalStateByThread[threadId]
    }

    // Returns the terminal outcome for a specific turn when known.
    func turnTerminalState(for turnId: String?) -> CodexTurnTerminalState? {
        turnTerminalState(for: turnId, threadId: nil)
    }

    // Returns the terminal outcome for a turn. Desktop-projected turn ids are
    // only unique inside their thread, so callers with thread context must use it.
    func turnTerminalState(for turnId: String?, threadId: String?) -> CodexTurnTerminalState? {
        guard let turnId else { return nil }
        if CodexSyntheticIdentifiers.isProjectedDesktopTurnID(turnId),
           let threadId {
            return projectedTerminalStateByThreadID[threadId]?[turnId]
        }
        return terminalStateByTurnID[turnId]
    }

    // Returns turn ids that ended via interruption so copy actions can stay hidden.
    func stoppedTurnIDs(for threadId: String) -> Set<String> {
        stoppedTurnIDsByThread[threadId] ?? []
    }

    // Returns sidebar-only chat badge state. This intentionally stays separate from
    // per-turn runtime truth so "chat finished unread" does not leak into timeline logic.
    func threadRunBadgeState(for threadId: String) -> CodexThreadRunBadgeState? {
        if threadHasPendingApproval(threadId) {
            return .waitingOnUser
        }
        if threadHasActiveOrRunningTurn(threadId) {
            return .running
        }
        if failedThreadIDs.contains(threadId) {
            return .failed
        }
        if readyThreadIDs.contains(threadId) {
            return .ready
        }
        return nil
    }

    // Only exact thread matches count: threadless prompts are routed to the open
    // chat at presentation time and must not badge unrelated sidebar rows.
    func threadHasPendingApproval(_ threadId: String) -> Bool {
        let normalizedThreadID = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedThreadID.isEmpty else {
            return false
        }
        return pendingApprovals.contains { request in
            request.threadId?.trimmingCharacters(in: .whitespacesAndNewlines) == normalizedThreadID
        }
    }

    // Clears "ready/failed" badges when the user has opened a thread.
    func markThreadAsViewed(_ threadId: String) {
        clearRunningThreadWatch(threadId)
        clearOutcomeBadge(for: threadId)
        if threadCompletionBanner?.threadId == threadId {
            threadCompletionBanner = nil
        }
    }

    // Marks thread as actively running while ensuring stale outcomes are cleared.
    func markThreadAsRunning(_ threadId: String) {
        runningThreadIDs.insert(threadId)
        threadsPendingCompletionHaptic.insert(threadId)
        latestTurnTerminalStateByThread.removeValue(forKey: threadId)
        clearOutcomeBadge(for: threadId)
        refreshBusyRepoRootsAndDependentTimelineStates()
        refreshThreadTimelineState(for: threadId)
        updateBackgroundRunGraceTask()
    }

    // Drops the eager runtime-running flag after a stop attempt proves the server still
    // has not published a usable turn id, while keeping protected fallback recovery alive.
    func demoteVisibleRunningStateToProtectedFallback(for threadId: String) {
        runningThreadIDs.remove(threadId)
        refreshBusyRepoRootsAndDependentTimelineStates()
        refreshThreadTimelineState(for: threadId)
        updateBackgroundRunGraceTask()
    }

    // Removes outcome badges while preserving the active-running state.
    func clearOutcomeBadge(for threadId: String) {
        readyThreadIDs.remove(threadId)
        failedThreadIDs.remove(threadId)
    }

    // Marks a chat as ready for sidebar presentation only when it completed off-screen.
    func markReadyIfUnread(threadId: String) {
        clearRunningThreadWatch(threadId)
        let wasAlreadyReady = readyThreadIDs.contains(threadId)
        clearOutcomeBadge(for: threadId)
        guard activeThreadId != threadId else {
            return
        }
        readyThreadIDs.insert(threadId)
        // Show the banner only on the first unread completion, not on every later sync refresh.
        if !wasAlreadyReady {
            presentThreadCompletionBannerIfNeeded(threadId: threadId)
        }
    }

    // Marks a thread as failed only when the user is not already viewing it.
    func markFailedIfUnread(threadId: String) {
        clearRunningThreadWatch(threadId)
        clearOutcomeBadge(for: threadId)
        guard activeThreadId != threadId else {
            return
        }
        failedThreadIDs.insert(threadId)
    }

    // Promotes a thread to the post-run sidebar state from an external completion signal.
    func applyRunCompletionBadgeState(threadId: String, result: CodexRunCompletionResult) {
        switch result {
        case .completed:
            markReadyIfUnread(threadId: threadId)
        case .failed:
            markFailedIfUnread(threadId: threadId)
        }
    }

    // Records the final run outcome so UI can distinguish completed vs interrupted turns.
    func recordTurnTerminalState(
        threadId: String,
        turnId: String?,
        state: CodexTurnTerminalState
    ) {
        let previousState = latestTurnTerminalStateByThread[threadId]
        latestTurnTerminalStateByThread[threadId] = state
        if let turnId {
            if CodexSyntheticIdentifiers.isProjectedDesktopTurnID(turnId) {
                projectedTerminalStateByThreadID[threadId, default: [:]][turnId] = state
            } else if terminalStateByTurnID[turnId] != state {
                terminalStateByTurnID[turnId] = state
                persistTurnTerminalStates()
            }
        }
        refreshThreadTimelineState(for: threadId)
        triggerRunCompletionHapticIfNeeded(
            threadId: threadId,
            state: state,
            previousState: previousState
        )
    }
}
