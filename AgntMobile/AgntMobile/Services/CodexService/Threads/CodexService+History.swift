// FILE: CodexService+History.swift
// Purpose: Parses thread/read history payloads into normalized timeline messages.
// Layer: Service
// Exports: CodexService history parsing helpers
// Depends on: CodexMessage, JSONValue

import Foundation

extension CodexService {
    // Decodes app-server turn arrays into a chronological message timeline.
    func decodeMessagesFromThreadRead(threadId: String, threadObject: [String: JSONValue]) -> [CodexMessage] {
        let baseDate = decodeHistoryBaseDate(from: threadObject, threadId: threadId)
        let threadTimeZoneIdentifier = decodeHistoryTimeZoneIdentifier(from: threadObject)
        let turns = threadObject["turns"]?.arrayValue ?? []

        var offset: TimeInterval = 0
        var result: [CodexMessage] = []

        for turnValue in turns {
            guard let turnObject = turnValue.objectValue else { continue }
            let turnID = historyTurnID(from: turnObject)
            let turnTimestamp = decodeHistoryTimestamp(from: turnObject)
            let turnTimeZoneIdentifier = decodeHistoryTimeZoneIdentifier(from: turnObject)
                ?? threadTimeZoneIdentifier
            let turnCompleted = historyTurnTerminalState(turnObject) == .completed
            let items = turnObject["items"]?.arrayValue ?? []

            for itemValue in items {
                guard let itemObject = itemValue.objectValue,
                      let itemType = itemObject["type"]?.stringValue else {
                    continue
                }

                let syntheticTimestamp = (turnTimestamp ?? baseDate).addingTimeInterval(offset)
                let timestamp = decodeHistoryTimestamp(from: itemObject) ?? syntheticTimestamp
                let timeZoneIdentifier = decodeHistoryTimeZoneIdentifier(from: itemObject)
                    ?? turnTimeZoneIdentifier
                offset += 0.001
                let itemID = itemObject["id"]?.stringValue
                let decodedText = decodeItemText(from: itemObject)
                let skillMentions = decodeHistorySkillMentions(from: itemObject)
                let pluginMentions = decodeHistoryPluginMentions(from: itemObject)
                let imageAttachments = decodeImageAttachments(from: itemObject)

                switch normalizedItemType(itemType) {
                case "usermessage":
                    appendHistoryMessage(
                        to: &result,
                        role: .user,
                        text: decodedText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier,
                        skillMentions: skillMentions,
                        pluginMentions: pluginMentions,
                        attachments: imageAttachments
                    )

                case "agentmessage", "assistantmessage":
                    appendHistoryMessage(
                        to: &result,
                        role: .assistant,
                        kind: .chat,
                        assistantPhase: normalizedAssistantPhase(itemObject["phase"]?.stringValue),
                        text: decodedText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier,
                        attachments: imageAttachments
                    )

                case "message":
                    let role = itemObject["role"]?.stringValue?.lowercased() ?? ""
                    let mappedRole: CodexMessageRole = role.contains("user") ? .user : .assistant

                    appendHistoryMessage(
                        to: &result,
                        role: mappedRole,
                        kind: .chat,
                        assistantPhase: mappedRole == .assistant
                            ? normalizedAssistantPhase(itemObject["phase"]?.stringValue)
                            : nil,
                        text: decodedText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier,
                        skillMentions: mappedRole == .user ? skillMentions : [],
                        pluginMentions: mappedRole == .user ? pluginMentions : [],
                        attachments: imageAttachments
                    )

                case "imagegeneration", "imagegenerationcall", "imagegenerationend", "imageview":
                    guard let generatedImageText = decodeGeneratedImageMarkdown(from: itemObject) else {
                        continue
                    }
                    appendHistoryMessage(
                        to: &result,
                        role: .assistant,
                        kind: .chat,
                        text: generatedImageText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "reasoning":
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .thinking,
                        text: decodeReasoningItemText(from: itemObject),
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "filechange":
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .fileChange,
                        text: decodeFileChangeItemText(from: itemObject),
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "toolcall":
                    guard let decodedToolCall = decodeHistoryToolCallItem(from: itemObject) else { continue }
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: decodedToolCall.kind,
                        text: decodedToolCall.text,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "diff":
                    guard let decodedFileChangeText = decodeHistoryDiffItemText(from: itemObject) else { continue }
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .fileChange,
                        text: decodedFileChangeText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "commandexecution":
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .commandExecution,
                        text: decodeCommandExecutionItemText(from: itemObject),
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "enteredreviewmode":
                    let normalizedReviewLabel = decodeHistoryFirstString(
                        forAnyKey: ["review"],
                        in: .object(itemObject)
                    ) ?? "changes"
                    let message = "Reviewing \(normalizedReviewLabel)..."
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .commandExecution,
                        text: message,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "exitedreviewmode":
                    guard let reviewText = decodeHistoryFirstString(
                        forAnyKey: ["review"],
                        in: .object(itemObject)
                    ) else { continue }
                    appendHistoryMessage(
                        to: &result,
                        role: .assistant,
                        kind: .chat,
                        assistantPhase: normalizedAssistantPhase(itemObject["phase"]?.stringValue),
                        text: reviewText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "contextcompaction":
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .commandExecution,
                        text: "Context compacted",
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier
                    )

                case "plan", "todolist":
                    let decodedPlanState = decodePlanState(from: itemObject)
                    let decodedPlanText = decodePlanItemText(from: itemObject)
                    guard CodexPlanUpdateVisibilityPolicy.shouldApply(
                        text: decodedPlanText,
                        planState: decodedPlanState
                    ) else {
                        continue
                    }
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .plan,
                        text: decodedPlanText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier,
                        planState: finalizedHistoryPlanState(decodedPlanState, turnCompleted: turnCompleted),
                        planPresentation: itemID == nil
                            ? .progress
                            : (turnCompleted ? .resultReady : .resultClosed)
                    )

                case let collabType where collabType == "collabagenttoolcall"
                    || collabType == "collabtoolcall"
                    || collabType.hasPrefix("collabagentspawn")
                    || collabType.hasPrefix("collabwaiting")
                    || collabType.hasPrefix("collabclose")
                    || collabType.hasPrefix("collabresume")
                    || collabType.hasPrefix("collabagentinteraction"):
                    guard let subagentAction = decodeSubagentActionItem(from: itemObject) else {
                        continue
                    }
                    appendHistoryMessage(
                        to: &result,
                        role: .system,
                        kind: .subagentAction,
                        text: subagentAction.summaryText,
                        threadId: threadId,
                        turnId: turnID,
                        itemId: itemID,
                        createdAt: timestamp,
                        timeZoneIdentifier: timeZoneIdentifier,
                        subagentAction: subagentAction
                    )

                default:
                    continue
                }
            }
        }

        return Self.historyMessagesMergingGeneratedImageArtifacts(result)
    }

