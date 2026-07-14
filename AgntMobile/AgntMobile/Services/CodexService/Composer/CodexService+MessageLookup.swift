// FILE: CodexService+MessageLookup.swift
// Purpose: Message append, indexing, plan metadata, and activity lookup helpers.
// Layer: Service

import Foundation

extension CodexService {
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

}
