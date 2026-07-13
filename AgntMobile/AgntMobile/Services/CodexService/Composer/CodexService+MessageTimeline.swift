// FILE: CodexService+MessageTimeline.swift
// Purpose: Owns streaming delta buffering and timeline projection helpers.
// Layer: Service
// Exports: CodexService message timeline helpers
// Depends on: CodexMessage, TurnTimelineReducer

import Foundation
import UIKit

extension CodexService {
    func enqueueAssistantDelta(
        threadId: String,
        turnId: String,
        itemId: String?,
        assistantPhase: String? = nil,
        delta: String
    ) {
        let normalizedItemId = normalizedStreamingItemID(itemId)
        let normalizedPhase = normalizedAssistantPhase(assistantPhase)
        let streamID = assistantDeltaStreamID(threadId: threadId, turnId: turnId, itemId: normalizedItemId)

        if normalizedItemId != nil {
            migratePendingTurnFallbackDelta(
                threadId: threadId,
                turnId: turnId,
                destinationStreamID: streamID,
                normalizedItemId: normalizedItemId
            )
        }

        pendingAssistantDeltaContextByStreamID[streamID] = (
            threadId: threadId,
            turnId: turnId.trimmingCharacters(in: .whitespacesAndNewlines),
            itemId: normalizedItemId,
            assistantPhase: normalizedPhase,
            isReplayed: isApplyingReplayedBridgeEvent
        )
        if pendingAssistantDeltaByStreamID[streamID] == nil,
           !pendingAssistantDeltaStreamOrder.contains(streamID) {
            pendingAssistantDeltaStreamOrder.append(streamID)
        }
        pendingAssistantDeltaByStreamID[streamID] = mergeAssistantDelta(
            existingText: pendingAssistantDeltaByStreamID[streamID] ?? "",
            incomingDelta: delta
        )
        schedulePendingAssistantDeltaFlushIfNeeded()
    }

    private func migratePendingTurnFallbackDelta(
        threadId: String,
        turnId: String,
        destinationStreamID: String,
        normalizedItemId: String?
    ) {
        let fallbackStreamID = assistantDeltaStreamID(threadId: threadId, turnId: turnId, itemId: nil)
        guard fallbackStreamID != destinationStreamID,
              let fallbackDelta = pendingAssistantDeltaByStreamID.removeValue(forKey: fallbackStreamID) else {
            return
        }

        let fallbackContext = pendingAssistantDeltaContextByStreamID[fallbackStreamID]
        pendingAssistantDeltaContextByStreamID.removeValue(forKey: fallbackStreamID)
        pendingAssistantDeltaStreamOrder.removeAll { $0 == fallbackStreamID }
        if pendingAssistantDeltaByStreamID[destinationStreamID] == nil,
           !pendingAssistantDeltaStreamOrder.contains(destinationStreamID) {
            pendingAssistantDeltaStreamOrder.append(destinationStreamID)
        }
        pendingAssistantDeltaByStreamID[destinationStreamID] = mergeAssistantDelta(
            existingText: pendingAssistantDeltaByStreamID[destinationStreamID] ?? "",
            incomingDelta: fallbackDelta
        )
        pendingAssistantDeltaContextByStreamID[destinationStreamID] = (
            threadId: threadId,
            turnId: turnId.trimmingCharacters(in: .whitespacesAndNewlines),
            itemId: normalizedItemId,
            assistantPhase: fallbackContext?.assistantPhase,
            isReplayed: fallbackContext?.isReplayed ?? isApplyingReplayedBridgeEvent
        )
    }