    // Extracts persisted turn outcomes from canonical history so render grouping survives app relaunch.
    func decodeTurnTerminalStatesFromThreadRead(_ threadObject: [String: JSONValue]) -> [String: CodexTurnTerminalState] {
        let turns = threadObject["turns"]?.arrayValue ?? []
        var result: [String: CodexTurnTerminalState] = [:]

        for turnValue in turns {
            guard let turnObject = turnValue.objectValue,
                  let turnID = historyTurnID(from: turnObject),
                  !turnID.isEmpty,
                  let terminalState = historyTurnTerminalState(turnObject) else {
                continue
            }
            result[turnID] = terminalState
        }

        return result
    }

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

        var merged = existing
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

            if message.role == .assistant,
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

    nonisolated static func historyMessageKey(for message: CodexMessage) -> String {
        if let itemId = message.itemId, !itemId.isEmpty {
            return "item:\(message.role.rawValue):\(message.kind.rawValue):\(itemId)"
        }

        return [
            message.role.rawValue,
            message.turnId ?? "no-turn",
            message.role == .user ? userSemanticHistoryTextKey(for: message) : historyTextKey(for: message.text),
            attachmentSignature(for: message.attachments),
        ].joined(separator: "|")
    }

    nonisolated private static let identitylessUserHistoryEchoWindow: TimeInterval = 2

