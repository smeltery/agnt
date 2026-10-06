// FILE: CodexService+HistoryMerge.swift
// Purpose: Merges canonical thread history into local timeline state.
// Layer: Service

import Foundation

extension CodexService {
    func mergeHistoryMessages(_ existing: [CodexMessage], _ history: [CodexMessage]) -> [CodexMessage] {
        let activeThreadIDs = Set(activeTurnIdByThread.keys)
        let runningIDs = runningThreadIDs
        return (try? Self.mergeHistoryMessages(existing, history, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningIDs)) ?? existing
    }

    nonisolated static func mergeHistoryMessages(
        _ existing: [CodexMessage],
        _ history: [CodexMessage],
        activeThreadIDs: Set<String>,
        runningThreadIDs: Set<String>
    ) throws -> [CodexMessage] {
        if existing.isEmpty {
            // History messages arrive in server order; assign sequential orderIndex values
            // so that the stable sort preserves server-provided chronology.
            var sorted = AssistantReplayDeduper.dedupeBlockReplays(
                in: history.sorted(by: { $0.createdAt < $1.createdAt })
            )
            for index in sorted.indices {
                sorted[index].orderIndex = CodexMessageOrderCounter.next()
            }
            return historyMessagesMergingGeneratedImageArtifacts(sorted)
        }

        var merged = discardStaleFileChangeRowsSupersededByCanonicalToolActivity(existing, history: history)

        let assistantHistoryCountByTurn = Dictionary(
            grouping: history.filter { $0.role == .assistant }
        ) { $0.turnId ?? "" }
        .mapValues(\.count)
        var processedHistoryMessages = 0

        for message in history {
            processedHistoryMessages &+= 1
            if processedHistoryMessages.isMultiple(of: RunningThreadHistoryCatchupPolicy.cancellationCheckInterval),
               Task.isCancelled {
                throw CancellationError()
            }

            if message.role == .assistant,
               let turnId = message.turnId, !turnId.isEmpty,
               let index = uniqueAssistantHistoryTextMergeIndex(
                   in: merged,
                   message: message,
                   turnId: turnId
               ) {
                merged[index] = reconcileExistingMessage(merged[index], with: message, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningThreadIDs)
                continue
            }

            // Forced resume snapshots can materialize a real assistant itemId after the
            // live row was already created with provisional identity. Only merge when
            // the identity is compatible, otherwise stale history can pollute the live row.
            if message.role == .assistant,
               let turnId = message.turnId, !turnId.isEmpty,
               (activeThreadIDs.contains(message.threadId) || runningThreadIDs.contains(message.threadId)),
               let index = merged.lastIndex(where: { candidate in
                   candidate.role == .assistant
                       && candidate.turnId == turnId
                       && candidate.isStreaming
                       && assistantHistoryIdentityAllowsRunningReconcile(
                           localMessage: candidate,
                           serverMessage: message
                       )
               }) {
                merged[index] = reconcileExistingMessage(merged[index], with: message, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningThreadIDs)
                continue
            }

            // Running turn snapshots without item identity are too ambiguous to append
            // beside a live item-scoped assistant row.
            if message.role == .assistant,
               let turnId = message.turnId, !turnId.isEmpty,
               normalizedHistoryIdentifier(message.itemId) == nil,
               (activeThreadIDs.contains(message.threadId) || runningThreadIDs.contains(message.threadId)),
               merged.contains(where: { candidate in
                   candidate.role == .assistant
                       && candidate.turnId == turnId
                       && candidate.isStreaming
                       && hasStableAssistantIdentity(candidate.itemId)
               }) {
                continue
            }

            let threadIsStillActive = activeThreadIDs.contains(message.threadId)
                || runningThreadIDs.contains(message.threadId)

            // After a turn is fully closed, thread/read can return the same single assistant
            // reply with canonical text or a different stable item id. Reconcile that row
            // instead of appending a second final bubble.
            if message.role == .assistant,
               let turnId = message.turnId, !turnId.isEmpty,
               !threadIsStillActive,
               assistantHistoryCountByTurn[turnId] == 1 {
                let candidateIndices = merged.indices.filter { index in
                    let candidate = merged[index]
                    return candidate.role == .assistant
                        && candidate.turnId == turnId
                        && !candidate.isStreaming
                }

                if candidateIndices.count == 1,
                   let index = candidateIndices.last {
                    if shouldReplaceClosedAssistantMessage(
                        merged[index],
                        with: message
                    ) {
                        merged[index] = reconcileExistingMessage(
                            merged[index],
                            with: message,
                            activeThreadIDs: activeThreadIDs,
                            runningThreadIDs: runningThreadIDs
                        )
                    }
                    continue
                }
            }

            if message.role == .user,
               let turnId = message.turnId, !turnId.isEmpty,
               let index = uniqueUserHistoryMergeIndex(
                   in: merged,
                   message: message,
                   turnId: turnId
               ) {
                merged[index] = reconcileExistingMessage(merged[index], with: message, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningThreadIDs)
                continue
            }

            // Reconcile turn-scoped thinking snapshots even when the streamed row
            // carries a synthetic itemId (e.g. "turn:ABC|kind:thinking") that differs
            // from the server's real itemId or nil.
            if message.role == .system,
               message.kind == .thinking,
               let turnId = message.turnId, !turnId.isEmpty,
               let index = merged.lastIndex(where: { candidate in
                   candidate.role == .system
                       && candidate.kind == .thinking
                       && candidate.turnId == turnId
               }) {
                merged[index] = reconcileExistingMessage(merged[index], with: message, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningThreadIDs)
                continue
            }

            // Reconcile turn-scoped file change items even when the streamed row
            // has a synthetic itemId that differs from the server's real one.
            if message.role == .system,
               message.kind == .fileChange,
               let turnId = message.turnId, !turnId.isEmpty {
                let turnBlockRange = Self.contiguousTurnBlockRange(in: merged, turnId: turnId)
                if let index = merged.indices.last(where: { candidateIndex in
                    let candidate = merged[candidateIndex]
                    guard candidate.role == .system,
                          candidate.kind == .fileChange else {
                        return false
                    }
                    if candidate.turnId == turnId {
                        return true
                    }
                    guard candidate.turnId == nil else {
                        return false
                    }
                    return Self.turnlessFileChangeRowIsClaimable(
                        in: merged,
                        candidateIndex: candidateIndex,
                        turnId: turnId,
                        turnBlockRange: turnBlockRange
                    )
                }) {
                    merged[index] = reconcileExistingMessage(merged[index], with: message, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningThreadIDs)
                    continue
                }
            }

            // Rebind generic tool rows when a live synthetic row gets a real history item id later.
            if message.role == .system,
               message.kind == .toolActivity,
               let turnId = message.turnId, !turnId.isEmpty {
                let candidateIndices = merged.indices.filter { index in
                    let candidate = merged[index]
                    return candidate.role == .system
                        && candidate.kind == .toolActivity
                        && candidate.turnId == turnId
                }

                if let itemIndex = candidateIndices.last(where: { index in
                    let candidateItemId = normalizedHistoryIdentifier(merged[index].itemId)
                    let incomingItemId = normalizedHistoryIdentifier(message.itemId)
                    return candidateItemId != nil && candidateItemId == incomingItemId
                }) {
                    merged[itemIndex] = reconcileExistingMessage(merged[itemIndex], with: message, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningThreadIDs)
                    continue
                }

                if candidateIndices.count == 1,
                   let index = candidateIndices.last,
                   isProvisionalToolActivityRow(merged[index]),
                   shouldReconcileToolActivityRow(
                    merged[index],
                    with: message,
                    requiresExactText: false
                   ) {
                    merged[index] = reconcileExistingMessage(merged[index], with: message, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningThreadIDs)
                    continue
                }

                if candidateIndices.count > 1 {
                    let reconcilableIndices = candidateIndices.filter { index in
                        shouldReconcileToolActivityRow(
                            merged[index],
                            with: message,
                            requiresExactText: true
                        )
                    }

                    if reconcilableIndices.count == 1,
                       let index = reconcilableIndices.last {
                        merged[index] = reconcileExistingMessage(merged[index], with: message, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningThreadIDs)
                        continue
                    }
                }
            }

            // Dedupes command rows when incoming/history command formatting differs only by shell quoting.
            if message.role == .system,
               message.kind == .commandExecution,
               let turnId = message.turnId, !turnId.isEmpty,
               let incomingCommandKey = normalizedCommandExecutionPreviewKey(from: message.text),
               let index = merged.lastIndex(where: { candidate in
                   guard candidate.role == .system,
                         candidate.kind == .commandExecution,
                         candidate.turnId == turnId,
                         let candidateCommandKey = normalizedCommandExecutionPreviewKey(from: candidate.text) else {
                       return false
                   }
                   return candidateCommandKey == incomingCommandKey
               }) {
                merged[index] = reconcileExistingMessage(merged[index], with: message, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningThreadIDs)
                continue
            }

            // Reconcile turn-scoped command execution items by turnId when text-based
            // dedup above did not match (e.g. synthetic vs real itemId).
            if message.role == .system,
               message.kind == .commandExecution,
               let turnId = message.turnId, !turnId.isEmpty,
               let index = merged.lastIndex(where: { candidate in
                   candidate.role == .system
                       && candidate.kind == .commandExecution
                       && candidate.turnId == turnId
               }) {
                merged[index] = reconcileExistingMessage(merged[index], with: message, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningThreadIDs)
                continue
            }

            let key = historyMessageKey(for: message)
            if let index = merged.firstIndex(where: { historyMessageKey(for: $0) == key }) {
                merged[index] = reconcileExistingMessage(merged[index], with: message, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningThreadIDs)
                continue
            }

            if message.role == .user {
                let fallbackCandidates = fallbackUserHistoryMergeIndices(
                    in: merged,
                    message: message
                )
                if fallbackCandidates.count == 1,
                   let index = fallbackCandidates.first {
                    merged[index] = reconcileExistingMessage(
                        merged[index],
                        with: message,
                        activeThreadIDs: activeThreadIDs,
                        runningThreadIDs: runningThreadIDs
                    )
                    continue
                }

                // Identifier-less history rows with epoch timestamps are already
                // represented locally; appending them creates the visible 1:00 echo.
                if hasFallbackHistoryTimestamp(message.createdAt),
                   !fallbackCandidates.isEmpty {
                    continue
                }
            }

            if message.role == .user,
               let pendingIndex = uniquePendingUserHistoryMergeIndex(
                   in: merged,
                   message: message
               ) {
                merged[pendingIndex] = reconcileExistingMessage(merged[pendingIndex], with: message, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningThreadIDs)
                continue
            }

            if message.role == .assistant, message.asyncUserInput == nil,
               AssistantReplayDeduper.isReplayMessage(
                   in: merged,
                   threadId: message.threadId,
                   turnId: message.turnId,
                   text: message.text
               ) {
                continue
            }

            merged.append(message)
        }

        merged.sort(by: { $0.orderIndex < $1.orderIndex })
        // Reapply local answer state after canonical item replacement, then bind
        // native/Desktop answers by question identity.
        let localInputs = Dictionary(existing.compactMap { message in
            message.itemId.flatMap { id in message.asyncUserInput.map { (id, $0) } }
        }, uniquingKeysWith: { _, latest in latest })
        let canonicalInputs = Dictionary(history.compactMap { message in
            message.itemId.flatMap { id in message.asyncUserInput.map { (id, $0) } }
        }, uniquingKeysWith: { _, latest in latest })
        for index in merged.indices {
            if let id = merged[index].itemId, let incoming = canonicalInputs[id] ?? merged[index].asyncUserInput {
                merged[index].asyncUserInput = .merge(local: localInputs[id], incoming: incoming)
            }
        }
        CodexAsyncUserInputProjection.reconcile(&merged)
        return historyMessagesMergingGeneratedImageArtifacts(merged)
    }

