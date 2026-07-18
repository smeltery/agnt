import Foundation

extension TurnTimelineReducer {
    static func collapseThinkingMessages(in messages: [CodexMessage]) -> [CodexMessage] {
        var result: [CodexMessage] = []
        result.reserveCapacity(messages.count)

        for message in messages {
            guard message.role == .system, message.kind == .thinking else {
                result.append(message)
                continue
            }

            guard let previousIndex = latestReusableThinkingIndex(in: result, for: message) else {
                result.append(message)
                continue
            }

            var previous = result[previousIndex]
            let incoming = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !incoming.isEmpty {
                previous.text = mergeThinkingText(existing: previous.text, incoming: incoming)
            }

            // The newest thinking row should own the final streaming/completed state.
            previous.isStreaming = message.isStreaming
            previous.turnId = message.turnId ?? previous.turnId
            previous.itemId = message.itemId ?? previous.itemId
            result[previousIndex] = previous
        }

        return result
    }

    // Reuses the latest thinking row in the current system segment until user/assistant content resumes.
    static func latestReusableThinkingIndex(
        in messages: [CodexMessage],
        for incoming: CodexMessage
    ) -> Int? {
        for index in messages.indices.reversed() {
            let candidate = messages[index]
            if candidate.role == .assistant || candidate.role == .user {
                break
            }

            guard candidate.role == .system, candidate.kind == .thinking else {
                continue
            }

            if shouldMergeThinkingRows(previous: candidate, incoming: incoming) {
                return index
            }
        }

        return nil
    }

    // Coalesces thinking rows inside one system segment even when identifiers arrive late.
    static func shouldMergeThinkingRows(previous: CodexMessage, incoming: CodexMessage) -> Bool {
        let previousItemId = normalizedIdentifier(previous.itemId)
        let incomingItemId = normalizedIdentifier(incoming.itemId)
        if let previousItemId, let incomingItemId,
           previousItemId == incomingItemId {
            return true
        }

        guard hasCompatibleThinkingTurnScope(previous: previous, incoming: incoming) else {
            return false
        }

        if isPlaceholderThinkingRow(previous) {
            return true
        }

        let previousHasStableIdentity = hasStableThinkingIdentity(previous)
        let incomingHasStableIdentity = hasStableThinkingIdentity(incoming)

        if previousHasStableIdentity,
           incomingHasStableIdentity,
           previousItemId != nil,
           incomingItemId != nil {
            return false
        }

        if isPlaceholderThinkingRow(incoming) {
            return !previousHasStableIdentity
        }

        if !previousHasStableIdentity || !incomingHasStableIdentity {
            return thinkingSnapshotsOverlap(previous: previous, incoming: incoming)
        }

        return false
    }

    static func normalizedIdentifier(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // Allows late turn ids to attach to the current system segment without crossing turn boundaries.
    static func hasCompatibleThinkingTurnScope(previous: CodexMessage, incoming: CodexMessage) -> Bool {
        let previousTurnId = normalizedIdentifier(previous.turnId)
        let incomingTurnId = normalizedIdentifier(incoming.turnId)
        guard let previousTurnId, let incomingTurnId else {
            return true
        }
        return previousTurnId == incomingTurnId
    }

    // Treats synthetic turn-scoped and rollout-mirror thinking ids as unstable
    // so a later real item can reuse the row instead of stacking a duplicate.
    // Deliberately narrower than isMirrorMintedItemID: only this kind's own
    // placeholder is unstable, other kinds' placeholders stay distinct.
    static func hasStableThinkingIdentity(_ message: CodexMessage) -> Bool {
        guard let itemId = normalizedIdentifier(message.itemId) else {
            return false
        }
        if CodexSyntheticIdentifiers.isRolloutMintedItemID(itemId) {
            return false
        }
        return !CodexSyntheticIdentifiers.isPlaceholderItemID(itemId, kind: .thinking)
    }

    // Identifies placeholder-only rows that should be reused instead of stacked.
    static func isPlaceholderThinkingRow(_ message: CodexMessage) -> Bool {
        ThinkingDisclosureParser.normalizedThinkingContent(from: message.text).isEmpty
    }

    // Merges streaming/history snapshots only when their visible reasoning content overlaps.
    static func thinkingSnapshotsOverlap(previous: CodexMessage, incoming: CodexMessage) -> Bool {
        let previousText = ThinkingDisclosureParser.normalizedThinkingContent(from: previous.text)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let incomingText = ThinkingDisclosureParser.normalizedThinkingContent(from: incoming.text)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !previousText.isEmpty, !incomingText.isEmpty else {
            return previousText.isEmpty || incomingText.isEmpty
        }

        let previousLower = previousText.lowercased()
        let incomingLower = incomingText.lowercased()
        return previousLower == incomingLower
            || previousLower.contains(incomingLower)
            || incomingLower.contains(previousLower)
    }

    // Preserves useful activity lines while still allowing newer thinking snapshots to win.
    static func mergeThinkingText(existing: String, incoming: String) -> String {
        let existingTrimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
        let incomingTrimmed = incoming.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !incomingTrimmed.isEmpty else { return existingTrimmed }
        guard !existingTrimmed.isEmpty else { return incomingTrimmed }

        let placeholderValues: Set<String> = ["thinking..."]
        let existingLower = existingTrimmed.lowercased()
        let incomingLower = incomingTrimmed.lowercased()

        if placeholderValues.contains(incomingLower) {
            return existingTrimmed
        }
        if placeholderValues.contains(existingLower) {
            return incomingTrimmed
        }

        if incomingLower == existingLower {
            return incomingTrimmed
        }
        if incomingTrimmed.contains(existingTrimmed) {
            return incomingTrimmed
        }
        if existingTrimmed.contains(incomingTrimmed) {
            return existingTrimmed
        }

        return "\(existingTrimmed)\n\(incomingTrimmed)"
    }

    // Hides command-status echoes that are already rendered as dedicated command cards.
    static func removeRedundantThinkingCommandActivityMessages(
        in messages: [CodexMessage]
    ) -> [CodexMessage] {
        let commandKeysByTurn = messages.reduce(into: [String: Set<String>]()) { partialResult, message in
            guard message.role == .system,
                  message.kind == .commandExecution,
                  let turnId = normalizedIdentifier(message.turnId),
                  let commandKey = commandActivityKey(from: message.text) else {
                return
            }
            partialResult[turnId, default: Set<String>()].insert(commandKey)
        }

        guard !commandKeysByTurn.isEmpty else {
            return messages
        }

        return messages.filter { message in
            guard message.role == .system,
                  message.kind == .thinking,
                  let turnId = normalizedIdentifier(message.turnId),
                  let commandKeys = commandKeysByTurn[turnId] else {
                return true
            }

            let normalizedThinking = ThinkingDisclosureParser.normalizedThinkingContent(from: message.text)
            let lines = normalizedThinking
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            guard !lines.isEmpty else {
                return true
            }

            return !lines.allSatisfy { line in
                guard let commandKey = commandActivityKey(from: line) else {
                    return false
                }
                return commandKeys.contains(commandKey)
            }
        }
    }

    static func commandActivityKey(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        let tokens = trimmed
            .split(whereSeparator: \.isWhitespace)
            .map(String.init)
        guard tokens.count >= 2 else {
            return nil
        }

        let status = tokens[0].lowercased()
        guard status == "running"
            || status == "completed"
            || status == "failed"
            || status == "stopped" else {
            return nil
        }

        let command = tokens
            .dropFirst()
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return command.isEmpty ? nil : command
    }

}
