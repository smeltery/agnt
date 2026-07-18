import Foundation

extension TurnTimelineReducer {
    static func removeDuplicateAssistantMessages(in messages: [CodexMessage]) -> [CodexMessage] {
        var seenKeys: Set<String> = []
        var seenNoTurnByText: [String: Date] = [:]
        var seenTurnText: [String: AssistantTurnTextObservation] = [:]
        var result: [CodexMessage] = []
        result.reserveCapacity(messages.count)

        for message in messages {
            guard message.role == .assistant else {
                result.append(message)
                continue
            }

            guard hasMeaningfulMessageText(message.text) else {
                result.append(message)
                continue
            }

            if isAssistantBlockReplay(in: result, incoming: message) {
                continue
            }

            if let turnId = message.turnId, !turnId.isEmpty {
                if let exactReplayIndex = result.indices.reversed().first(where: {
                    shouldMergeExactAssistantReplay(previous: result[$0], incoming: message)
                }) {
                    result[exactReplayIndex] = mergedExactAssistantReplay(
                        previous: result[exactReplayIndex],
                        incoming: message
                    )
                    continue
                }

                if let replayIndex = result.indices.reversed().first(where: {
                    shouldMergeAssistantReplay(previous: result[$0], incoming: message)
                }) {
                    if assistantReplayTextAlreadyRepresented(
                        previous: result[replayIndex].text,
                        incoming: message.text
                    ) {
                        continue
                    }

                    var merged = result[replayIndex]
                    merged.text = message.text
                    merged.isStreaming = message.isStreaming
                    if merged.itemId == nil {
                        merged.itemId = message.itemId
                    }
                    result[replayIndex] = merged
                    continue
                }

                if let normalizedText = normalizedSmallMessageText(message.text) {
                    let dedupeScope = normalizedIdentifier(message.itemId)
                    let key = "\(turnId)|\(dedupeScope ?? "no-item")|\(normalizedText)"
                    if seenKeys.contains(key) {
                        continue
                    }

                    let hasStableIdentity = dedupeScope != nil
                    let turnTextKey = "\(turnId)|\(normalizedText)"
                    if let previous = seenTurnText[turnTextKey],
                       abs(message.createdAt.timeIntervalSince(previous.createdAt)) <= 12,
                       !previous.hasStableIdentity || !hasStableIdentity {
                        continue
                    }
                    seenKeys.insert(key)
                    seenTurnText[turnTextKey] = AssistantTurnTextObservation(
                        createdAt: message.createdAt,
                        hasStableIdentity: hasStableIdentity
                    )
                }
                result.append(message)
                continue
            }

            if let normalizedText = normalizedSmallMessageText(message.text) {
                if let previous = seenNoTurnByText[normalizedText],
                   abs(message.createdAt.timeIntervalSince(previous)) <= 12 {
                    continue
                }

                seenNoTurnByText[normalizedText] = message.createdAt
            }
            result.append(message)
        }

        return result
    }

    struct AssistantTurnTextObservation {
        let createdAt: Date
        let hasStableIdentity: Bool
    }

    // Folds duplicate final-answer items even when history/live replay assigned different stable item ids.
    static func shouldMergeExactAssistantReplay(previous: CodexMessage, incoming: CodexMessage) -> Bool {
        guard previous.role == .assistant,
              incoming.role == .assistant,
              previous.threadId == incoming.threadId,
              normalizedIdentifier(previous.turnId) == normalizedIdentifier(incoming.turnId) else {
            return false
        }

        guard messageTextsMatchForDedupe(previous.text, incoming.text),
              previous.text.count >= 24 else {
            return false
        }

        return true
    }

    static func mergedExactAssistantReplay(previous: CodexMessage, incoming: CodexMessage) -> CodexMessage {
        var merged = previous
        merged.isStreaming = previous.isStreaming && incoming.isStreaming
        if merged.turnId == nil {
            merged.turnId = incoming.turnId
        }
        if normalizedIdentifier(merged.itemId) == nil || isProvisionalAssistantIdentity(merged.itemId) {
            merged.itemId = incoming.itemId ?? merged.itemId
        }
        if incoming.text.count > merged.text.count {
            merged.text = incoming.text
        }
        return merged
    }

    // Collapses persisted replay rows where a late delta duplicated part of the final answer.
    static func shouldMergeAssistantReplay(previous: CodexMessage, incoming: CodexMessage) -> Bool {
        guard previous.role == .assistant,
              incoming.role == .assistant,
              previous.threadId == incoming.threadId,
              normalizedIdentifier(previous.turnId) == normalizedIdentifier(incoming.turnId) else {
            return false
        }

        let previousItemId = normalizedIdentifier(previous.itemId)
        let incomingItemId = normalizedIdentifier(incoming.itemId)
        if let previousItemId, let incomingItemId, previousItemId != incomingItemId {
            return false
        }
        guard isProvisionalAssistantIdentity(previousItemId) || isProvisionalAssistantIdentity(incomingItemId) else {
            return false
        }

        guard previous.text.utf8.count <= largeTextDedupeByteLimit,
              incoming.text.utf8.count <= largeTextDedupeByteLimit else {
            return false
        }
        let previousText = previous.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let incomingText = incoming.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard min(previousText.count, incomingText.count) >= 24 else {
            return false
        }

        return previousText.contains(incomingText) || incomingText.contains(previousText)
    }

    // Detects final-completion replays that resend all prior assistant rows for a turn.
    static func isAssistantBlockReplay(in messages: [CodexMessage], incoming: CodexMessage) -> Bool {
        AssistantReplayDeduper.isReplayMessage(
            in: messages,
            threadId: incoming.threadId,
            turnId: incoming.turnId,
            text: incoming.text,
            excludingMessageID: incoming.id
        )
    }

    static func isProvisionalAssistantIdentity(_ itemId: String?) -> Bool {
        guard let itemId else {
            return true
        }
        return CodexSyntheticIdentifiers.isMirrorMintedItemID(itemId)
    }

    // Keeps only the newest matching file-change card when multiple event channels emit the same diff.
}