    // Keeps running-thread reopen bounded to the recent transcript tail so A/B switching
    // does not repeatedly reconcile the entire chat while output is still streaming.
    nonisolated static func mergeRecentHistoryWindow(
        _ existing: [CodexMessage],
        _ history: [CodexMessage],
        activeThreadIDs: Set<String>,
        runningThreadIDs: Set<String>,
        windowSize: Int
    ) throws -> [CodexMessage] {
        let normalizedWindowSize = max(1, windowSize)
        guard !existing.isEmpty,
              shouldPreferRecentHistoryWindow(
                existingCount: existing.count,
                historyCount: history.count,
                windowSize: normalizedWindowSize
              ) else {
            return try mergeHistoryMessages(
                existing,
                history,
                activeThreadIDs: activeThreadIDs,
                runningThreadIDs: runningThreadIDs
            )
        }

        let prefixCount = max(existing.count - normalizedWindowSize, 0)
        let stablePrefix = Array(existing.prefix(prefixCount))
        let recentExisting = Array(existing.suffix(normalizedWindowSize))
        let recentHistory = Array(history.suffix(normalizedWindowSize))
        let mergedTail = try mergeHistoryMessages(
            recentExisting,
            recentHistory,
            activeThreadIDs: activeThreadIDs,
            runningThreadIDs: runningThreadIDs
        )
        let boundaryOverlapKeys = Set(stablePrefix.suffix(32).map(Self.historyMessageKey))
        let filteredTail = mergedTail.filter { !boundaryOverlapKeys.contains(historyMessageKey(for: $0)) }
        return stablePrefix + filteredTail
    }

