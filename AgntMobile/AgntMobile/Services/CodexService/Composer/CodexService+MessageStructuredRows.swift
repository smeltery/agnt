// FILE: CodexService+MessageStructuredRows.swift
// Purpose: Owns plan, subagent action, structured input, and regular system rows.
// Layer: Service
// Exports: CodexService structured row helpers
// Depends on: CodexMessage, JSONValue

import Foundation

extension CodexService {
    func appendSystemMessage(
        threadId: String,
        text: String,
        turnId: String? = nil,
        itemId: String? = nil,
        kind: CodexMessageKind = .chat,
        isStreaming: Bool = false
    ) {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty || isStreaming else {
            return
        }
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]

        if kind == .fileChange,
           let resolvedTurnId, !resolvedTurnId.isEmpty,
           var threadMessages = messagesByThread[threadId] {
            let incomingPathKeys = normalizedFileChangePathKeys(from: trimmedText)
            let isSnapshotPayload = isFileChangeSnapshotPayload(trimmedText)

            var targetIndex: Int?
            if !incomingPathKeys.isEmpty {
                targetIndex = threadMessages.indices.reversed().first(where: { index in
                    let candidate = threadMessages[index]
                    guard candidate.role == .system,
                          candidate.kind == .fileChange,
                          (candidate.turnId == resolvedTurnId
                              || (candidate.turnId == nil
                                  && turnlessFileChangeRowBelongsToTurn(candidate, threadId: threadId, turnId: resolvedTurnId))) else {
                        return false
                    }
                    let candidatePathKeys = normalizedFileChangePathKeys(from: candidate.text)
                    return !candidatePathKeys.isDisjoint(with: incomingPathKeys)
                })
            } else if isSnapshotPayload,
                      let existingID = uniqueFileChangeMessageIDForTurn(
                          threadId: threadId,
                          turnId: resolvedTurnId,
                          allowsTurnlessFallback: true
                      ) {
                targetIndex = threadMessages.firstIndex(where: { $0.id == existingID })
            }

            if targetIndex == nil {
                targetIndex = threadMessages.indices.reversed().first(where: { index in
                    let candidate = threadMessages[index]
                    return candidate.role == .system
                        && candidate.kind == .fileChange
                        && candidate.turnId == resolvedTurnId
                        && candidate.text.trimmingCharacters(in: .whitespacesAndNewlines) == trimmedText
                })
            }

            if let targetIndex {
                let existingText = threadMessages[targetIndex].text
                let nextText: String
                if isSnapshotPayload {
                    nextText = trimmedText
                } else {
                    nextText = mergeAssistantDelta(existingText: existingText, incomingDelta: trimmedText)
                }
                threadMessages[targetIndex].text = nextText
                threadMessages[targetIndex].isStreaming = isStreaming
                threadMessages[targetIndex].turnId = resolvedTurnId
                if threadMessages[targetIndex].itemId == nil {
                    threadMessages[targetIndex].itemId = itemId
                }
                let keepID = threadMessages[targetIndex].id
                pruneDuplicateSystemRows(
                    in: &threadMessages,
                    keepIndex: targetIndex,
                    kind: .fileChange,
                    turnId: resolvedTurnId,
                    fileChangePathKeys: incomingPathKeys
                )
                if let refreshedIndex = threadMessages.indices.first(where: { threadMessages[$0].id == keepID }) {
                    threadMessages[refreshedIndex].orderIndex = CodexMessageOrderCounter.next()
                }
                threadMessages.sort(by: { $0.orderIndex < $1.orderIndex })
                messagesByThread[threadId] = threadMessages
                persistMessages()
                updateCurrentOutput(for: threadId)
                return
            }
        }

