// FILE: CodexService+Messages.swift
// Purpose: Owns message row mutation and streaming merge logic.
// Layer: Service
// Exports: CodexService message APIs
// Depends on: CodexMessage, JSONValue

import Foundation
import UIKit

extension CodexService {
    // Appends a user message immediately so UI feels instant before server events arrive.
    @discardableResult
    func appendUserMessage(
        threadId: String,
        text: String,
        turnId: String? = nil,
        attachments: [CodexImageAttachment] = [],
        fileMentions: [String] = [],
        skillMentions: [String] = [],
        pluginMentions: [String] = []
    ) -> String {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty
                || !attachments.isEmpty
                || !skillMentions.isEmpty
                || !pluginMentions.isEmpty else {
            return ""
        }

        let message = CodexMessage(
            threadId: threadId,
            role: .user,
            text: trimmedText,
            fileMentions: fileMentions,
            skillMentions: skillMentions,
            pluginMentions: pluginMentions,
            turnId: turnId,
            isStreaming: false,
            deliveryState: .pending,
            attachments: attachments
        )
        appendMessage(message)
        return message.id
    }

    // Upserts a confirmed user row mirrored from a desktop-origin rollout so
    // reopened threads can display the remote prompt immediately without
    // disturbing the phone-native pending-send path.
    func appendConfirmedMirroredUserMessage(
        threadId: String,
        turnId: String?,
        text: String,
        fileMentions: [String] = [],
        createdAt: Date? = nil
    ) {
        let trimmedText = Self.normalizedMessageText(text)
        guard Self.hasMeaningfulHistoryText(trimmedText) else {
            return
        }

        if let existingIndex = messagesByThread[threadId]?.lastIndex(where: { candidate in
            candidate.role == .user
                && Self.userMessageMatchesTextForHistory(candidate, text: trimmedText)
                && (
                    (turnId != nil && (candidate.turnId == nil || candidate.turnId == turnId))
                        || (turnId == nil && candidate.turnId == nil)
                )
        }) {
            var didMutate = false
            if messagesByThread[threadId]?[existingIndex].deliveryState != .confirmed {
                messagesByThread[threadId]?[existingIndex].deliveryState = .confirmed
                didMutate = true
            }
            if messagesByThread[threadId]?[existingIndex].turnId == nil {
                messagesByThread[threadId]?[existingIndex].turnId = turnId
                didMutate = true
            }
            // Optional chaining turns `isEmpty` into `Bool?`, so compare explicitly here.
            if messagesByThread[threadId]?[existingIndex].fileMentions.isEmpty == true, !fileMentions.isEmpty {
                messagesByThread[threadId]?[existingIndex].fileMentions = fileMentions
                didMutate = true
            }
            if let createdAt,
               CodexTimestampParser.isTrustworthyServerDate(createdAt),
               let existingCreatedAt = messagesByThread[threadId]?[existingIndex].createdAt,
               (!CodexTimestampParser.isTrustworthyServerDate(existingCreatedAt)
                    || abs(existingCreatedAt.timeIntervalSince(createdAt)) > 0.5) {
                messagesByThread[threadId]?[existingIndex].createdAt = createdAt
                didMutate = true
            }
            if moveMirroredOpeningUserBeforeTurnOutputIfNeeded(
                threadId: threadId,
                turnId: turnId,
                messageIndex: existingIndex
            ) {
                didMutate = true
            }
            guard didMutate else {
                return
            }
            messagesByThread[threadId]?.sort(by: { $0.orderIndex < $1.orderIndex })
            persistMessages()
            updateCurrentOutput(for: threadId)
            return
        }

        let orderIndex = reserveMirroredOpeningUserOrderIndex(threadId: threadId, turnId: turnId)
        appendMessage(
            CodexMessage(
                threadId: threadId,
                role: .user,
                text: trimmedText,
                fileMentions: fileMentions,
                createdAt: createdAt ?? Date(),
                turnId: turnId,
                deliveryState: .confirmed,
                orderIndex: orderIndex
            )
        )
    }

    // Desktop rollout mirrors can deliver assistant output before the opening user event.
    // Reserve the first same-turn slot so the phone timeline matches the Mac transcript.
    private func reserveMirroredOpeningUserOrderIndex(threadId: String, turnId: String?) -> Int? {
        guard let turnAnchor = mirroredOpeningUserAnchor(threadId: threadId, turnId: turnId) else {
            return nil
        }

        guard let indices = messagesByThread[threadId]?.indices else {
            return turnAnchor
        }

        for index in indices {
            guard let currentOrder = messagesByThread[threadId]?[index].orderIndex,
                  currentOrder >= turnAnchor else {
                continue
            }
            messagesByThread[threadId]?[index].orderIndex = currentOrder + 1
        }
        CodexMessageOrderCounter.seed(from: messagesByThread)
        return turnAnchor
    }