    private func schedulePendingAssistantDeltaFlushIfNeeded() {
        guard pendingAssistantDeltaFlushTask == nil else { return }

        let flushDelayNanoseconds = pendingAssistantDeltaFlushDelayNanoseconds()
        pendingAssistantDeltaFlushTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: flushDelayNanoseconds)
            guard !Task.isCancelled else { return }
            await Self.deferFlushWhileInteractionIsActive()
            guard !Task.isCancelled else { return }
            self.flushPendingAssistantDeltas()
        }
    }

    // A drag or typing burst can start after the flush timer was armed; wait it out in
    // interaction-cadence slices, bounded so a long flick chain cannot starve the stream.
    static func deferFlushWhileInteractionIsActive() async {
        var remainingDeferrals = 8
        while !Task.isCancelled,
              remainingDeferrals > 0,
              StreamingUIInteractionMonitor.isInteractionActive() {
            remainingDeferrals -= 1
            try? await Task.sleep(
                nanoseconds: StreamingDeltaCoalescingPolicy.interactionFlushDelayNanoseconds
            )
        }
    }

    private func pendingAssistantDeltaFlushDelayNanoseconds() -> UInt64 {
        var largestVisibleByteCount = 0
        for streamID in pendingAssistantDeltaStreamOrder {
            guard let visibleByteCount = visibleAssistantTextByteCount(forPendingAssistantStreamID: streamID) else {
                return StreamingDeltaCoalescingPolicy.assistantInitialFlushDelayNanoseconds
            }
            largestVisibleByteCount = max(largestVisibleByteCount, visibleByteCount)
        }

        let pendingDeltaByteCount = pendingAssistantDeltaByStreamID.values.reduce(0) { total, delta in
            total + delta.utf8.count
        }
        let isLargeStream = pendingDeltaByteCount >= StreamingDeltaCoalescingPolicy.assistantLargePendingDeltaByteCount
            || largestVisibleByteCount >= StreamingDeltaCoalescingPolicy.assistantLargeVisibleTextByteCount

        return isLargeStream
            ? StreamingDeltaCoalescingPolicy.assistantLargeStreamingFlushDelayNanoseconds
            : StreamingDeltaCoalescingPolicy.assistantStreamingFlushDelayNanoseconds
    }

    // Treat streams with no painted text as first-block work so sends still feel immediate.
    private func visibleAssistantTextByteCount(forPendingAssistantStreamID streamID: String) -> Int? {
        guard let context = pendingAssistantDeltaContextByStreamID[streamID],
              let messageID = streamingAssistantMessageID(
                threadId: context.threadId,
                turnId: context.turnId,
                itemId: context.itemId
              ),
              let messageIndex = findMessageIndex(threadId: context.threadId, messageId: messageID),
              let message = messagesByThread[context.threadId]?[messageIndex],
              hasRenderableAssistantOutputText(message.text) else {
            return nil
        }

        return message.text.utf8.count
    }

    private func streamingAssistantMessageID(threadId: String, turnId: String, itemId: String?) -> String? {
        if let itemId,
           let messageID = streamingAssistantMessageByItemKey[
            assistantStreamingMessageKey(threadId: threadId, turnId: turnId, itemId: itemId)
           ] {
            return messageID
        }

        return streamingAssistantFallbackMessageByTurnID[
            streamingMessageKey(threadId: threadId, turnId: turnId)
        ]
    }

    func flushPendingAssistantDeltas(
        for threadId: String? = nil,
        turnId: String? = nil,
        itemId: String? = nil
    ) {
        let normalizedTurnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedItemId = normalizedStreamingItemID(itemId)
        let streamIDsToFlush = pendingAssistantDeltaStreamOrder.filter { streamID in
            guard let context = pendingAssistantDeltaContextByStreamID[streamID] else {
                return true
            }
            if let threadId, context.threadId != threadId {
                return false
            }
            if let normalizedTurnId, context.turnId != normalizedTurnId {
                return false
            }
            if let normalizedItemId {
                return context.itemId == normalizedItemId || context.itemId == nil
            }
            return true
        }

        if !streamIDsToFlush.isEmpty {
            let flushedStreamIDs = Set(streamIDsToFlush)

            for streamID in streamIDsToFlush {
                guard let context = pendingAssistantDeltaContextByStreamID[streamID],
                      let delta = pendingAssistantDeltaByStreamID[streamID] else {
                    pendingAssistantDeltaByStreamID.removeValue(forKey: streamID)
                    pendingAssistantDeltaContextByStreamID.removeValue(forKey: streamID)
                    continue
                }

                pendingAssistantDeltaByStreamID.removeValue(forKey: streamID)
                pendingAssistantDeltaContextByStreamID.removeValue(forKey: streamID)
                let previousReplayScope = isApplyingReplayedBridgeEvent
                if context.isReplayed {
                    isApplyingReplayedBridgeEvent = true
                }
                applyAssistantDeltaBatch(
                    threadId: context.threadId,
                    turnId: context.turnId,
                    itemId: context.itemId,
                    assistantPhase: context.assistantPhase,
                    delta: delta
                )
                isApplyingReplayedBridgeEvent = previousReplayScope
            }
            pendingAssistantDeltaStreamOrder.removeAll { flushedStreamIDs.contains($0) }
        }

        if pendingAssistantDeltaByStreamID.isEmpty {
            pendingAssistantDeltaStreamOrder.removeAll()
            pendingAssistantDeltaFlushTask?.cancel()
            pendingAssistantDeltaFlushTask = nil
        } else if pendingAssistantDeltaFlushTask == nil {
            schedulePendingAssistantDeltaFlushIfNeeded()
        }
    }

    private func assistantDeltaStreamID(threadId: String, turnId: String, itemId: String?) -> String {
        let normalizedTurnId = turnId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let itemComponent: String
        if let normalizedItemId, !normalizedItemId.isEmpty {
            itemComponent = normalizedItemId
        } else {
            itemComponent = "__turn__"
        }
        return "\(threadId)|\(normalizedTurnId)|\(itemComponent)"
    }

    // Reuses the sidebar "ready" signal to surface a lightweight in-app banner for off-screen chats.
    func presentThreadCompletionBannerIfNeeded(threadId: String) {
        guard let thread = thread(for: threadId), !thread.isSubagent else {
            return
        }

        threadCompletionBanner = CodexThreadCompletionBanner(
            threadId: threadId,
            title: thread.displayTitle
        )
    }

    // Bumps a thread-local revision whenever its message timeline changes.
    func noteMessagesChanged(for threadId: String) {
        messageRevisionByThread[threadId, default: 0] &+= 1
    }

    // Keeps the "latest output" cache in sync for both full refreshes and lightweight streaming updates.
    func syncLatestAssistantOutputCache(for threadId: String) -> String {
        guard let messages = messagesByThread[threadId] else {
            latestAssistantOutputByThread[threadId] = ""
            latestAssistantMessageIDByThread.removeValue(forKey: threadId)
            return ""
        }

        if let cachedMessageID = latestAssistantMessageIDByThread[threadId],
           let cachedIndex = findMessageIndex(threadId: threadId, messageId: cachedMessageID),
           messages.indices.contains(cachedIndex) {
            for index in messages[cachedIndex...].indices.reversed() {
                let candidate = messages[index]
                guard candidate.role == .assistant,
                      hasRenderableAssistantOutputText(candidate.text) else {
                    continue
                }
                latestAssistantOutputByThread[threadId] = candidate.text
                latestAssistantMessageIDByThread[threadId] = candidate.id
                return candidate.text
            }
        }

        let latestAssistant = messages
            .last(where: { $0.role == .assistant && hasRenderableAssistantOutputText($0.text) })
        let latestAssistantText = latestAssistant?.text ?? ""
        latestAssistantOutputByThread[threadId] = latestAssistantText
        latestAssistantMessageIDByThread[threadId] = latestAssistant?.id
        return latestAssistantText
    }

    // Streaming calls hit this on every delta; avoid allocating a trimmed copy for normal prose.
    func hasRenderableAssistantOutputText(_ text: String) -> Bool {
        guard let first = text.first else {
            return false
        }
        if !first.isWhitespace {
            return true
        }
        return text.contains { !$0.isWhitespace }
    }

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

    // Late activity notifications can arrive after turn/completed.
    // Keep thinking rows in streaming mode only while the turn is still active.
    func isTurnActiveForThinkingActivity(threadId: String, turnId: String?) -> Bool {
        if let turnId, !turnId.isEmpty {
            if activeTurnIdByThread[threadId] == turnId {
                return true
            }
            return activeTurnIdByThread[threadId] == nil && runningThreadIDs.contains(threadId)
        }
        return activeTurnIdByThread[threadId] != nil || runningThreadIDs.contains(threadId)
    }

    func thinkingActivityTargetIndex(in messages: [CodexMessage], turnId: String?) -> Int? {
        messages.indices.reversed().first { index in
            let candidate = messages[index]
            guard candidate.role == .system, candidate.kind == .thinking else {
                return false
            }

            if let turnId, !turnId.isEmpty {
                return candidate.turnId == turnId || candidate.turnId == nil
            }

            return candidate.isStreaming
        }
    }

    // Avoids temporary array allocations from split/map when deduping activity lines.
    func containsCaseInsensitiveLine(_ candidateLine: String, in text: String) -> Bool {
        var found = false
        text.enumerateLines { line, stop in
            if line
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .caseInsensitiveCompare(candidateLine) == .orderedSame {
                found = true
                stop = true
            }
        }
        return found
    }

    func appendMessage(_ message: CodexMessage) {
        var normalizedMessage = message
        if isApplyingReplayedBridgeEvent {
            normalizedMessage.isStreaming = false
        }
        normalizedMessage.proposedPlan = derivedProposedPlan(for: normalizedMessage)
        if normalizedMessage.isStreaming {
            // Keep sidebar run state independent from timeline scanning cost.
            markThreadAsRunning(normalizedMessage.threadId)
        }
        if normalizedMessage.role == .assistant,
           let existingIndex = messagesByThread[message.threadId]?.firstIndex(where: { $0.id == normalizedMessage.id }),
           let existingMessage = messagesByThread[message.threadId]?[existingIndex] {
            let activeThreadIDs = Set(activeTurnIdByThread.keys)
            let merged = Self.reconcileExistingMessage(
                existingMessage,
                with: normalizedMessage,
                activeThreadIDs: activeThreadIDs,
                runningThreadIDs: runningThreadIDs
            )
            messagesByThread[message.threadId]?[existingIndex] = merged
            persistMessages()
            updateCurrentOutput(for: message.threadId)
            return
        }
        messagesByThread[message.threadId, default: []].append(normalizedMessage)
        messagesByThread[message.threadId]?.sort(by: { $0.orderIndex < $1.orderIndex })
        persistMessages()
        updateCurrentOutput(for: message.threadId)
    }

    func refreshDerivedPlanMetadata(threadId: String, messageIndex: Int) {
        guard let message = messagesByThread[threadId]?[messageIndex] else {
            return
        }

        messagesByThread[threadId]?[messageIndex].proposedPlan = derivedProposedPlan(for: message)
    }

    func refreshDerivedPlanMetadata(in messages: inout [CodexMessage], index: Int) {
        guard messages.indices.contains(index) else {
            return
        }

        messages[index].proposedPlan = derivedProposedPlan(for: messages[index])
    }

    private func derivedProposedPlan(for message: CodexMessage) -> CodexProposedPlan? {
        if message.role == .system && message.kind == .plan {
            guard let presentation = message.resolvedPlanPresentation,
                  presentation == .resultCompletedItem || presentation == .resultReady else {
                return nil
            }

            return CodexProposedPlanParser.parsePlanItem(from: message.text)
        }

        return CodexProposedPlanParser.parse(from: message.text)
    }

    func findMessageIndex(threadId: String, messageId: String) -> Int? {
        guard let messages = messagesByThread[threadId] else {
            return nil
        }

        if let cachedIndex = messageIndexCacheByThread[threadId]?[messageId],
           messages.indices.contains(cachedIndex),
           messages[cachedIndex].id == messageId {
            return cachedIndex
        }

        let rebuiltIndex = Dictionary(
            uniqueKeysWithValues: messages.enumerated().map { ($0.element.id, $0.offset) }
        )
        messageIndexCacheByThread[threadId] = rebuiltIndex
        return rebuiltIndex[messageId]
    }

    // Reuses a caller-provided index when still valid, otherwise falls back to the cached lookup map.
    func resolvedMessageIndex(
        threadId: String,
        messageId: String,
        preferredIndex: Int?,
        in messages: [CodexMessage]
    ) -> Int? {
        if let preferredIndex,
           messages.indices.contains(preferredIndex),
           messages[preferredIndex].id == messageId {
            return preferredIndex
        }

        return findMessageIndex(threadId: threadId, messageId: messageId)
    }

    func findLatestPlanMessageIndex(
        threadId: String,
        turnId: String?,
        itemId: String?,
        planPresentation: CodexPlanPresentation
    ) -> Int? {
        if let itemId, !itemId.isEmpty {
            if let directIndex = messagesByThread[threadId]?.indices.reversed().first(where: { index in
                let candidate = messagesByThread[threadId]?[index]
                return candidate?.role == .system
                    && candidate?.kind == .plan
                    && candidate?.itemId == itemId
            }) {
                return directIndex
            }
        }

        if let turnId, !turnId.isEmpty {
            return messagesByThread[threadId]?.indices.reversed().first(where: { index in
                let candidate = messagesByThread[threadId]?[index]
                return candidate?.role == .system
                    && candidate?.kind == .plan
                    && candidate?.turnId == turnId
                    && candidate?.resolvedPlanPresentation == planPresentation
            })
        }

        return messagesByThread[threadId]?.indices.reversed().first(where: { index in
            let candidate = messagesByThread[threadId]?[index]
            return candidate?.role == .system
                && candidate?.kind == .plan
                && candidate?.resolvedPlanPresentation == planPresentation
        })
    }

    func resolvedPlanPresentation(
        requested: CodexPlanPresentation,
        turnId: String?,
        threadId: String
    ) -> CodexPlanPresentation {
        guard requested == .resultCompletedItem else {
            return requested
        }

        switch turnTerminalState(for: turnId, threadId: threadId) {
        case .completed:
            return .resultReady
        case .failed, .stopped:
            return .resultClosed
        case nil:
            return .resultCompletedItem
        }
    }

    func findLatestSubagentActionMessageIndex(threadId: String, turnId: String?, itemId: String?) -> Int? {
        if let itemId, !itemId.isEmpty {
            if let directIndex = messagesByThread[threadId]?.indices.reversed().first(where: { index in
                let candidate = messagesByThread[threadId]?[index]
                return candidate?.role == .system
                    && candidate?.kind == .subagentAction
                    && candidate?.itemId == itemId
            }) {
                return directIndex
            }
        }

        if let turnId, !turnId.isEmpty {
            return messagesByThread[threadId]?.indices.reversed().first(where: { index in
                let candidate = messagesByThread[threadId]?[index]
                return candidate?.role == .system
                    && candidate?.kind == .subagentAction
                    && candidate?.turnId == turnId
            })
        }

        return messagesByThread[threadId]?.indices.reversed().first(where: { index in
            let candidate = messagesByThread[threadId]?[index]
            return candidate?.role == .system && candidate?.kind == .subagentAction
        })
    }

    func ensureStreamingAssistantMessage(
        threadId: String,
        turnId: String,
        itemId: String?,
        assistantPhase: String? = nil,
        promoteTurnFallback: Bool = true,
        createStreamingMessage: Bool = true
    ) -> String? {
        let turnStreamingKey = streamingMessageKey(threadId: threadId, turnId: turnId)
        let normalizedItemId = normalizedStreamingItemID(itemId)
        let normalizedPhase = normalizedAssistantPhase(assistantPhase)
        let itemStreamingKey = normalizedItemId.map {
            assistantStreamingMessageKey(threadId: threadId, turnId: turnId, itemId: $0)
        }

        if let itemStreamingKey,
           let messageID = streamingAssistantMessageByItemKey[itemStreamingKey],
           let messageIndex = findMessageIndex(threadId: threadId, messageId: messageID) {
            // Keep turn-scoped fallback deltas anchored to the newest assistant item.
            // Late updates for older item ids should patch that item only.
            applyAssistantPhaseIfNeeded(
                threadId: threadId,
                messageIndex: messageIndex,
                assistantPhase: normalizedPhase
            )
            return messageID
        }

        if let turnMessageID = streamingAssistantFallbackMessageByTurnID[turnStreamingKey],
           let messageIndex = findMessageIndex(threadId: threadId, messageId: turnMessageID) {
            if let normalizedItemId {
                let existingItemId = normalizedStreamingItemID(messagesByThread[threadId]?[messageIndex].itemId)

                if existingItemId == nil {
                    messagesByThread[threadId]?[messageIndex].itemId = normalizedItemId
                    applyAssistantPhaseIfNeeded(
                        threadId: threadId,
                        messageIndex: messageIndex,
                        assistantPhase: normalizedPhase
                    )
                    if let itemStreamingKey {
                        streamingAssistantMessageByItemKey[itemStreamingKey] = turnMessageID
                    }
                    persistMessages()
                    updateCurrentOutput(for: threadId)
                    return turnMessageID
                }

                if existingItemId == normalizedItemId {
                    applyAssistantPhaseIfNeeded(
                        threadId: threadId,
                        messageIndex: messageIndex,
                        assistantPhase: normalizedPhase
                    )
                    if let itemStreamingKey {
                        streamingAssistantMessageByItemKey[itemStreamingKey] = turnMessageID
                    }
                    return turnMessageID
                }

                guard promoteTurnFallback else {
                    return createAssistantMessage(
                        threadId: threadId,
                        turnId: turnId,
                        itemId: normalizedItemId,
                        assistantPhase: normalizedPhase,
                        isStreaming: createStreamingMessage,
                        promoteTurnFallback: false
                    )
                }

                // New assistant item in the same turn: close previous row and start a new bubble.
                messagesByThread[threadId]?[messageIndex].isStreaming = false
                streamingAssistantFallbackMessageByTurnID.removeValue(forKey: turnStreamingKey)
                persistMessages()
                updateCurrentOutput(for: threadId)

                beginAssistantMessage(
                    threadId: threadId,
                    turnId: turnId,
                    itemId: normalizedItemId,
                    assistantPhase: normalizedPhase
                )
                if let itemStreamingKey,
                   let messageID = streamingAssistantMessageByItemKey[itemStreamingKey] {
                    streamingAssistantFallbackMessageByTurnID[turnStreamingKey] = messageID
                    return messageID
                }
                return streamingAssistantFallbackMessageByTurnID[turnStreamingKey]
            }

            return turnMessageID
        } else {
            streamingAssistantFallbackMessageByTurnID.removeValue(forKey: turnStreamingKey)
        }

        let messageID = createAssistantMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: normalizedItemId,
            assistantPhase: normalizedPhase,
            isStreaming: createStreamingMessage,
            promoteTurnFallback: promoteTurnFallback
        )
        return messageID
    }

    // Creates one assistant bubble and records item/turn lookup keys without letting
    // late item-specific completions overwrite the active turn fallback.
    func createAssistantMessage(
        threadId: String,
        turnId: String,
        itemId: String?,
        assistantPhase: String? = nil,
        isStreaming: Bool,
        promoteTurnFallback: Bool
    ) -> String {
        let effectiveIsStreaming = isStreaming && !isApplyingReplayedBridgeEvent
        let turnStreamingKey = streamingMessageKey(threadId: threadId, turnId: turnId)
        let itemStreamingKey = itemId.map {
            assistantStreamingMessageKey(threadId: threadId, turnId: turnId, itemId: $0)
        }
        let message = CodexMessage(
            id: Self.stableAssistantMessageID(threadId: threadId, turnId: turnId, itemId: itemId) ?? UUID().uuidString,
            threadId: threadId,
            role: .assistant,
            assistantPhase: normalizedAssistantPhase(assistantPhase),
            text: "",
            turnId: turnId,
            itemId: itemId,
            isStreaming: effectiveIsStreaming
        )

        threadIdByTurnID[turnId] = threadId
        if promoteTurnFallback {
            streamingAssistantFallbackMessageByTurnID[turnStreamingKey] = message.id
        }
        if let itemStreamingKey {
            streamingAssistantMessageByItemKey[itemStreamingKey] = message.id
        }
        appendMessage(message)
        return message.id
    }

    // Clears assistant stream lookup state for one turn and closes each touched bubble once.
    func clearAssistantStreamingState(threadId: String, turnId: String) {
        let turnStreamingKey = streamingMessageKey(threadId: threadId, turnId: turnId)
        let itemStreamingPrefix = "\(turnStreamingKey)|item:"

        var closedMessageIDs: Set<String> = []
        if let messageID = streamingAssistantFallbackMessageByTurnID.removeValue(forKey: turnStreamingKey) {
            closedMessageIDs.insert(messageID)
            if let messageIndex = findMessageIndex(threadId: threadId, messageId: messageID) {
                messagesByThread[threadId]?[messageIndex].isStreaming = false
            }
        }

        let itemKeysToClear = streamingAssistantMessageByItemKey.keys.filter { key in
            key.hasPrefix(itemStreamingPrefix)
        }
        for key in itemKeysToClear {
            guard let messageID = streamingAssistantMessageByItemKey.removeValue(forKey: key) else { continue }
            guard closedMessageIDs.insert(messageID).inserted else {
                continue
            }
            if let messageIndex = findMessageIndex(threadId: threadId, messageId: messageID) {
                messagesByThread[threadId]?[messageIndex].isStreaming = false
            }
        }
    }

    func streamingMessageKey(threadId: String, turnId: String) -> String {
        "\(threadId)|\(turnId)"
    }

    func assistantStreamingMessageKey(threadId: String, turnId: String, itemId: String) -> String {
        "\(streamingMessageKey(threadId: threadId, turnId: turnId))|item:\(itemId)"
    }

    func completedAssistantMessageIndices(threadId: String, turnId: String) -> [Int] {
        guard let threadMessages = messagesByThread[threadId] else {
            return []
        }

        return threadMessages.indices.filter { index in
            let candidate = threadMessages[index]
            return candidate.role == .assistant
                && candidate.turnId == turnId
                && !candidate.isStreaming
        }
    }

    // Identifier-less completion events can arrive after the next turn already became active.
    // If they exactly match a closed prior assistant row, treat them as late replay.
    func shouldIgnoreIdentifierlessAssistantCompletion(
        threadId: String,
        text: String,
        activeTurnId: String?,
        now: Date
    ) -> Bool {
        if let fingerprint = assistantCompletionFingerprintByThread[threadId],
           fingerprint.text == text,
           now.timeIntervalSince(fingerprint.timestamp) <= 45 {
            return true
        }

        guard let activeTurnId = normalizedStreamingItemID(activeTurnId),
              let threadMessages = messagesByThread[threadId] else {
            return false
        }

        let activeTurnHasSameAssistant = threadMessages.contains { candidate in
            candidate.role == .assistant
                && candidate.turnId == activeTurnId
                && Self.normalizedMessageText(candidate.text) == text
        }
        if activeTurnHasSameAssistant {
            return false
        }

        guard let latestActiveUserOrder = threadMessages
            .filter({ $0.role == .user && $0.turnId == activeTurnId })
            .map(\.orderIndex)
            .max() else {
            return false
        }

        return threadMessages.contains { candidate in
            candidate.role == .assistant
                && candidate.turnId != activeTurnId
                && !candidate.isStreaming
                && candidate.orderIndex < latestActiveUserOrder
                && Self.normalizedMessageText(candidate.text) == text
        }
    }

    func streamingItemMessageKey(threadId: String, itemId: String) -> String {
        "\(threadId)|item:\(itemId)"
    }

    func normalizedStreamingItemID(_ rawValue: String?) -> String? {
        guard let rawValue else {
            return nil
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func syntheticStreamingItemId(turnId: String, kind: CodexMessageKind) -> String {
        CodexSyntheticIdentifiers.placeholderItemID(turnId: turnId, kind: kind)
    }

    func syntheticSubagentActionItemIdPrefix(turnId: String) -> String {
        CodexSyntheticIdentifiers.placeholderItemID(turnId: turnId, kind: .subagentAction) + "|action:"
    }

    func streamingPlaceholderText(for kind: CodexMessageKind) -> String {
        switch kind {
        case .thinking:
            return ""
        case .toolActivity:
            return "Working…"
        case .fileChange:
            return "Applying file changes..."
        case .commandExecution:
            return "Running command"
        case .subagentAction:
            return "Coordinating agents..."
        case .plan:
            return "Planning..."
        case .userInputPrompt:
            return "Waiting for input..."
        case .chat:
            return "Updating..."
        }
    }

    func isStreamingPlaceholder(_ text: String, for kind: CodexMessageKind) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .caseInsensitiveCompare(streamingPlaceholderText(for: kind)) == .orderedSame
    }

    // Prunes only empty/placeholder thinking rows, preserving real reasoning text.
    func shouldPruneThinkingRowAfterTurnCompletion(_ message: CodexMessage) -> Bool {
        let trimmedText = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty else {
            return true
        }

        if isStreamingPlaceholder(trimmedText, for: .thinking) {
            return true
        }

        let withoutPrefix = trimmedText.replacingOccurrences(
            of: #"(?is)^\s*thinking(?:\.\.\.)?\s*"#,
            with: "",
            options: .regularExpression
        )
        return withoutPrefix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // Supports both incremental deltas ("+ token") and cumulative snapshots
    // ("full content so far"), while discarding duplicate chunks.
    func mergeAssistantDelta(existingText: String, incomingDelta: String) -> String {
        if existingText.isEmpty {
            return incomingDelta
        }

        if incomingDelta == existingText {
            return existingText
        }

        if existingText.hasSuffix(incomingDelta) {
            return existingText
        }

        if incomingDelta.count > existingText.count, incomingDelta.hasPrefix(existingText) {
            return incomingDelta
        }

        if existingText.count > incomingDelta.count, existingText.hasPrefix(incomingDelta) {
            return existingText
        }

        // Preserve reconnect/replay correctness by checking the full overlap window.
        let maxOverlap = min(existingText.count, incomingDelta.count)
        if maxOverlap > 0 {
            for overlap in stride(from: maxOverlap, through: 1, by: -1) {
                if existingText.suffix(overlap) == incomingDelta.prefix(overlap) {
                    return existingText + incomingDelta.dropFirst(overlap)
                }
            }
        }

        return existingText + incomingDelta
    }

}