        appendMessage(
            CodexMessage(
                threadId: threadId,
                role: .system,
                kind: kind,
                text: trimmedText,
                turnId: resolvedTurnId,
                itemId: itemId,
                isStreaming: isStreaming,
                deliveryState: .confirmed
            )
        )
    }

    // Upserts the inline plan card so streamed deltas and final plan text stay on one row.
    func upsertPlanMessage(
        threadId: String,
        turnId: String?,
        itemId: String?,
        text: String? = nil,
        explanation: String? = nil,
        steps: [CodexPlanStep]? = nil,
        isStreaming: Bool,
        planPresentation: CodexPlanPresentation
    ) {
        if let itemId, !itemId.isEmpty {
            upsertStreamingSystemItemMessage(
                threadId: threadId,
                turnId: turnId,
                itemId: itemId,
                kind: .plan,
                text: text ?? "",
                isStreaming: isStreaming
            )
        } else if let turnId, !turnId.isEmpty {
            upsertStreamingSystemTurnMessage(
                threadId: threadId,
                turnId: turnId,
                kind: .plan,
                text: text ?? "",
                isStreaming: isStreaming
            )
        } else {
            appendSystemMessage(
                threadId: threadId,
                text: text ?? "",
                turnId: turnId,
                itemId: itemId,
                kind: .plan,
                isStreaming: isStreaming
            )
        }

        guard let messageIndex = findLatestPlanMessageIndex(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            planPresentation: planPresentation
        ) else {
            return
        }

        var planState = messagesByThread[threadId]?[messageIndex].planState ?? CodexPlanState()
        if let explanation {
            let trimmedExplanation = explanation.trimmingCharacters(in: .whitespacesAndNewlines)
            planState.explanation = trimmedExplanation.isEmpty ? nil : trimmedExplanation
        }
        if let steps {
            planState.steps = steps
        }
        messagesByThread[threadId]?[messageIndex].planState = planState
        messagesByThread[threadId]?[messageIndex].planPresentation = resolvedPlanPresentation(
            requested: planPresentation,
            turnId: turnId,
            threadId: threadId
        )
        refreshDerivedPlanMetadata(threadId: threadId, messageIndex: messageIndex)
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    @discardableResult
    func finalizeExistingPlanMessage(
        threadId: String,
        turnId: String?,
        itemId: String?
    ) -> Bool {
        guard let messageIndex = findLatestPlanMessageIndex(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            planPresentation: .resultStreaming
        ),
        let message = messagesByThread[threadId]?[messageIndex],
        message.role == .system,
        message.kind == .plan else {
            return false
        }

        messagesByThread[threadId]?[messageIndex].isStreaming = false
        messagesByThread[threadId]?[messageIndex].planPresentation = resolvedPlanPresentation(
            requested: .resultCompletedItem,
            turnId: turnId,
            threadId: threadId
        )
        refreshDerivedPlanMetadata(threadId: threadId, messageIndex: messageIndex)
        streamingSystemMessageByItemID = streamingSystemMessageByItemID.filter { _, messageID in
            messageID != message.id
        }
        persistMessages()
        updateCurrentOutput(for: threadId)
        return true
    }

    // Keeps multi-agent orchestration events on a single structured timeline row.
    func upsertSubagentActionMessage(
        threadId: String,
        turnId: String?,
        itemId: String?,
        action: CodexSubagentAction,
        isStreaming: Bool
    ) {
        let summaryText = action.summaryText
        registerSubagentThreads(action: action, parentThreadId: threadId)
        let resolvedItemId = resolvedSubagentActionItemId(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            action: action
        )

        if let resolvedItemId, !resolvedItemId.isEmpty {
            upsertStreamingSystemItemMessage(
                threadId: threadId,
                turnId: turnId,
                itemId: resolvedItemId,
                kind: .subagentAction,
                text: summaryText,
                isStreaming: isStreaming
            )
        } else {
            appendSystemMessage(
                threadId: threadId,
                text: summaryText,
                turnId: turnId,
                itemId: resolvedItemId,
                kind: .subagentAction,
                isStreaming: isStreaming
            )
        }

        guard let messageIndex = findLatestSubagentActionMessageIndex(
            threadId: threadId,
            turnId: turnId,
            itemId: resolvedItemId
        ) else {
            return
        }

        messagesByThread[threadId]?[messageIndex].text = summaryText
        messagesByThread[threadId]?[messageIndex].subagentAction = action
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    private func resolvedSubagentActionItemId(
        threadId: String,
        turnId: String?,
        itemId: String?,
        action: CodexSubagentAction
    ) -> String? {
        if let itemId = normalizedStreamingItemID(itemId) {
            if let turnId = normalizedStreamingItemID(turnId), !turnId.isEmpty {
                rebindMatchingSyntheticSubagentActionMessageIfNeeded(
                    threadId: threadId,
                    turnId: turnId,
                    realItemId: itemId,
                    action: action
                )
            }
            return itemId
        }

        guard let turnId = normalizedStreamingItemID(turnId), !turnId.isEmpty else {
            return nil
        }

        if let existingItemId = matchingSubagentActionMessage(
            threadId: threadId,
            turnId: turnId,
            action: action
        )?.itemId {
            return existingItemId
        }

        return nextSyntheticSubagentActionItemId(threadId: threadId, turnId: turnId)
    }

    private func matchingSubagentActionMessage(
        threadId: String,
        turnId: String,
        action: CodexSubagentAction
    ) -> CodexMessage? {
        let incomingPrompt = normalizedIdentifier(action.prompt)
        let incomingModel = normalizedIdentifier(action.model)

        return messagesByThread[threadId]?.reversed().first(where: { candidate in
            guard candidate.role == .system,
                  candidate.kind == .subagentAction,
                  candidate.turnId == turnId,
                  let candidateAction = candidate.subagentAction,
                  candidateAction.normalizedTool == action.normalizedTool else {
                return false
            }

            guard candidate.isStreaming,
                  candidate.text == action.summaryText else {
                return false
            }

            let candidatePrompt = normalizedIdentifier(candidateAction.prompt)
            let candidateModel = normalizedIdentifier(candidateAction.model)
            if let incomingPrompt, incomingPrompt == candidatePrompt {
                return true
            }
            if incomingPrompt == nil,
               let incomingModel,
               incomingModel == candidateModel {
                return true
            }

            return false
        })
    }

    private func nextSyntheticSubagentActionItemId(threadId: String, turnId: String) -> String {
        let prefix = syntheticSubagentActionItemIdPrefix(turnId: turnId)
        let existingCount = messagesByThread[threadId]?.reduce(into: 0) { count, candidate in
            guard candidate.role == .system,
                  candidate.kind == .subagentAction,
                  candidate.turnId == turnId,
                  candidate.itemId?.hasPrefix(prefix) == true else {
                return
            }
            count += 1
        } ?? 0

        return "\(prefix)\(existingCount + 1)"
    }

    private func rebindMatchingSyntheticSubagentActionMessageIfNeeded(
        threadId: String,
        turnId: String,
        realItemId: String,
        action: CodexSubagentAction
    ) {
        let realKey = streamingItemMessageKey(threadId: threadId, itemId: realItemId)
        guard streamingSystemMessageByItemID[realKey] == nil,
              let existing = matchingSubagentActionMessage(threadId: threadId, turnId: turnId, action: action),
              let existingItemId = normalizedStreamingItemID(existing.itemId),
              existingItemId.hasPrefix(syntheticSubagentActionItemIdPrefix(turnId: turnId)),
              let messageIndex = findMessageIndex(threadId: threadId, messageId: existing.id) else {
            return
        }

        let existingKey = streamingItemMessageKey(threadId: threadId, itemId: existingItemId)
        messagesByThread[threadId]?[messageIndex].itemId = realItemId
        if let existingMessageId = streamingSystemMessageByItemID[existingKey] {
            streamingSystemMessageByItemID[realKey] = existingMessageId
            streamingSystemMessageByItemID.removeValue(forKey: existingKey)
        }
    }

    // Adds or refreshes an inline structured question card for plan mode clarification requests.
    func upsertStructuredUserInputPrompt(
        threadId: String,
        turnId: String?,
        itemId: String,
        request: CodexStructuredUserInputRequest
    ) {
        let fallbackText = request.questions
            .map { question in
                let header = question.header.trimmingCharacters(in: .whitespacesAndNewlines)
                let prompt = question.question.trimmingCharacters(in: .whitespacesAndNewlines)
                if header.isEmpty {
                    return prompt
                }
                return "\(header)\n\(prompt)"
            }
            .joined(separator: "\n\n")

        if let existingIndex = messagesByThread[threadId]?.indices.reversed().first(where: { index in
            let candidate = messagesByThread[threadId]?[index]
            return candidate?.role == .system
                && candidate?.kind == .userInputPrompt
                && candidate?.structuredUserInputRequest?.requestID == request.requestID
        }) {
            messagesByThread[threadId]?[existingIndex].text = fallbackText
            messagesByThread[threadId]?[existingIndex].turnId = turnId ?? messagesByThread[threadId]?[existingIndex].turnId
            messagesByThread[threadId]?[existingIndex].itemId = itemId
            messagesByThread[threadId]?[existingIndex].structuredUserInputRequest = request
            persistMessages()
            updateCurrentOutput(for: threadId)
            return
        }

        appendMessage(
            CodexMessage(
                threadId: threadId,
                role: .system,
                kind: .userInputPrompt,
                text: fallbackText,
                turnId: turnId,
                itemId: itemId,
                structuredUserInputRequest: request
            )
        )
    }

    // Removes resolved inline prompt cards once the server confirms the request lifecycle ended.
    func removeStructuredUserInputPrompt(requestID: JSONValue, threadIdHint: String? = nil) {
        let threadIDs = threadIdHint.map { [$0] } ?? Array(messagesByThread.keys)
        var didMutate = false

        for threadId in threadIDs {
            guard var threadMessages = messagesByThread[threadId] else {
                continue
            }

            let previousCount = threadMessages.count
            threadMessages.removeAll { message in
                message.kind == .userInputPrompt
                    && message.structuredUserInputRequest?.requestID == requestID
            }

            if threadMessages.count != previousCount {
                messagesByThread[threadId] = threadMessages
                didMutate = true
            }
        }

        guard didMutate else {
            return
        }

        persistMessages()
        if let activeThreadId {
            updateCurrentOutput(for: activeThreadId)
        }
    }

    // Clears all unresolved structured prompts in a thread when the user exits native plan mode.
    func removeAllStructuredUserInputPrompts(threadId: String) {
        guard var threadMessages = messagesByThread[threadId] else {
            return
        }

        let previousCount = threadMessages.count
        threadMessages.removeAll { message in
            message.kind == .userInputPrompt
        }

        guard threadMessages.count != previousCount else {
            return
        }

        messagesByThread[threadId] = threadMessages
        persistMessages()
        if let activeThreadId {
            updateCurrentOutput(for: activeThreadId)
        }
    }

    // Persists a hidden push-reset marker across all threads bound to the same repo.
}
