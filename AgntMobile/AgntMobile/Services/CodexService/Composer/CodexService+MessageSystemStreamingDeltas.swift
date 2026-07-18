// FILE: CodexService+MessageSystemStreamingDeltas.swift
// Purpose: Streaming system delta buffering, flushing, late merge, and completion.
// Layer: Service

import Foundation

extension CodexService {
    // Appends deltas to an existing system item message.
    func appendStreamingSystemItemDelta(
        threadId: String,
        turnId: String?,
        itemId: String,
        kind: CodexMessageKind,
        delta: String
    ) {
        // Preserve token-leading spaces from server deltas (for example Markdown words split by stream).
        guard !delta.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }

        enqueueStreamingSystemItemDelta(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            kind: kind,
            delta: delta
        )
    }

    // Buffers reasoning/system deltas so thinking rows do not force one UI refresh per token.
    private func enqueueStreamingSystemItemDelta(
        threadId: String,
        turnId: String?,
        itemId: String,
        kind: CodexMessageKind,
        delta: String
    ) {
        let key = streamingItemMessageKey(threadId: threadId, itemId: itemId)
        if pendingSystemDeltasByKey[key] == nil {
            pendingSystemDeltasByKey[key] = PendingSystemStreamingDeltas(
                threadId: threadId,
                turnId: turnId,
                itemId: itemId,
                kind: kind,
                deltas: []
            )
        }
        pendingSystemDeltasByKey[key]?.deltas.append(delta)

        guard systemDeltaFlushTasksByKey[key] == nil else { return }
        systemDeltaFlushTasksByKey[key] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: StreamingDeltaCoalescingPolicy.flushDelayNanoseconds)
            guard !Task.isCancelled else { return }
            self?.flushPendingSystemDeltas(forKey: key)
        }
    }

    private func applyStreamingSystemDeltas(_ pending: PendingSystemStreamingDeltas) {
        upsertStreamingSystemItemMessage(
            threadId: pending.threadId,
            turnId: pending.turnId,
            itemId: pending.itemId,
            kind: pending.kind,
            text: pending.deltas.joined(),
            isStreaming: true
        )
    }

    func flushPendingSystemDeltas(threadId: String, itemId: String) {
        flushPendingSystemDeltas(forKey: streamingItemMessageKey(threadId: threadId, itemId: itemId))
    }

    func flushPendingSystemDeltasForTurn(threadId: String, turnId: String?) {
        let keys = pendingSystemDeltasByKey
            .filter { _, pending in
                guard pending.threadId == threadId else { return false }
                guard let turnId else { return true }
                return pending.turnId == turnId
            }
            .map(\.key)
        for key in keys {
            flushPendingSystemDeltas(forKey: key)
        }
    }

    private func flushPendingSystemDeltas(forKey key: String) {
        systemDeltaFlushTasksByKey[key]?.cancel()
        systemDeltaFlushTasksByKey.removeValue(forKey: key)
        guard let pending = pendingSystemDeltasByKey.removeValue(forKey: key) else {
            return
        }
        applyStreamingSystemDeltas(pending)
    }

    func flushAllPendingStreamingDeltas() {
        flushPendingAssistantDeltas()
        for key in Array(pendingSystemDeltasByKey.keys) {
            flushPendingSystemDeltas(forKey: key)
        }
    }

    func cancelPendingStreamingDeltaFlushes(for threadId: String) {
        let assistantStreamIDs = pendingAssistantDeltaContextByStreamID
            .filter { $0.value.threadId == threadId }
            .map(\.key)
        for streamID in assistantStreamIDs {
            pendingAssistantDeltaByStreamID.removeValue(forKey: streamID)
            pendingAssistantDeltaContextByStreamID.removeValue(forKey: streamID)
            pendingAssistantDeltaStreamOrder.removeAll { $0 == streamID }
        }
        if pendingAssistantDeltaByStreamID.isEmpty {
            pendingAssistantDeltaFlushTask?.cancel()
            pendingAssistantDeltaFlushTask = nil
        }

        let systemKeys = pendingSystemDeltasByKey
            .filter { $0.value.threadId == threadId }
            .map(\.key)
        for key in systemKeys {
            systemDeltaFlushTasksByKey[key]?.cancel()
            systemDeltaFlushTasksByKey.removeValue(forKey: key)
            pendingSystemDeltasByKey.removeValue(forKey: key)
        }
    }

    func cancelAllPendingStreamingDeltaFlushes() {
        pendingAssistantDeltaFlushTask?.cancel()
        pendingAssistantDeltaFlushTask = nil
        pendingAssistantDeltaByStreamID.removeAll()
        pendingAssistantDeltaContextByStreamID.removeAll()
        pendingAssistantDeltaStreamOrder.removeAll()
        systemDeltaFlushTasksByKey.values.forEach { $0.cancel() }
        systemDeltaFlushTasksByKey.removeAll()
        pendingSystemDeltasByKey.removeAll()
    }

    // Merges a late reasoning delta into an existing thinking row without reopening streaming state.
    // Returns true when a matching row was found and updated.
    func mergeLateReasoningDeltaIfPossible(
        threadId: String,
        turnId: String?,
        itemId: String?,
        delta: String
    ) -> Bool {
        let trimmedDelta = delta.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedDelta.isEmpty,
              var threadMessages = messagesByThread[threadId] else {
            return false
        }

        let normalizedTurnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines)

        let targetIndex: Int? = {
            if let normalizedItemId, !normalizedItemId.isEmpty {
                if let index = threadMessages.indices.reversed().first(where: { index in
                    let candidate = threadMessages[index]
                    return candidate.role == .system
                        && candidate.kind == .thinking
                        && candidate.itemId == normalizedItemId
                }) {
                    return index
                }
            }

            if let normalizedTurnId, !normalizedTurnId.isEmpty {
                return threadMessages.indices.reversed().first(where: { index in
                    let candidate = threadMessages[index]
                    return candidate.role == .system
                        && candidate.kind == .thinking
                        && candidate.turnId == normalizedTurnId
                })
            }

            return nil
        }()

        guard let targetIndex else {
            return false
        }

        let existingText = threadMessages[targetIndex].text
        threadMessages[targetIndex].text = mergeAssistantDelta(
            existingText: existingText,
            incomingDelta: delta
        )
        threadMessages[targetIndex].isStreaming = false
        if threadMessages[targetIndex].turnId == nil,
           let normalizedTurnId, !normalizedTurnId.isEmpty {
            threadMessages[targetIndex].turnId = normalizedTurnId
        }
        if threadMessages[targetIndex].itemId == nil,
           let normalizedItemId, !normalizedItemId.isEmpty {
            threadMessages[targetIndex].itemId = normalizedItemId
        }

        messagesByThread[threadId] = threadMessages
        persistMessages()
        updateCurrentOutput(for: threadId)
        return true
    }

    // Uses a stable synthetic item id when server deltas miss itemId.
    func appendStreamingSystemTurnDelta(
        threadId: String,
        turnId: String,
        kind: CodexMessageKind,
        delta: String
    ) {
        appendStreamingSystemItemDelta(
            threadId: threadId,
            turnId: turnId,
            itemId: syntheticStreamingItemId(turnId: turnId, kind: kind),
            kind: kind,
            delta: delta
        )
    }

    // Upserts synthetic turn-based stream entries when no itemId exists.
    func upsertStreamingSystemTurnMessage(
        threadId: String,
        turnId: String,
        kind: CodexMessageKind,
        text: String,
        isStreaming: Bool
    ) {
        upsertStreamingSystemItemMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: syntheticStreamingItemId(turnId: turnId, kind: kind),
            kind: kind,
            text: text,
            isStreaming: isStreaming
        )
    }

    // Finalizes a system item message when the item completes.
    func completeStreamingSystemItemMessage(
        threadId: String,
        turnId: String?,
        itemId: String,
        kind: CodexMessageKind,
        text: String?
    ) {
        flushPendingSystemDeltas(threadId: threadId, itemId: itemId)
        let key = streamingItemMessageKey(threadId: threadId, itemId: itemId)
        let completedMessageID = streamingSystemMessageByItemID[key]
        upsertStreamingSystemItemMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            kind: kind,
            text: text ?? "",
            isStreaming: false
        )

        if let messageID = completedMessageID ?? streamingSystemMessageByItemID[key],
           let index = findMessageIndex(threadId: threadId, messageId: messageID) {
            messagesByThread[threadId]?[index].isStreaming = false
            messagesByThread[threadId]?[index].kind = kind

            if kind == .toolActivity,
               let finalText = messagesByThread[threadId]?[index].text,
               isStreamingPlaceholder(finalText, for: .toolActivity) {
                messagesByThread[threadId]?.removeAll { $0.id == messageID }
                updateCurrentOutput(for: threadId)
            }

            persistMessages()
        }

        if let completedMessageID = completedMessageID ?? streamingSystemMessageByItemID[key] {
            streamingSystemMessageByItemID = streamingSystemMessageByItemID.filter { _, value in
                value != completedMessageID
            }
        } else {
            streamingSystemMessageByItemID.removeValue(forKey: key)
        }
    }

    // Completes synthetic turn-based stream entries when no itemId exists.
    func completeStreamingSystemTurnMessage(
        threadId: String,
        turnId: String,
        kind: CodexMessageKind,
        text: String?
    ) {
        completeStreamingSystemItemMessage(
            threadId: threadId,
            turnId: turnId,
            itemId: syntheticStreamingItemId(turnId: turnId, kind: kind),
            kind: kind,
            text: text
        )
    }
}