    // Repositions an already-created mirrored opener without moving real steer prompts.
    private func moveMirroredOpeningUserBeforeTurnOutputIfNeeded(
        threadId: String,
        turnId: String?,
        messageIndex: Int
    ) -> Bool {
        guard let threadMessages = messagesByThread[threadId],
              threadMessages.indices.contains(messageIndex),
              let turnAnchor = mirroredOpeningUserAnchor(
                threadId: threadId,
                turnId: turnId,
                existingMessageID: threadMessages[messageIndex].id
              ),
              threadMessages[messageIndex].orderIndex > turnAnchor else {
            return false
        }

        let previousOrder = threadMessages[messageIndex].orderIndex
        for index in threadMessages.indices where index != messageIndex {
            guard let currentOrder = messagesByThread[threadId]?[index].orderIndex,
                  currentOrder >= turnAnchor,
                  currentOrder < previousOrder else {
                continue
            }
            messagesByThread[threadId]?[index].orderIndex = currentOrder + 1
        }
        messagesByThread[threadId]?[messageIndex].orderIndex = turnAnchor
        return true
    }

    // Returns the first output slot only when this turn has no other user row.
    // Multiple user rows mean an in-turn steer, where chronological order is intentional.
    private func mirroredOpeningUserAnchor(
        threadId: String,
        turnId: String?,
        existingMessageID: String? = nil
    ) -> Int? {
        guard let turnId, !turnId.isEmpty,
              let threadMessages = messagesByThread[threadId] else {
            return nil
        }

        var firstOutputOrder: Int?
        for message in threadMessages where message.turnId == turnId {
            if message.id == existingMessageID {
                continue
            }
            if message.role == .user {
                return nil
            }
            firstOutputOrder = min(firstOutputOrder ?? message.orderIndex, message.orderIndex)
        }
        return firstOutputOrder
    }

    // Appends a system message in the current thread timeline.

    // Creates a streaming assistant placeholder for a turn/item if missing.
    func beginAssistantMessage(
        threadId: String,
        turnId: String,
        itemId: String? = nil,
        assistantPhase: String? = nil
    ) {
        let turnStreamingKey = streamingMessageKey(threadId: threadId, turnId: turnId)
        let normalizedItemId = normalizedStreamingItemID(itemId)
        let normalizedPhase = normalizedAssistantPhase(assistantPhase)
        let itemStreamingKey = normalizedItemId.map {
            assistantStreamingMessageKey(threadId: threadId, turnId: turnId, itemId: $0)
        }

        if let itemStreamingKey,
           let messageID = streamingAssistantMessageByItemKey[itemStreamingKey],
           let messageIndex = findMessageIndex(threadId: threadId, messageId: messageID) {
            // Item-scoped late events must not steal the turn fallback pointer from
            // a newer assistant item that is still receiving turn-scoped deltas.
            applyAssistantPhaseIfNeeded(
                threadId: threadId,
                messageIndex: messageIndex,
                assistantPhase: normalizedPhase
            )
            return
        }

        if let messageID = streamingAssistantFallbackMessageByTurnID[turnStreamingKey],
           let messageIndex = findMessageIndex(threadId: threadId, messageId: messageID) {
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
                        streamingAssistantMessageByItemKey[itemStreamingKey] = messageID
                    }
                    persistMessages()
                    updateCurrentOutput(for: threadId)
                    return
                }
                if existingItemId == normalizedItemId {
                    applyAssistantPhaseIfNeeded(
                        threadId: threadId,
                        messageIndex: messageIndex,
                        assistantPhase: normalizedPhase
                    )
                    if let itemStreamingKey {
                        streamingAssistantMessageByItemKey[itemStreamingKey] = messageID
                    }
                    return
                }