    nonisolated static func hasFallbackHistoryTimestamp(_ date: Date) -> Bool {
        !CodexTimestampParser.isTrustworthyServerDate(date)
    }

    nonisolated static func normalizedHistoryIdentifier(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    nonisolated static func isProvisionalHistoryTurnIdentifier(_ turnId: String?) -> Bool {
        guard let turnId = normalizedHistoryIdentifier(turnId) else {
            return false
        }
        return CodexSyntheticIdentifiers.isProjectedDesktopTurnID(turnId)
            || CodexSyntheticIdentifiers.isBridgeMintedTurnID(turnId)
    }

    // Mirrors t3code's provider-message identity as closely as the mobile schema allows.
    nonisolated static func stableAssistantMessageID(threadId: String, turnId: String?, itemId: String?) -> String? {
        guard let itemId = normalizedHistoryIdentifier(itemId) else {
            return nil
        }
        return "assistant:\(threadId):item:\(itemId)"
    }

    // Finds the contiguous timeline block owned by one turn; turnless artifact
    // rows inside that range may be rebound without stealing adjacent turns.
    nonisolated static func contiguousTurnBlockRange(
        in messages: [CodexMessage],
        turnId: String
    ) -> Range<Int>? {
        guard let startIndex = messages.firstIndex(where: { $0.turnId == turnId }) else {
            return nil
        }
        let endIndex = messages.indices.first { index in
            guard index > startIndex else {
                return false
            }
            let message = messages[index]
            if let candidateTurnId = message.turnId, !candidateTurnId.isEmpty {
                return candidateTurnId != turnId
            }
            // A user prompt without a turn id still marks a boundary: the next
            // turn's opener lands before turn/started tags it, and this turn's
            // artifacts must not reach past it.
            return message.role == .user
        } ?? messages.endIndex
        return startIndex..<endIndex
    }

    // Single rule for claiming a turnless file-change row into a turn, shared
    // by live reconciliation and history merge. A transient duplicate is safer
    // than stealing an adjacent turn's file-change table.
    nonisolated static func turnlessFileChangeRowIsClaimable(
        in messages: [CodexMessage],
        candidateIndex: Int,
        turnId: String,
        turnBlockRange: Range<Int>?
    ) -> Bool {
        guard messages.indices.contains(candidateIndex) else {
            return false
        }
        if let turnBlockRange {
            return turnBlockRange.contains(candidateIndex)
        }

        guard !messages.contains(where: {
            Self.normalizedHistoryIdentifier($0.turnId) != nil
        }) else {
            return false
        }

        guard !messages[(candidateIndex + 1)...].contains(where: { $0.role == .user }) else {
            return false
        }

        let candidate = messages[candidateIndex]
        let bootstrapRows = messages.filter {
            $0.role == .system
                && $0.kind == .fileChange
                && Self.normalizedHistoryIdentifier($0.turnId) == nil
        }
        return bootstrapRows.count == 1 && bootstrapRows[0].id == candidate.id
    }

    // Real provider item ids must not be rebound to a different history item mid-stream.
    nonisolated static func hasStableAssistantIdentity(_ itemId: String?) -> Bool {
        guard let itemId = normalizedHistoryIdentifier(itemId) else {
            return false
        }
        return !CodexSyntheticIdentifiers.isMirrorMintedItemID(itemId)
    }

    // Rollout mirrors tag reasoning rows with synthetic "rollout-*" item ids
    // and live streams may use turn-scoped placeholders; both are provisional
    // and must merge with the real reasoning identity of the same turn.
    nonisolated static func isProvisionalThinkingIdentifier(_ itemId: String?) -> Bool {
        guard let itemId = normalizedHistoryIdentifier(itemId) else {
            return true
        }
        return CodexSyntheticIdentifiers.isMirrorMintedItemID(itemId)
    }

    // Running assistant rows may absorb history only when the provider item identity agrees.
    nonisolated static func assistantHistoryIdentityAllowsRunningReconcile(
        localMessage: CodexMessage,
        serverMessage: CodexMessage
    ) -> Bool {
        let localItemId = normalizedHistoryIdentifier(localMessage.itemId)
        let serverItemId = normalizedHistoryIdentifier(serverMessage.itemId)

        if let localItemId, let serverItemId {
            return localItemId == serverItemId || !hasStableAssistantIdentity(localItemId)
        }

        if let localItemId, serverItemId == nil {
            return !hasStableAssistantIdentity(localItemId)
        }

        return true
    }

    // History can revisit an assistant turn multiple times while local rows still
    // have provisional identity. Only reconcile by text when the candidate is unique.
    nonisolated static func uniqueAssistantHistoryTextMergeIndex(
        in messages: [CodexMessage],
        message: CodexMessage,
        turnId: String
    ) -> Int? {
        let normalizedText = normalizedMessageText(message.text)
        guard !normalizedText.isEmpty else {
            return nil
        }

        let normalizedTurnId = normalizedHistoryIdentifier(turnId) ?? turnId
        let candidates = messages.indices.filter { index in
            let candidate = messages[index]
            let candidateTurnId = normalizedHistoryIdentifier(candidate.turnId)
            return candidate.role == .assistant
                && (candidateTurnId == nil || candidateTurnId == normalizedTurnId)
                && normalizedMessageText(candidate.text) == normalizedText
        }

        guard candidates.count == 1,
              let index = candidates.last else {
            return nil
        }

        let localItemId = normalizedHistoryIdentifier(messages[index].itemId)
        let incomingItemId = normalizedHistoryIdentifier(message.itemId)
        if let localItemId, let incomingItemId, localItemId != incomingItemId,
           hasStableAssistantIdentity(localItemId),
           hasStableAssistantIdentity(incomingItemId) {
            return nil
        }

        return index
    }

    nonisolated static func shouldReconcileToolActivityRow(
        _ localMessage: CodexMessage,
        with serverMessage: CodexMessage,
        requiresExactText: Bool
    ) -> Bool {
        let localItemId = normalizedHistoryIdentifier(localMessage.itemId)
        let serverItemId = normalizedHistoryIdentifier(serverMessage.itemId)
        if let localItemId, let serverItemId, localItemId == serverItemId {
            return true
        }

        let localHasStableIdentity = hasStableToolActivityIdentity(localItemId)
        let serverHasStableIdentity = hasStableToolActivityIdentity(serverItemId)
        if localHasStableIdentity && serverHasStableIdentity {
            return false
        }

        let localLines = normalizedToolActivityLines(from: localMessage.text)
        let serverLines = normalizedToolActivityLines(from: serverMessage.text)
        if localLines.isEmpty || serverLines.isEmpty {
            return !localHasStableIdentity || !serverHasStableIdentity
        }

        if localLines == serverLines {
            return true
        }

        guard !requiresExactText else {
            return false
        }

        return localLines.starts(with: serverLines) || serverLines.starts(with: localLines)
    }

    nonisolated static func hasStableToolActivityIdentity(_ value: String?) -> Bool {
        guard let value else {
            return false
        }
        return !CodexSyntheticIdentifiers.isPlaceholderItemID(value, kind: .toolActivity)
    }

    // Treats only streaming/skeleton tool rows as safe to rebind by text alone.
    nonisolated static func isProvisionalToolActivityRow(_ message: CodexMessage) -> Bool {
        let itemId = normalizedHistoryIdentifier(message.itemId)
        guard !hasStableToolActivityIdentity(itemId) else {
            return false
        }

        return message.isStreaming || normalizedToolActivityLines(from: message.text).isEmpty
    }

    nonisolated static func normalizedToolActivityLines(from text: String) -> [String] {
        normalizedMessageText(text)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
    }

    // Merges a resume/history snapshot into the local streaming buffer without
    // losing already-rendered tokens when the server snapshot is slightly stale.
    nonisolated static func mergeStreamingSnapshotText(existingText: String, incomingText: String) -> String {
        if existingText.isEmpty {
            return incomingText
        }

        if incomingText == existingText {
            return existingText
        }

        if existingText.hasSuffix(incomingText) {
            return existingText
        }

        if incomingText.count > existingText.count, incomingText.hasPrefix(existingText) {
            let suffix = incomingText.dropFirst(existingText.count)
            if !existingText.isEmpty, suffix.range(of: existingText) != nil {
                return existingText
            }
            return incomingText
        }

        if existingText.count > incomingText.count, existingText.hasPrefix(incomingText) {
            return existingText
        }

        let maxOverlap = min(existingText.count, incomingText.count)
        if maxOverlap > 0 {
            for overlap in stride(from: maxOverlap, through: 1, by: -1) {
                if existingText.suffix(overlap) == incomingText.prefix(overlap) {
                    return existingText + incomingText.dropFirst(overlap)
                }
            }
        }

        return incomingText
    }

    // Assistant history snapshots can be flattened across messages during reconnect.
    // Keep the live bubble anchored to live deltas unless history is an exact/stale match.
    nonisolated static func mergeAssistantRunningSnapshotText(existingText: String, incomingText: String) -> String {
        if existingText.isEmpty {
            return incomingText
        }

        if incomingText == existingText {
            return existingText
        }

        if existingText.hasSuffix(incomingText) {
            return existingText
        }

        if existingText.count > incomingText.count, existingText.hasPrefix(incomingText) {
            return existingText
        }

        return existingText
    }

    // Closed-turn snapshots are only allowed to replace the visible assistant reply
    // when they are clearly the same message and at least as complete.
    nonisolated static func shouldReplaceClosedAssistantMessage(
        _ localMessage: CodexMessage,
        with serverMessage: CodexMessage
    ) -> Bool {
        let localText = normalizedMessageText(localMessage.text)
        let serverText = normalizedMessageText(serverMessage.text)

        guard !serverText.isEmpty else {
            return false
        }

        if localText.isEmpty || localText == serverText {
            return true
        }

        if localText.count > serverText.count, localText.hasPrefix(serverText) {
            return false
        }

        if looksLikeFlattenedAssistantReplacement(localText: localText, serverText: serverText) {
            return false
        }

        return true
    }

    // Rejects closed assistant replacements that look like multiple assistant rows
    // collapsed into one payload instead of a single canonical final message.
    nonisolated static func looksLikeFlattenedAssistantReplacement(localText: String, serverText: String) -> Bool {
        if serverText.hasPrefix(localText) {
            let suffix = serverText.dropFirst(localText.count)
            return suffix.range(of: "\n\n") != nil || suffix.range(of: localText) != nil
        }

        if let range = serverText.range(of: localText),
           range.lowerBound != serverText.startIndex {
            return true
        }

        return serverText.range(of: "\n\n") != nil
    }

    nonisolated static func attachmentSignature(for attachments: [CodexImageAttachment]) -> String {
        attachments
            .map(\.stableIdentityKey)
            .joined(separator: "|")
    }

    nonisolated static func fileMentionsSignature(for fileMentions: [String]) -> String {
        fileMentions
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
            .sorted()
            .joined(separator: "|")
    }

    nonisolated static func userMessageMetadataLooksCompatible(
        localMessage: CodexMessage,
        serverMessage: CodexMessage,
        allowAttachmentCountFallback: Bool = false
    ) -> Bool {
        let localFileMentions = fileMentionsSignature(for: localMessage.fileMentions)
        let serverFileMentions = fileMentionsSignature(for: serverMessage.fileMentions)
        if !localFileMentions.isEmpty,
           !serverFileMentions.isEmpty,
           localFileMentions != serverFileMentions {
            return false
        }

        let localAttachments = attachmentSignature(for: localMessage.attachments)
        let serverAttachments = attachmentSignature(for: serverMessage.attachments)
        if !localAttachments.isEmpty,
           !serverAttachments.isEmpty,
           localAttachments != serverAttachments {
            // Pending image sends can return with a different server attachment identity
            // even though the user row is the same prompt/image count.
            return allowAttachmentCountFallback
                && localMessage.attachments.count == serverMessage.attachments.count
        }

        return true
    }

    nonisolated static func shouldReconcileUserHistoryMessage(
        _ candidate: CodexMessage,
        with message: CodexMessage,
        turnId: String
    ) -> Bool {
        guard candidate.role == .user,
              candidate.deliveryState != .failed,
              userMessagesMatchForHistory(candidate, message) else {
            return false
        }

        let candidateTurnId = normalizedHistoryIdentifier(candidate.turnId)
        let allowsAttachmentCountFallback = candidate.deliveryState == .pending
            || candidateTurnId == turnId
        guard userMessageMetadataLooksCompatible(
            localMessage: candidate,
            serverMessage: message,
            allowAttachmentCountFallback: allowsAttachmentCountFallback
        ) else {
            return false
        }
        return candidateTurnId == nil || candidateTurnId == turnId
    }

    nonisolated static func shouldReconcilePendingUserHistoryMessage(
        _ candidate: CodexMessage,
        with message: CodexMessage
    ) -> Bool {
        guard candidate.role == .user,
              candidate.deliveryState == .pending,
              userMessagesMatchForHistory(candidate, message),
              userMessageMetadataLooksCompatible(
                localMessage: candidate,
                serverMessage: message,
                allowAttachmentCountFallback: true
              ) else {
            return false
        }

        return true
    }

    nonisolated static func uniqueUserHistoryMergeIndex(
        in merged: [CodexMessage],
        message: CodexMessage,
        turnId: String
    ) -> Int? {
        let matchingIndices = merged.indices.filter { index in
            shouldReconcileUserHistoryMessage(merged[index], with: message, turnId: turnId)
        }

        if matchingIndices.count == 1 {
            return matchingIndices[0]
        }

        // If a previous reopen already persisted an epoch-timestamp echo, bind new
        // history to the real-dated row so the duplicate does not keep multiplying.
        let nonFallbackMatches = matchingIndices.filter { index in
            !hasFallbackHistoryTimestamp(merged[index].createdAt)
        }
        if nonFallbackMatches.count == 1 {
            return nonFallbackMatches[0]
        }

        // Keep intentionally repeated sends separate when more than one real row fits.
        return nil
    }

    nonisolated static func uniquePendingUserHistoryMergeIndex(
        in merged: [CodexMessage],
        message: CodexMessage
    ) -> Int? {
        // Pending rows are especially easy to confuse during phone-started turns.
        let matchingIndices = merged.indices.filter { index in
            shouldReconcilePendingUserHistoryMessage(merged[index], with: message)
        }

        guard matchingIndices.count == 1 else {
            return nil
        }

        return matchingIndices[0]
    }

    nonisolated static func fallbackUserHistoryMergeIndices(
        in merged: [CodexMessage],
        message: CodexMessage
    ) -> [Int] {
        guard message.role == .user,
              normalizedHistoryIdentifier(message.itemId) == nil else {
            return []
        }

        let incomingTurnId = normalizedHistoryIdentifier(message.turnId)
        let incomingHasFallbackTimestamp = hasFallbackHistoryTimestamp(message.createdAt)

        return merged.indices.filter { index in
            let candidate = merged[index]
            guard candidate.threadId == message.threadId,
                  candidate.role == .user,
                  candidate.deliveryState != .failed,
                  userMessagesMatchForHistory(candidate, message),
                  userMessageMetadataLooksCompatible(
                    localMessage: candidate,
                    serverMessage: message,
                    allowAttachmentCountFallback: candidate.deliveryState == .pending
                  ) else {
                return false
            }

            let candidateTurnId = normalizedHistoryIdentifier(candidate.turnId)
            if let incomingTurnId, let candidateTurnId {
                return incomingTurnId == candidateTurnId
            }
            if incomingHasFallbackTimestamp {
                return true
            }
            if incomingTurnId == nil,
               abs(candidate.createdAt.timeIntervalSince(message.createdAt)) <= Self.identitylessUserHistoryEchoWindow {
                return true
            }
            if incomingTurnId == nil,
               !hasFallbackHistoryTimestamp(candidate.createdAt),
               candidate.deliveryState != .pending {
                return false
            }
            return true
        }
    }

    func normalizedItemType(_ rawType: String) -> String {
        rawType
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
            .lowercased()
    }

    func normalizedAssistantPhase(_ rawPhase: String?) -> String? {
        guard let rawPhase else {
            return nil
        }
        let normalized = rawPhase
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "_")
            .lowercased()
        return normalized.isEmpty ? nil : normalized
    }

