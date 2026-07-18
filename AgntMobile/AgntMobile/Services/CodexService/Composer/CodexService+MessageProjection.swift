// FILE: CodexService+MessageProjection.swift
// Purpose: Timeline projection, render snapshot, and revert-state cache helpers.
// Layer: Service

import Foundation
import UIKit

extension CodexService {
    // Rebuilds one thread's render snapshot from service-owned caches after any timeline mutation.
    func refreshThreadTimelineState(for threadId: String) {
        let state = timelineState(for: threadId)
        let messages = messagesByThread[threadId] ?? []
        let revision = messageRevisionByThread[threadId] ?? 0
        let activeTurnID = activeTurnIdByThread[threadId]
        let isThreadRunning = threadHasActiveOrRunningTurn(threadId)
        let usesPaginatedHistory = supportsTurnPagination && initialTurnsLoadedByThreadID.contains(threadId)
        let projectionSourceMessages = snapshotProjectionSourceMessages(
            threadId: threadId,
            from: messages,
            usesPaginatedHistory: usesPaginatedHistory
        )
        let stoppedTurnIDs = rebuildStoppedTurnIDs(for: threadId, messages: projectionSourceMessages)
        let latestTurnTerminalState = latestTurnTerminalStateByThread[threadId]
        let projectedMessages = TurnTimelineReducer.project(messages: projectionSourceMessages).messages
        let planMatchingMessages = projectionSourceMessages.filter { $0.kind == .userInputPrompt }
        let completedTurnIDs = Set(
            projectedMessages.compactMap { message -> String? in
                guard let turnId = message.turnId,
                      turnTerminalState(for: turnId, threadId: threadId) == .completed else {
                    return nil
                }
                return turnId
            }
        )
        let repoRefreshSignal = buildRepoRefreshSignal(for: projectionSourceMessages)
        latestRepoAffectingMessageSignalByThread[threadId] = repoRefreshSignal
        let assistantRevertStates = assistantRevertStates(
            for: threadId,
            projectedMessages: projectedMessages,
            workingDirectory: gitWorkingDirectory(for: threadId),
            messageRevision: revision,
            revertStateRevision: assistantRevertStateRevision
        )
        let hasLocallyProjectedOlderHistory = hasLocallyProjectedEarlierThreadHistory(threadId: threadId)
        let hasRemoteOlderHistory = hasRemoteOlderThreadHistoryCursor(threadId: threadId)
            && !hasKnownLocalHistoryStart(threadId: threadId)
        let hasOlderHistory = hasRemoteOlderHistory || hasLocallyProjectedOlderHistory
        let isLoadingOlderHistory = loadingOlderThreadHistoryIDs.contains(threadId)
        let initialTurnsLoaded = !supportsTurnPagination || initialTurnsLoadedByThreadID.contains(threadId)
        let olderHistoryLoadErrorMessage = olderHistoryLoadErrorByThreadID[threadId]

        state.messages = messages
        state.messageRevision = revision
        state.activeTurnID = activeTurnID
        state.isThreadRunning = isThreadRunning
        state.latestTurnTerminalState = latestTurnTerminalState
        state.completedTurnIDs = completedTurnIDs
        state.stoppedTurnIDs = stoppedTurnIDs
        state.repoRefreshSignal = repoRefreshSignal
        state.hasOlderHistory = hasOlderHistory
        state.hasRemoteOlderHistory = hasRemoteOlderHistory
        state.hasLocallyProjectedOlderHistory = hasLocallyProjectedOlderHistory
        state.usesPaginatedHistory = usesPaginatedHistory
        state.isLoadingOlderHistory = isLoadingOlderHistory
        state.initialTurnsLoaded = initialTurnsLoaded
        state.olderHistoryLoadErrorMessage = olderHistoryLoadErrorMessage
        state.renderSnapshot = TurnTimelineRenderSnapshot(
            threadID: threadId,
            messages: projectedMessages,
            messageIndexByID: projectedMessages.messageIndexByID(),
            planMatchingMessages: planMatchingMessages,
            timelineChangeToken: revision,
            activeTurnID: activeTurnID,
            isThreadRunning: isThreadRunning,
            latestTurnTerminalState: latestTurnTerminalState,
            completedTurnIDs: completedTurnIDs,
            stoppedTurnIDs: stoppedTurnIDs,
            assistantRevertStatesByMessageID: assistantRevertStates,
            repoRefreshSignal: repoRefreshSignal,
            hasOlderHistory: hasOlderHistory,
            hasRemoteOlderHistory: hasRemoteOlderHistory,
            hasLocallyProjectedOlderHistory: hasLocallyProjectedOlderHistory,
            usesPaginatedHistory: usesPaginatedHistory,
            isLoadingOlderHistory: isLoadingOlderHistory,
            initialTurnsLoaded: initialTurnsLoaded,
            olderHistoryLoadErrorMessage: olderHistoryLoadErrorMessage
        )
    }

