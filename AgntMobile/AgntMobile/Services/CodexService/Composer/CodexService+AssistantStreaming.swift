// FILE: CodexService+AssistantStreaming.swift
// Purpose: Owns assistant streaming row creation and delta application.
// Layer: Service
// Exports: CodexService assistant streaming helpers
// Depends on: Foundation

import Foundation

extension CodexService {
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

}