    nonisolated static func normalizedCommandExecutionPreviewKey(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        let statusPrefixes: Set<String> = ["running", "completed", "failed", "stopped"]
        let tokens = trimmed
            .split(separator: " ", omittingEmptySubsequences: true)
            .map(String.init)
        guard !tokens.isEmpty else {
            return nil
        }

        let commandTokens: [String]
        if let first = tokens.first,
           statusPrefixes.contains(first.lowercased()) {
            commandTokens = Array(tokens.dropFirst())
        } else {
            commandTokens = tokens
        }

        guard !commandTokens.isEmpty else {
            return nil
        }

        let unquoted = commandTokens.map { token in
            token
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        }
        .joined(separator: " ")

        let collapsedWhitespace = unquoted.replacingOccurrences(
            of: #"\s+"#,
            with: " ",
            options: .regularExpression
        )
        let normalized = collapsedWhitespace.lowercased()
        return normalized.isEmpty ? nil : normalized
    }

    // Centralizes history-item -> CodexMessage mapping without changing ordering behavior.
    func appendHistoryMessage(
        to result: inout [CodexMessage],
        role: CodexMessageRole,
        kind: CodexMessageKind = .chat,
        assistantPhase: String? = nil,
        text: String,
        threadId: String,
        turnId: String?,
        itemId: String?,
        createdAt: Date,
        timeZoneIdentifier: String? = nil,
        skillMentions: [String] = [],
        pluginMentions: [String] = [],
        attachments: [CodexImageAttachment] = [],
        planState: CodexPlanState? = nil,
        planPresentation: CodexPlanPresentation? = nil,
        subagentAction: CodexSubagentAction? = nil
    ) {
        guard !text.isEmpty || !attachments.isEmpty || subagentAction != nil else {
            return
        }

        result.append(
            CodexMessage(
                id: role == .assistant
                    ? (Self.stableAssistantMessageID(threadId: threadId, turnId: turnId, itemId: itemId) ?? UUID().uuidString)
                    : UUID().uuidString,
                threadId: threadId,
                role: role,
                kind: kind,
                assistantPhase: role == .assistant ? normalizedAssistantPhase(assistantPhase) : nil,
                text: text,
                skillMentions: skillMentions,
                pluginMentions: pluginMentions,
                createdAt: createdAt,
                timeZoneIdentifier: timeZoneIdentifier,
                turnId: turnId,
                itemId: itemId,
                isStreaming: false,
                deliveryState: .confirmed,
                attachments: attachments,
                planState: planState,
                planPresentation: planPresentation,
                proposedPlan: role == .assistant ? CodexProposedPlanParser.parse(from: text) : nil,
                subagentAction: subagentAction
            )
        )
    }