    // Both paginated and legacy threads use the same bounded render window. Paginated fetches
    // prepend pages into the backing cache, then this projection reveals them deliberately.
    func snapshotProjectionSourceMessages(
        threadId: String,
        from messages: [CodexMessage],
        usesPaginatedHistory _: Bool
    ) -> [CodexMessage] {
        let limit = max(
            TurnTimelineProjectionPolicy.initialMessageLimit,
            threadTimelineProjectionLimitByThreadID[threadId] ?? TurnTimelineProjectionPolicy.initialMessageLimit
        )
        guard messages.count > limit else {
            return messages
        }

        let visibleTail = Array(messages.suffix(limit))
        return visibleTailPreservingTurnArtifacts(
            visibleTail: visibleTail,
            omittedPrefix: messages.dropLast(limit)
        )
    }

    // Preserve the visible turn's prompt and durable artifacts when a tool-heavy
    // tail is larger than the first-paint render window.
    func visibleTailPreservingTurnArtifacts(
        visibleTail: [CodexMessage],
        omittedPrefix: ArraySlice<CodexMessage>
    ) -> [CodexMessage] {
        let visibleTurnIDs = Set(visibleTail.compactMap { message -> String? in
            guard let turnId = message.turnId?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !turnId.isEmpty else {
                return nil
            }
            return turnId
        })
        let visibleMessageIDs = Set(visibleTail.map(\.id))
        let preservedArtifactKinds: Set<CodexMessageKind> = [.fileChange, .plan]

        let sameTurnContext = omittedPrefix.filter { message in
            guard (message.role == .user || isPreservableTurnArtifact(message, kinds: preservedArtifactKinds)),
                  let turnId = message.turnId?.trimmingCharacters(in: .whitespacesAndNewlines),
                  visibleTurnIDs.contains(turnId),
                  !visibleMessageIDs.contains(message.id) else {
                return false
            }
            return true
        }

        let sameTurnContextIDs = Set(sameTurnContext.map(\.id))
        let recentOmittedArtifacts = omittedPrefix
            .suffix(300)
            .filter { message in
                isPreservableTurnArtifact(message, kinds: preservedArtifactKinds)
                    && !visibleMessageIDs.contains(message.id)
                    && !sameTurnContextIDs.contains(message.id)
            }
            .suffix(8)

        let preservedContext = Array(sameTurnContext) + Array(recentOmittedArtifacts)
        guard !preservedContext.isEmpty else {
            return visibleTail
        }

        return (preservedContext + visibleTail)
            .sorted { $0.orderIndex < $1.orderIndex }
    }

    func isPreservableTurnArtifact(
        _ message: CodexMessage,
        kinds: Set<CodexMessageKind>
    ) -> Bool {
        message.role == .system && kinds.contains(message.kind)
    }

    // Refreshes every known timeline state when repo-busy status changes across threads.
    func refreshAllThreadTimelineStates() {
        for threadId in threadTimelineStateByThread.keys {
            refreshThreadTimelineState(for: threadId)
        }
    }

    // Recomputes which repos are currently busy so revert buttons update without scanning all threads per row.
    // Returns true if busy-roots actually changed and dependent timelines were refreshed.
    @discardableResult
    func refreshBusyRepoRootsAndDependentTimelineStates() -> Bool {
        let previousBusyRepoRoots = busyRepoRoots
        let nextBusyRepoRoots = Set(
            threads.compactMap { thread -> String? in
                guard runningThreadIDs.contains(thread.id)
                    || activeTurnIdByThread[thread.id] != nil
                    || protectedRunningFallbackThreadIDs.contains(thread.id) else {
                    return nil
                }

                return canonicalRepoIdentifier(for: thread.gitWorkingDirectory) ?? thread.gitWorkingDirectory
            }
        )

        guard nextBusyRepoRoots != previousBusyRepoRoots else {
            return false
        }

        busyRepoRoots = nextBusyRepoRoots
        busyRepoRootsRevision &+= 1

        // Only refresh threads whose repo is in the changed set, not all threads.
        let changedRoots = previousBusyRepoRoots.symmetricDifference(nextBusyRepoRoots)
        let workingDirByThread: [String: String?] = Dictionary(
            uniqueKeysWithValues: threads.map { ($0.id, $0.gitWorkingDirectory) }
        )
        for threadId in threadTimelineStateByThread.keys {
            let workingDir = workingDirByThread[threadId] ?? nil
            let repoId = canonicalRepoIdentifier(for: workingDir) ?? workingDir
            guard let repoId, changedRoots.contains(repoId) else { continue }
            refreshThreadTimelineState(for: threadId)
        }
        return true
    }