    func historyTurnID(from turnObject: [String: JSONValue]) -> String? {
        firstNonEmptyString([
            turnObject["id"]?.stringValue,
            turnObject["turnId"]?.stringValue,
            turnObject["turn_id"]?.stringValue,
        ])
    }

    func reconcileExistingMessage(_ localMessage: CodexMessage, with serverMessage: CodexMessage) -> CodexMessage {
        let activeThreadIDs = Set(activeTurnIdByThread.keys)
        let runningIDs = runningThreadIDs
        return Self.reconcileExistingMessage(localMessage, with: serverMessage, activeThreadIDs: activeThreadIDs, runningThreadIDs: runningIDs)
    }

    nonisolated static func reconcileExistingMessage(
        _ localMessage: CodexMessage,
        with serverMessage: CodexMessage,
        activeThreadIDs: Set<String>,
        runningThreadIDs: Set<String>
    ) -> CodexMessage {
        var value = localMessage
        let threadIsActive = activeThreadIDs.contains(localMessage.threadId) || runningThreadIDs.contains(localMessage.threadId)
        let preservesRunningPresentation = threadIsActive
            && (
                localMessage.turnId == nil
                || serverMessage.turnId == nil
                || localMessage.turnId == serverMessage.turnId
            )

        if value.deliveryState == .pending {
            value.deliveryState = .confirmed
        }

        if CodexTimestampParser.isTrustworthyServerDate(serverMessage.createdAt),
           abs(value.createdAt.timeIntervalSince(serverMessage.createdAt)) > 0.5 {
            value.createdAt = serverMessage.createdAt
        }

        if value.turnId == nil {
            value.turnId = serverMessage.turnId
        }
        let localItemId = normalizedHistoryIdentifier(value.itemId)
        let serverItemId = normalizedHistoryIdentifier(serverMessage.itemId)
        let shouldAttachMissingItemId = localItemId == nil
        let shouldRebindRunningAssistantItem = preservesRunningPresentation
            && value.role == .assistant
            && localMessage.isStreaming
            && serverItemId != nil
            && localItemId != serverItemId
            && !hasStableAssistantIdentity(localItemId)
        if shouldAttachMissingItemId
            || shouldRebindRunningAssistantItem
            || (
                value.role == .system
                    && value.kind == .toolActivity
                    && serverItemId != nil
                    && !hasStableToolActivityIdentity(localItemId)
                    && localItemId != serverItemId
            ) {
            value.itemId = serverItemId
        }
        if value.kind == .chat && serverMessage.kind != .chat {
            value.kind = serverMessage.kind
        }
        if var serverReview = serverMessage.autoApprovalReview {
            if let localReview = localMessage.autoApprovalReview {
                serverReview.retryApproved = localReview.retryApproved
                if localReview.retryApproved || localReview.retryUnavailableReason != nil {
                    serverReview.retryUnavailableReason = localReview.retryUnavailableReason
                }
            }
            value.autoApprovalReview = serverReview
            value.text = serverMessage.text
        }
        if value.attachments.isEmpty && !serverMessage.attachments.isEmpty {
            value.attachments = serverMessage.attachments
        }
        if value.role == .user {
            if value.fileMentions.isEmpty && !serverMessage.fileMentions.isEmpty {
                value.fileMentions = serverMessage.fileMentions
            }
            if value.skillMentions.isEmpty && !serverMessage.skillMentions.isEmpty {
                value.skillMentions = serverMessage.skillMentions
            }
            if value.pluginMentions.isEmpty && !serverMessage.pluginMentions.isEmpty {
                value.pluginMentions = serverMessage.pluginMentions
            }
            if shouldPreferIncomingUserPresentationText(existing: value, incoming: serverMessage) {
                value.text = serverMessage.text
            }
        }

        if value.role == .assistant {
            let serverText = normalizedMessageText(serverMessage.text)
            if !serverText.isEmpty {
                if preservesRunningPresentation {
                    if assistantHistoryIdentityAllowsRunningReconcile(
                        localMessage: localMessage,
                        serverMessage: serverMessage
                    ) {
                        value.text = mergeAssistantRunningSnapshotText(
                            existingText: value.text,
                            incomingText: serverMessage.text
                        )
                    }
                } else {
                    value.text = serverMessage.text
                }
            }
            value.isStreaming = preservesRunningPresentation
                ? (localMessage.isStreaming || serverMessage.isStreaming || runningThreadIDs.contains(localMessage.threadId))
                : false
        } else if value.role == .system {
            let serverText = normalizedMessageText(serverMessage.text)
            if !serverText.isEmpty {
                value.text = preservesRunningPresentation && localMessage.isStreaming
                    ? mergeStreamingSnapshotText(existingText: value.text, incomingText: serverMessage.text)
                    : serverMessage.text
            }
            value.isStreaming = preservesRunningPresentation
                ? (localMessage.isStreaming || serverMessage.isStreaming || runningThreadIDs.contains(localMessage.threadId))
                : false
        }

        return value
    }
}