    // Canonical history may store generated-image artifacts as separate items; the
    // timeline presents them inside the final assistant answer for that turn.
    nonisolated static func historyMessagesMergingGeneratedImageArtifacts(_ messages: [CodexMessage]) -> [CodexMessage] {
        var result = messages
        let turnIds = Array(Set(result.compactMap(\.turnId)))
        for turnId in turnIds {
            let assistantIndices = result.indices.filter { index in
                result[index].role == .assistant && result[index].turnId == turnId
            }
            let imageOnlyIndices = assistantIndices.filter { index in
                Self.isHistoryGeneratedImageArtifactOnly(result[index].text)
            }
            guard !imageOnlyIndices.isEmpty,
                  let targetIndex = assistantIndices.last(where: { index in
                      !imageOnlyIndices.contains(index)
                          && result[index].assistantPhase == "final_answer"
                  }) else {
                continue
            }

            let existingText = result[targetIndex].text
            let existingImagePaths = Set(AssistantMarkdownImageReferenceParser.references(in: existingText).map(\.path))
            let imageText = imageOnlyIndices
                .filter { index in
                    AssistantMarkdownImageReferenceParser.references(in: result[index].text).contains { reference in
                        !existingImagePaths.contains(reference.path)
                    }
                }
                .map { result[$0].text.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: "\n\n")
            guard !imageText.isEmpty else {
                continue
            }
            result[targetIndex].text = [existingText, imageText]
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: "\n\n")
        }