    // Keeps stopped-turn lookup thread-local so scroll/render code never rescans full transcripts.
    func rebuildStoppedTurnIDs(for threadId: String, messages: [CodexMessage]) -> Set<String> {
        let stoppedTurnIDs = Set(
            messages.compactMap(\.turnId)
                .filter { turnTerminalState(for: $0, threadId: threadId) == .stopped }
        )
        stoppedTurnIDsByThread[threadId] = stoppedTurnIDs
        return stoppedTurnIDs
    }

    // Merges terminal states decoded from thread/read without firing haptics or unread badges.
    @discardableResult
    func mergeHistoryTurnTerminalStates(
        threadId: String,
        terminalStatesByTurnID historyStates: [String: CodexTurnTerminalState]
    ) -> Bool {
        guard !historyStates.isEmpty else {
            return false
        }

        var didChange = false
        var didChangePersistedState = false
        for (turnId, state) in historyStates {
            if CodexSyntheticIdentifiers.isProjectedDesktopTurnID(turnId) {
                guard projectedTerminalStateByThreadID[threadId]?[turnId] != state else { continue }
                projectedTerminalStateByThreadID[threadId, default: [:]][turnId] = state
                didChange = true
                continue
            }
            guard terminalStateByTurnID[turnId] != state else { continue }
            terminalStateByTurnID[turnId] = state
            didChange = true
            didChangePersistedState = true
        }

        if didChangePersistedState {
            persistTurnTerminalStates()
        }
        return didChange
    }

    // Tracks the latest repo-affecting system row so git refresh logic can stay out of the view body.
    func buildRepoRefreshSignal(for messages: [CodexMessage]) -> String? {
        guard let latestRepoMessage = messages.last(where: { message in
            guard message.role == .system else { return false }
            return message.kind == .fileChange || message.kind == .commandExecution
        }) else {
            return nil
        }

        return "\(latestRepoMessage.id)|\(latestRepoMessage.text.count)|\(latestRepoMessage.isStreaming)"
    }

    // Reuses a thread-local cache so assistant revert buttons only rebuild when timeline or repo-busy state changes.
    func assistantRevertStates(
        for threadId: String,
        projectedMessages: [CodexMessage],
        workingDirectory: String?,
        messageRevision: Int,
        revertStateRevision: Int
    ) -> [String: AssistantRevertPresentation] {
        if let cached = assistantRevertStateCacheByThread[threadId],
           cached.messageRevision == messageRevision,
           cached.busyRepoRevision == busyRepoRootsRevision,
           cached.revertStateRevision == revertStateRevision {
            return cached.statesByMessageID
        }

        let statesByMessageID = projectedMessages.reduce(into: [String: AssistantRevertPresentation]()) {
            partialResult, message in
            if let presentation = assistantRevertPresentation(
                for: message,
                workingDirectory: workingDirectory
            ) {
                partialResult[message.id] = presentation
            }
        }

        assistantRevertStateCacheByThread[threadId] = AssistantRevertStateCacheEntry(
            messageRevision: messageRevision,
            busyRepoRevision: busyRepoRootsRevision,
            revertStateRevision: revertStateRevision,
            statesByMessageID: statesByMessageID
        )
        return statesByMessageID
    }

    // Invalidates revert presentations globally because sibling threads can change file-overlap risk.
    func invalidateAssistantRevertStates() {
        invalidateAssistantRevertStatesWithoutRefresh()
        scheduleCoalescedRevertRefresh()
    }

    // Bumps the revert revision and clears cache without triggering a full timeline refresh.
    // Callers that already perform their own refresh (e.g. rememberRepoRoot) use this to avoid double work.
    func invalidateAssistantRevertStatesWithoutRefresh() {
        assistantRevertStateRevision &+= 1
        assistantRevertStateCacheByThread.removeAll(keepingCapacity: true)
    }

    // Coalesces multiple revert invalidation calls within the same run loop tick into a single
    // refreshAllThreadTimelineStates(). The Task yields once, so back-to-back callers collapse.
    func scheduleCoalescedRevertRefresh() {
        coalescedRevertRefreshTask?.cancel()
        coalescedRevertRefreshTask = Task { @MainActor [weak self] in
            await Task.yield()
            guard !Task.isCancelled, let self else { return }
            self.refreshAllThreadTimelineStates()
        }
    }

    // Mirrors the stop-button teardown moment with a single success haptic when a live run really finishes.
    func triggerRunCompletionHapticIfNeeded(
        threadId: String,
        state: CodexTurnTerminalState,
        previousState: CodexTurnTerminalState?
    ) {
        // Always consume the pending marker so stopped/failed turns don't leak.
        let wasPending = threadsPendingCompletionHaptic.remove(threadId) != nil
        guard state == .completed,
              previousState != .completed,
              isAppInForeground,
              wasPending else {
            return
        }

        HapticFeedback.shared.triggerNotificationFeedback(type: .success)
    }

}
