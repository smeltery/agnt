// FILE: CodexService+AssistantCompletion.swift
// Purpose: Reconciles assistant completion payloads with streamed and replayed message rows.
// Layer: Service
// Exports: CodexService assistant completion helpers
// Depends on: Foundation

import Foundation

extension CodexService {
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

}