        let removedIds = Set(result.indices.filter { index in
            if let turnId = result[index].turnId,
               Self.isHistoryGeneratedImageArtifactOnly(result[index].text) {
                return result.contains { candidate in
                    candidate.id != result[index].id
                        && candidate.role == .assistant
                        && candidate.turnId == turnId
                        && !Self.isHistoryGeneratedImageArtifactOnly(candidate.text)
                        && AssistantMarkdownImageReferenceParser.references(in: candidate.text).contains { reference in
                            result[index].text.contains(reference.path)
                        }
                }
            }
            return false
        }.map { result[$0].id })
        return result.filter { !removedIds.contains($0.id) }
    }

    nonisolated static func isHistoryGeneratedImageArtifactOnly(_ text: String) -> Bool {
        let imageReferences = AssistantMarkdownImageReferenceParser.references(in: text)
        guard !imageReferences.isEmpty,
              imageReferences.allSatisfy(\.isCodexGeneratedImage) else {
            return false
        }
        return AssistantMarkdownImageReferenceParser
            .visibleTextRemovingImageSyntax(from: text)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty
    }

    func decodeReasoningItemText(from itemObject: [String: JSONValue]) -> String {
        let summary = decodeHistoryStringParts(itemObject["summary"]).joined(separator: "\n")
        let content = decodeHistoryStringParts(itemObject["content"]).joined(separator: "\n\n")

        var sections: [String] = []
        if !summary.isEmpty {
            sections.append(summary)
        }
        if !content.isEmpty {
            sections.append(content)
        }

        if sections.isEmpty {
            return ""
        }

        return sections.joined(separator: "\n\n")
    }

    func decodePlanItemText(from itemObject: [String: JSONValue]) -> String {
        let decodedText = decodeItemText(from: itemObject)
        if !decodedText.isEmpty {
            return decodedText
        }

        let summary = decodeHistoryStringParts(itemObject["summary"]).joined(separator: "\n")
        if !summary.isEmpty {
            return summary
        }

        return ""
    }

    func decodePlanState(from itemObject: [String: JSONValue]) -> CodexPlanState? {
        let explanation = decodeNormalizedPlanText(itemObject["explanation"])
            ?? decodeNormalizedPlanText(itemObject["summary"])
        let steps = (itemObject["plan"]?.arrayValue ?? []).compactMap { stepValue -> CodexPlanStep? in
            guard let stepObject = stepValue.objectValue,
                  let step = decodeNormalizedPlanText(stepObject["step"]),
                  let rawStatus = decodeNormalizedPlanText(stepObject["status"]),
                  let status = CodexPlanStepStatus(wireValue: rawStatus) else {
                return nil
            }

            return CodexPlanStep(step: step, status: status)
        }

        guard explanation != nil || !steps.isEmpty else {
            return nil
        }

        return CodexPlanState(explanation: explanation, steps: steps)
    }

    // Closed turns should not restore a stale "active" plan accessory from history.
    func finalizedHistoryPlanState(_ planState: CodexPlanState?, turnCompleted: Bool) -> CodexPlanState? {
        guard turnCompleted,
              let planState,
              !planState.steps.isEmpty,
              planState.steps.contains(where: { $0.status != .completed }) else {
            return planState
        }

        return CodexPlanState(
            explanation: planState.explanation,
            steps: planState.steps.map { step in
                CodexPlanStep(id: step.id, step: step.step, status: .completed)
            }
        )
    }

    func isCompletedHistoryTurn(_ turnObject: [String: JSONValue]) -> Bool {
        historyTurnTerminalState(turnObject) == .completed
    }

    func historyTurnTerminalState(_ turnObject: [String: JSONValue]) -> CodexTurnTerminalState? {
        let statusObject = turnObject["status"]?.objectValue
        let rawStatus = firstNonEmptyString([
            turnObject["status"]?.stringValue,
            statusObject?["type"]?.stringValue,
            statusObject?["statusType"]?.stringValue,
            statusObject?["status_type"]?.stringValue,
            turnObject["result"]?.stringValue,
        ]) ?? ""

        return threadTerminalState(from: normalizeThreadStatusType(rawStatus))
    }

}