                // New assistant item started inside the same turn: preserve the previous bubble.
                messagesByThread[threadId]?[messageIndex].isStreaming = false
                streamingAssistantFallbackMessageByTurnID.removeValue(forKey: turnStreamingKey)
                persistMessages()
                updateCurrentOutput(for: threadId)
            } else {
                return
            }
        } else {
            streamingAssistantFallbackMessageByTurnID.removeValue(forKey: turnStreamingKey)
        }

        _ = createAssistantMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: normalizedItemId,
            assistantPhase: normalizedPhase,
            isStreaming: true,
            promoteTurnFallback: true
        )
    }

    // Streams assistant delta chunks into the message linked to a turn.
    func appendAssistantDelta(
        threadId: String,
        turnId: String,
        itemId: String?,
        assistantPhase: String? = nil,
        delta: String
    ) {
        guard !delta.isEmpty else {
            return
        }

        enqueueAssistantDelta(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            assistantPhase: assistantPhase,
            delta: delta
        )
    }

    // Applies one already-coalesced assistant delta batch to the active timeline.
    func applyAssistantDeltaBatch(
        threadId: String,
        turnId: String,
        itemId: String?,
        assistantPhase: String?,
        delta: String
    ) {
        guard !delta.isEmpty else {
            return
        }

        if applyLateTerminalAssistantDelta(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            assistantPhase: assistantPhase,
            delta: delta
        ) {
            return
        }

        let messageID = ensureStreamingAssistantMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            assistantPhase: assistantPhase
        )
        guard let messageID,
              let messageIndex = findMessageIndex(threadId: threadId, messageId: messageID) else {
            return
        }

        let currentText = messagesByThread[threadId]?[messageIndex].text ?? ""
        let nextText = mergeAssistantDelta(
            existingText: currentText,
            incomingDelta: delta
        )
        let didResolveItemId = messagesByThread[threadId]?[messageIndex].itemId == nil && itemId != nil

        guard nextText != currentText
                || !(messagesByThread[threadId]?[messageIndex].isStreaming ?? false)
                || didResolveItemId else {
            return
        }

        messagesByThread[threadId]?[messageIndex].text = nextText
        messagesByThread[threadId]?[messageIndex].isStreaming = !isApplyingReplayedBridgeEvent
        applyAssistantPhaseIfNeeded(
            threadId: threadId,
            messageIndex: messageIndex,
            assistantPhase: assistantPhase
        )
        if messagesByThread[threadId]?[messageIndex].itemId == nil, let itemId {
            messagesByThread[threadId]?[messageIndex].itemId = itemId
        }
        refreshDerivedPlanMetadata(threadId: threadId, messageIndex: messageIndex)

        persistMessages()
        updateStreamingAssistantOutput(for: threadId, messageId: messageID, rawMessageIndex: messageIndex)
    }

    // Late replay deltas for a closed turn should patch the closed assistant row, not reopen streaming.
    private func applyLateTerminalAssistantDelta(
        threadId: String,
        turnId: String,
        itemId: String?,
        assistantPhase: String?,
        delta: String
    ) -> Bool {
        let normalizedTurnId = turnId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTurnId.isEmpty,
              turnTerminalState(for: normalizedTurnId, threadId: threadId) != nil,
              activeTurnIdByThread[threadId] != normalizedTurnId,
              var threadMessages = messagesByThread[threadId] else {
            return false
        }

        let normalizedItemId = normalizedStreamingItemID(itemId)
        let targetIndex: Int? = {
            if let normalizedItemId {
                return threadMessages.indices.reversed().first { index in
                    let candidate = threadMessages[index]
                    return candidate.role == .assistant
                        && candidate.turnId == normalizedTurnId
                        && (candidate.itemId == normalizedItemId || candidate.itemId == nil)
                }
            }

            return threadMessages.indices.reversed().first { index in
                let candidate = threadMessages[index]
                return candidate.role == .assistant
                    && candidate.turnId == normalizedTurnId
                    && !candidate.isStreaming
            }
        }()

        guard let targetIndex else {
            // Closed turns must not be reopened by late status/progress replay chunks.
            return true
        }

        let currentText = threadMessages[targetIndex].text
        let nextText = mergeAssistantDelta(existingText: currentText, incomingDelta: delta)
        let didResolveItemId = threadMessages[targetIndex].itemId == nil && normalizedItemId != nil

        guard nextText != currentText || threadMessages[targetIndex].isStreaming || didResolveItemId else {
            return true
        }

        threadMessages[targetIndex].text = nextText
        threadMessages[targetIndex].isStreaming = false
        if threadMessages[targetIndex].assistantPhase == nil, let assistantPhase {
            threadMessages[targetIndex].assistantPhase = normalizedAssistantPhase(assistantPhase)
        }
        if didResolveItemId {
            threadMessages[targetIndex].itemId = normalizedItemId
        }
        messagesByThread[threadId] = threadMessages
        refreshDerivedPlanMetadata(threadId: threadId, messageIndex: targetIndex)
        persistMessages()
        updateCurrentOutput(for: threadId)
        return true
    }

    // Finalizes assistant text when item/completed carries the canonical message body.
    func completeAssistantMessage(
        threadId: String,
        turnId: String?,
        itemId: String?,
        assistantPhase: String? = nil,
        text: String
    ) {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty else {
            return
        }

        let now = Date()
        let normalizedPhase = normalizedAssistantPhase(assistantPhase)
        var resolvedAssistantMessageId: String?
        let explicitTurnId = normalizedStreamingItemID(turnId)
        let explicitItemId = normalizedStreamingItemID(itemId)
        let activeTurnIdForThread = activeTurnIdByThread[threadId]
        let hasExplicitIdentity = explicitTurnId != nil || explicitItemId != nil

        if explicitTurnId == nil,
           explicitItemId == nil,
           shouldIgnoreIdentifierlessAssistantCompletion(
               threadId: threadId,
               text: trimmedText,
               activeTurnId: activeTurnIdForThread,
               now: now
           ) {
            return
        }

        if !hasExplicitIdentity,
           activeTurnIdForThread != nil || threadHasActiveOrRunningTurn(threadId) {
            // t3code never assigns turn-less completions to the newest active turn.
            // Late legacy payloads are ambiguous, so do not let them overwrite the current answer.
            assistantCompletionFingerprintByThread[threadId] = (text: trimmedText, timestamp: now)
            return
        }

        let resolvedTurnId = explicitTurnId
            ?? explicitItemId.flatMap { knownAssistantTurnId(threadId: threadId, itemId: $0) }
            ?? (explicitItemId == nil ? nil : activeTurnIdForThread)
        if let resolvedTurnId {
            threadIdByTurnID[resolvedTurnId] = threadId
        }
        flushPendingAssistantDeltas(for: threadId, turnId: resolvedTurnId, itemId: explicitItemId)

        if resolvedTurnId == nil, explicitItemId == nil,
           let fingerprint = assistantCompletionFingerprintByThread[threadId],
           fingerprint.text == trimmedText,
           now.timeIntervalSince(fingerprint.timestamp) <= 45 {
            return
        }

        if let replayTerminalMessageId = absorbAssistantBlockReplayCompletion(
            threadId: threadId,
            turnId: resolvedTurnId,
            text: trimmedText
        ) {
            applyAssistantPhaseIfNeeded(
                threadId: threadId,
                messageId: replayTerminalMessageId,
                assistantPhase: normalizedPhase
            )
            assistantCompletionFingerprintByThread[threadId] = (text: trimmedText, timestamp: now)
            _ = mergeGeneratedImageArtifactsIntoAssistantMessage(
                threadId: threadId,
                turnId: resolvedTurnId,
                assistantMessageId: replayTerminalMessageId
            )
            persistMessages()
            if let resolvedTurnId {
                noteAssistantMessage(
                    threadId: threadId,
                    turnId: resolvedTurnId,
                    assistantMessageId: replayTerminalMessageId
                )
            }
            updateCurrentOutput(for: threadId)
            return
        }

        if let resolvedTurnId,
           let imagePreviewIndex = imagePreviewAssistantCompletionIndex(
               threadId: threadId,
               turnId: resolvedTurnId,
               itemId: explicitItemId,
               text: trimmedText
           ) {
            let existingText = messagesByThread[threadId]?[imagePreviewIndex].text ?? ""
            messagesByThread[threadId]?[imagePreviewIndex].text = Self.assistantCompletionTextPreservingImages(
                existingText: existingText,
                canonicalText: trimmedText
            )
            messagesByThread[threadId]?[imagePreviewIndex].isStreaming = false
            applyAssistantPhaseIfNeeded(
                threadId: threadId,
                messageIndex: imagePreviewIndex,
                assistantPhase: normalizedPhase
            )
            if messagesByThread[threadId]?[imagePreviewIndex].itemId == nil, let explicitItemId {
                messagesByThread[threadId]?[imagePreviewIndex].itemId = explicitItemId
            }
            refreshDerivedPlanMetadata(threadId: threadId, messageIndex: imagePreviewIndex)
            let messageId = messagesByThread[threadId]?[imagePreviewIndex].id
            assistantCompletionFingerprintByThread[threadId] = (text: trimmedText, timestamp: now)
            if let messageId {
                _ = mergeGeneratedImageArtifactsIntoAssistantMessage(
                    threadId: threadId,
                    turnId: resolvedTurnId,
                    assistantMessageId: messageId
                )
                persistMessages()
                noteAssistantMessage(
                    threadId: threadId,
                    turnId: resolvedTurnId,
                    assistantMessageId: messageId
                )
                updateCurrentOutput(for: threadId)
            }
            return
        }

        if let resolvedTurnId,
           explicitItemId == nil,
           let duplicateIndex = completedAssistantMessageIndices(
               threadId: threadId,
               turnId: resolvedTurnId
           ).last(where: { index in
               Self.normalizedMessageText(messagesByThread[threadId]?[index].text ?? "") == trimmedText
           }) {
            messagesByThread[threadId]?[duplicateIndex].isStreaming = false
            applyAssistantPhaseIfNeeded(
                threadId: threadId,
                messageIndex: duplicateIndex,
                assistantPhase: normalizedPhase
            )
            refreshDerivedPlanMetadata(threadId: threadId, messageIndex: duplicateIndex)
            assistantCompletionFingerprintByThread[threadId] = (text: trimmedText, timestamp: now)
            if let resolvedAssistantMessageId = messagesByThread[threadId]?[duplicateIndex].id {
                _ = mergeGeneratedImageArtifactsIntoAssistantMessage(
                    threadId: threadId,
                    turnId: resolvedTurnId,
                    assistantMessageId: resolvedAssistantMessageId
                )
                persistMessages()
                noteAssistantMessage(
                    threadId: threadId,
                    turnId: resolvedTurnId,
                    assistantMessageId: resolvedAssistantMessageId
                )
                updateCurrentOutput(for: threadId)
            }
            return
        }

        if let resolvedTurnId,
           explicitItemId == nil,
           !threadHasActiveOrRunningTurn(threadId) {
            let completedAssistantIndices = completedAssistantMessageIndices(
                threadId: threadId,
                turnId: resolvedTurnId
            )

            if completedAssistantIndices.count == 1,
               let targetIndex = completedAssistantIndices.first {
                let currentAssistant = messagesByThread[threadId]?[targetIndex]
                if let currentAssistant,
                   Self.shouldReplaceClosedAssistantMessage(
                        currentAssistant,
                        with: CodexMessage(
                            threadId: threadId,
                            role: .assistant,
                            text: trimmedText,
                            turnId: resolvedTurnId,
                            itemId: nil,
                            isStreaming: false,
                            deliveryState: .confirmed,
                            orderIndex: currentAssistant.orderIndex
                        )
                   ) {
                    messagesByThread[threadId]?[targetIndex].text = Self.assistantCompletionTextPreservingImages(
                        existingText: currentAssistant.text,
                        canonicalText: trimmedText
                    )
                    messagesByThread[threadId]?[targetIndex].isStreaming = false
                    applyAssistantPhaseIfNeeded(
                        threadId: threadId,
                        messageIndex: targetIndex,
                        assistantPhase: normalizedPhase
                    )
                    if messagesByThread[threadId]?[targetIndex].turnId == nil {
                        messagesByThread[threadId]?[targetIndex].turnId = resolvedTurnId
                    }
                    refreshDerivedPlanMetadata(threadId: threadId, messageIndex: targetIndex)
                    resolvedAssistantMessageId = messagesByThread[threadId]?[targetIndex].id
                }
                assistantCompletionFingerprintByThread[threadId] = (text: trimmedText, timestamp: now)
                if let resolvedAssistantMessageId {
                    _ = mergeGeneratedImageArtifactsIntoAssistantMessage(
                        threadId: threadId,
                        turnId: resolvedTurnId,
                        assistantMessageId: resolvedAssistantMessageId
                    )
                    persistMessages()
                    noteAssistantMessage(
                        threadId: threadId,
                        turnId: resolvedTurnId,
                        assistantMessageId: resolvedAssistantMessageId
                    )
                    updateCurrentOutput(for: threadId)
                }
                return
            }

            if !completedAssistantIndices.isEmpty {
                // Late legacy completions without item identity are ambiguous once a closed
                // turn already has assistant bubbles. Ignore them instead of appending a duplicate.
                assistantCompletionFingerprintByThread[threadId] = (text: trimmedText, timestamp: now)
                return
            }
        }

        if let resolvedTurnId,
           let messageID = ensureStreamingAssistantMessage(
               threadId: threadId,
               turnId: resolvedTurnId,
               itemId: explicitItemId,
               assistantPhase: normalizedPhase,
               promoteTurnFallback: explicitItemId == nil,
               createStreamingMessage: explicitItemId == nil
           ),
           let messageIndex = findMessageIndex(threadId: threadId, messageId: messageID) {
            let existingText = messagesByThread[threadId]?[messageIndex].text ?? ""
            let completedText = Self.assistantCompletionTextPreservingImages(
                existingText: existingText,
                canonicalText: trimmedText
            )

            if existingText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                messagesByThread[threadId]?[messageIndex].text = completedText
            } else if existingText != completedText {
                messagesByThread[threadId]?[messageIndex].text = completedText
            }

            messagesByThread[threadId]?[messageIndex].isStreaming = false
            applyAssistantPhaseIfNeeded(
                threadId: threadId,
                messageIndex: messageIndex,
                assistantPhase: normalizedPhase
            )
            if messagesByThread[threadId]?[messageIndex].itemId == nil, let explicitItemId {
                messagesByThread[threadId]?[messageIndex].itemId = explicitItemId
            }
            if messagesByThread[threadId]?[messageIndex].turnId == nil {
                messagesByThread[threadId]?[messageIndex].turnId = resolvedTurnId
            }
            refreshDerivedPlanMetadata(threadId: threadId, messageIndex: messageIndex)
            resolvedAssistantMessageId = messagesByThread[threadId]?[messageIndex].id
        } else {
            if let explicitItemId,
               let existingItemIndex = messagesByThread[threadId]?.lastIndex(where: { candidate in
                   candidate.role == .assistant && candidate.itemId == explicitItemId
               }) {
                let existingText = messagesByThread[threadId]?[existingItemIndex].text ?? ""
                messagesByThread[threadId]?[existingItemIndex].text = Self.assistantCompletionTextPreservingImages(
                    existingText: existingText,
                    canonicalText: trimmedText
                )
                messagesByThread[threadId]?[existingItemIndex].isStreaming = false
                applyAssistantPhaseIfNeeded(
                    threadId: threadId,
                    messageIndex: existingItemIndex,
                    assistantPhase: normalizedPhase
                )
                if messagesByThread[threadId]?[existingItemIndex].turnId == nil {
                    messagesByThread[threadId]?[existingItemIndex].turnId = resolvedTurnId
                }
                refreshDerivedPlanMetadata(threadId: threadId, messageIndex: existingItemIndex)
                resolvedAssistantMessageId = messagesByThread[threadId]?[existingItemIndex].id
            } else if let duplicateIndex = messagesByThread[threadId]?.lastIndex(where: { candidate in
                candidate.role == .assistant
                    && Self.normalizedMessageText(candidate.text) == trimmedText
                    && (
                        candidate.isStreaming
                            || (resolvedTurnId != nil && candidate.turnId == resolvedTurnId)
                            || (explicitItemId != nil && candidate.itemId == explicitItemId)
                    )
            }) {
                // Drop duplicated completion payloads that carry the same final assistant text.
                messagesByThread[threadId]?[duplicateIndex].isStreaming = false
                applyAssistantPhaseIfNeeded(
                    threadId: threadId,
                    messageIndex: duplicateIndex,
                    assistantPhase: normalizedPhase
                )
                if messagesByThread[threadId]?[duplicateIndex].itemId == nil, let explicitItemId {
                    messagesByThread[threadId]?[duplicateIndex].itemId = explicitItemId
                }
                if messagesByThread[threadId]?[duplicateIndex].turnId == nil {
                    messagesByThread[threadId]?[duplicateIndex].turnId = resolvedTurnId
                }
                refreshDerivedPlanMetadata(threadId: threadId, messageIndex: duplicateIndex)
                resolvedAssistantMessageId = messagesByThread[threadId]?[duplicateIndex].id
            } else {
                let newMessage = CodexMessage(
                    id: Self.stableAssistantMessageID(threadId: threadId, turnId: resolvedTurnId, itemId: explicitItemId) ?? UUID().uuidString,
                    threadId: threadId,
                    role: .assistant,
                    assistantPhase: normalizedPhase,
                    text: trimmedText,
                    turnId: resolvedTurnId,
                    itemId: explicitItemId,
                    isStreaming: false,
                    deliveryState: .confirmed
                )
                appendMessage(newMessage)
                resolvedAssistantMessageId = newMessage.id
            }
        }

        assistantCompletionFingerprintByThread[threadId] = (text: trimmedText, timestamp: now)

        if let resolvedAssistantMessageId {
            _ = mergeGeneratedImageArtifactsIntoAssistantMessage(
                threadId: threadId,
                turnId: resolvedTurnId,
                assistantMessageId: resolvedAssistantMessageId
            )
        }

        persistMessages()
        if let resolvedAssistantMessageId {
            noteAssistantMessage(
                threadId: threadId,
                turnId: resolvedTurnId,
                assistantMessageId: resolvedAssistantMessageId
            )
        }
        updateCurrentOutput(for: threadId)
    }

    // Renders image-generation artifacts as assistant image previews without embedding image bytes.

    func markMessageDeliveryState(
        threadId: String,
        messageId: String,
        state: CodexMessageDeliveryState,
        turnId: String? = nil
    ) {
        guard !messageId.isEmpty,
              let messageIndex = findMessageIndex(threadId: threadId, messageId: messageId) else {
            return
        }

        messagesByThread[threadId]?[messageIndex].deliveryState = state
        if let turnId, messagesByThread[threadId]?[messageIndex].turnId == nil {
            messagesByThread[threadId]?[messageIndex].turnId = turnId
        }
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    func confirmLatestPendingUserMessage(threadId: String, turnId: String) {
        guard !turnId.isEmpty,
              var threadMessages = messagesByThread[threadId] else {
            return
        }

        guard let index = threadMessages.indices.reversed().first(where: { idx in
            let candidate = threadMessages[idx]
            return candidate.role == .user
                && candidate.deliveryState == .pending
                && (candidate.turnId == nil || candidate.turnId == turnId)
        }) else {
            return
        }

        threadMessages[index].deliveryState = .confirmed
        threadMessages[index].turnId = turnId
        messagesByThread[threadId] = threadMessages
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    func removeLatestFailedUserMessage(
        threadId: String,
        matchingText: String,
        matchingAttachments: [CodexImageAttachment] = []
    ) {
        let normalizedText = matchingText.trimmingCharacters(in: .whitespacesAndNewlines)
        let matchingAttachmentSignature = matchingAttachments
            .map(\.stableIdentityKey)
            .joined(separator: "|")

        guard (!normalizedText.isEmpty || !matchingAttachmentSignature.isEmpty),
              var threadMessages = messagesByThread[threadId] else {
            return
        }

        guard let index = threadMessages.indices.reversed().first(where: { index in
            let message = threadMessages[index]
            let messageAttachmentSignature = message.attachments
                .map(\.stableIdentityKey)
                .joined(separator: "|")
            let matchesText = normalizedText.isEmpty
                || message.text.trimmingCharacters(in: .whitespacesAndNewlines) == normalizedText
            let matchesAttachments = matchingAttachmentSignature.isEmpty
                || messageAttachmentSignature == matchingAttachmentSignature
            return message.role == .user
                && message.deliveryState == .failed
                && matchesText
                && matchesAttachments
        }) else {
            return
        }

        threadMessages.remove(at: index)
        messagesByThread[threadId] = threadMessages
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    // Removes a known optimistic user row when text matching is not reliable, such as mention-only sends.
    @discardableResult
    func removeUserMessage(threadId: String, messageId: String) -> Bool {
        guard !messageId.isEmpty,
              var threadMessages = messagesByThread[threadId],
              let index = findMessageIndex(threadId: threadId, messageId: messageId),
              threadMessages.indices.contains(index),
              threadMessages[index].role == .user else {
            return false
        }

        threadMessages.remove(at: index)
        messagesByThread[threadId] = threadMessages
        messageIndexCacheByThread[threadId] = nil
        persistMessages()
        updateCurrentOutput(for: threadId)
        return true
    }

    // Marks streaming assistant state complete once turn/completed arrives.
    func markTurnCompleted(threadId: String, turnId: String?) {
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]
        flushPendingAssistantDeltas(for: threadId, turnId: resolvedTurnId)
        flushPendingSystemDeltasForTurn(threadId: threadId, turnId: resolvedTurnId)

        clearRunningState(for: threadId)
        clearRunningThreadWatch(threadId)
        let shouldFinalizePlanSteps: Bool = {
            if let resolvedTurnId {
                return turnTerminalState(for: resolvedTurnId, threadId: threadId) == .completed
            }
            return latestTurnTerminalStateByThread[threadId] == .completed
        }()

        if let resolvedTurnId {
            clearAssistantStreamingState(threadId: threadId, turnId: resolvedTurnId)
        }

        if let resolvedTurnId,
           activeTurnIdByThread[threadId] == resolvedTurnId {
            setActiveTurnID(nil, for: threadId)
        } else if resolvedTurnId == nil {
            setActiveTurnID(nil, for: threadId)
        }

        if let resolvedTurnId,
           activeTurnId == resolvedTurnId {
            activeTurnId = nil
        }

        updateBackgroundRunGraceTask()

        // Some servers never emit explicit item/completed for reasoning/fileChange.
        // Close both turn-bound and orphan system stream rows, but keep reasoning content visible.
        if var threadMessages = messagesByThread[threadId] {
            var didMutate = false
            let belongsToCompletedTurn: (CodexMessage) -> Bool = { message in
                if let resolvedTurnId {
                    return message.turnId == resolvedTurnId || message.turnId == nil
                }
                return message.isStreaming
            }

            for index in threadMessages.indices where threadMessages[index].role == .system
                && threadMessages[index].isStreaming {
                let belongsToTurn = belongsToCompletedTurn(threadMessages[index])
                guard belongsToTurn else { continue }
                threadMessages[index].isStreaming = false
                didMutate = true
            }

            for index in threadMessages.indices where threadMessages[index].role == .system
                && threadMessages[index].kind == .plan {
                let belongsToTurn = belongsToCompletedTurn(threadMessages[index])
                guard belongsToTurn else { continue }

                switch threadMessages[index].resolvedPlanPresentation {
                case .resultCompletedItem:
                    let nextPresentation: CodexPlanPresentation = shouldFinalizePlanSteps ? .resultReady : .resultClosed
                    if threadMessages[index].planPresentation != nextPresentation {
                        threadMessages[index].planPresentation = nextPresentation
                    }
                    refreshDerivedPlanMetadata(in: &threadMessages, index: index)
                    didMutate = true
                case .resultStreaming:
                    if threadMessages[index].planPresentation != .resultClosed {
                        threadMessages[index].planPresentation = .resultClosed
                        threadMessages[index].proposedPlan = nil
                        didMutate = true
                    }
                default:
                    break
                }
            }

            // Successful completions can land before the server publishes a final
            // "all steps completed" plan snapshot, so normalize stale progress steps here.
            if shouldFinalizePlanSteps {
                let fallbackPlanIndex: Int? = {
                    guard resolvedTurnId == nil else { return nil }
                    return threadMessages.indices.reversed().first(where: { index in
                        let candidate = threadMessages[index]
                        return candidate.role == .system
                            && candidate.kind == .plan
                            && candidate.resolvedPlanPresentation == .progress
                            && candidate.planState?.steps.contains(where: { $0.status != .completed }) == true
                    })
                }()

                for index in threadMessages.indices where threadMessages[index].role == .system
                    && threadMessages[index].kind == .plan {
                    let belongsToTurn = belongsToCompletedTurn(threadMessages[index])
                        || fallbackPlanIndex == index
                    guard belongsToTurn,
                          threadMessages[index].resolvedPlanPresentation == .progress,
                          let planState = threadMessages[index].planState,
                          !planState.steps.isEmpty,
                          planState.steps.contains(where: { $0.status != .completed }) else {
                        continue
                    }

                    threadMessages[index].planState = CodexPlanState(
                        explanation: planState.explanation,
                        steps: planState.steps.map { step in
                            CodexPlanStep(id: step.id, step: step.step, status: .completed)
                        }
                    )
                    didMutate = true
                }
            }

            let priorCount = threadMessages.count
            if let resolvedTurnId {
                threadMessages.removeAll {
                    $0.role == .system
                        && $0.kind == .thinking
                        && ($0.turnId == resolvedTurnId || $0.turnId == nil)
                        && shouldPruneThinkingRowAfterTurnCompletion($0)
                }
            } else {
                threadMessages.removeAll {
                    $0.role == .system
                        && $0.kind == .thinking
                        && shouldPruneThinkingRowAfterTurnCompletion($0)
                }
            }
            if threadMessages.count != priorCount {
                didMutate = true
            }

            if didMutate {
                messagesByThread[threadId] = threadMessages
            }
        }

        streamingSystemMessageByItemID = streamingSystemMessageByItemID.filter { _, messageId in
            guard let index = findMessageIndex(threadId: threadId, messageId: messageId),
                  let message = messagesByThread[threadId]?[index] else {
                return false
            }
            guard message.role == .system else {
                return true
            }
            if message.kind == .thinking {
                return false
            }
            if let resolvedTurnId {
                return message.turnId != resolvedTurnId
            }
            return !message.isStreaming
        }

        // Keep turn->thread mapping after completion to support late-arriving
        // notifications (e.g. turn/diff/updated emitted right after turn/completed).
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    // Converts all pending streaming bubbles to completed state after transport failures.
    func finalizeAllStreamingState() {
        flushAllPendingStreamingDeltas()
        var didMutate = false

        for threadId in messagesByThread.keys {
            guard var threadMessages = messagesByThread[threadId] else { continue }

            var localChanged = false
            for index in threadMessages.indices where threadMessages[index].isStreaming {
                threadMessages[index].isStreaming = false
                localChanged = true
            }

            if localChanged {
                messagesByThread[threadId] = threadMessages
                didMutate = true
            }
        }

        activeTurnId = nil
        activeTurnIdByThread.removeAll()
        threadsPendingCompletionHaptic.removeAll()
        clearAllRunningState()
        streamingAssistantFallbackMessageByTurnID.removeAll()
        streamingAssistantMessageByItemKey.removeAll()
        streamingSystemMessageByItemID.removeAll()
        pendingAssistantDeltaByStreamID.removeAll()
        pendingAssistantDeltaContextByStreamID.removeAll()
        pendingAssistantDeltaStreamOrder.removeAll()
        pendingAssistantDeltaFlushTask?.cancel()
        pendingAssistantDeltaFlushTask = nil
        threadIdByTurnID.removeAll()

        if didMutate {
            persistCurrentMacMessages()
            if let activeThreadId {
                updateCurrentOutput(for: activeThreadId)
            }
        }
    }
}
