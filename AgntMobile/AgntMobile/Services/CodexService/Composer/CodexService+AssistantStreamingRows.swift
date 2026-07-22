// FILE: CodexService+AssistantStreamingRows.swift
// Purpose: Assistant streaming row creation, lookup keys, placeholder text, and delta merging.
// Layer: Service

import Foundation

extension CodexService {
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
        case .autoApprovalReview:
            return "Reviewing approval..."
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
