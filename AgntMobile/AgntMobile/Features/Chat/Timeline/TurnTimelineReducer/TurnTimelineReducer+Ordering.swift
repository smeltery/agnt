import Foundation

extension TurnTimelineReducer {
    static func enforceIntraTurnOrder(in messages: [CodexMessage]) -> [CodexMessage] {
        // Collect indices belonging to each turnId (may be scattered across the array).
        var indicesByTurn: [String: [Int]] = [:]
        for (index, message) in messages.enumerated() {
            guard let turnId = message.turnId, !turnId.isEmpty else { continue }
            indicesByTurn[turnId, default: []].append(index)
        }

        var result = messages

        for (_, indices) in indicesByTurn {
            guard indices.count > 1 else { continue }

            let turnMessages = indices.map { result[$0] }

            let sorted: [CodexMessage]
            if hasInterleavedUserFlow(turnMessages) {
                // Steer can append a later user row into the still-active turn before the
                // assistant emits another distinct item. Preserve chronology so that user
                // prompt stays visible near the tail instead of jumping to the turn start.
                sorted = movingFileChangesToTurnTail(
                    in: turnMessages.sorted { $0.orderIndex < $1.orderIndex }
                )
            } else if hasInterleavedAssistantActivityFlow(turnMessages) {
                // Multi-item turn: keep the streamed interleaving intact. If the turn has
                // only one user prompt, we can still float that original opener forward.
                // Once a second user row exists, treat it as an in-turn steer and preserve
                // full chronological order so it stays near the bottom of the active run.
                let userCount = turnMessages.reduce(into: 0) { partialResult, message in
                    if message.role == .user {
                        partialResult += 1
                    }
                }
                let openingUserID = userCount == 1
                    ? turnMessages
                        .filter { $0.role == .user }
                        .min(by: { $0.orderIndex < $1.orderIndex })?
                        .id
                    : nil

                let chronological = turnMessages.sorted { a, b in
                    let aIsOpeningUser = openingUserID != nil && a.id == openingUserID
                    let bIsOpeningUser = openingUserID != nil && b.id == openingUserID
                    if aIsOpeningUser != bIsOpeningUser { return aIsOpeningUser }
                    return a.orderIndex < b.orderIndex
                }
                sorted = movingFileChangesToTurnTail(in: chronological)
            } else {
                // Single-item turn: apply normal role-based ordering.
                sorted = turnMessages.sorted { a, b in
                    let pA = intraTurnPriority(a)
                    let pB = intraTurnPriority(b)
                    if pA != pB { return pA < pB }
                    return intraTurnTieBreak(a, b)
                }
            }

            // Place sorted messages back into the same slot positions.
            for (i, originalIndex) in indices.enumerated() {
                result[originalIndex] = sorted[i]
            }
        }

        return result
    }

    // Detects steer-like flows where a later user prompt is appended inside the same turn.
    // In those cases the original event order is authoritative for rendering.
    static func hasInterleavedUserFlow(_ turnMessages: [CodexMessage]) -> Bool {
        let userCount = turnMessages.reduce(into: 0) { count, message in
            if message.role == .user {
                count += 1
            }
        }
        guard userCount > 1 else {
            // Desktop mirrors can deliver the only opening prompt after assistant output.
            // A single user row is still the turn opener, not a steer.
            return false
        }

        let ordered = turnMessages.sorted { $0.orderIndex < $1.orderIndex }
        var seenNonUser = false

        for message in ordered {
            if message.role == .user {
                if seenNonUser {
                    return true
                }
            } else {
                seenNonUser = true
            }
        }

        return false
    }

    // Detects multi-item turns where visible system activity appears on BOTH sides of an
    // assistant message (thinking/tool → response → thinking/tool). This distinguishes true
    // interleaved flows from single-item turns where events arrived out of order.
    static func hasInterleavedAssistantActivityFlow(_ turnMessages: [CodexMessage]) -> Bool {
        // Distinct assistant items with distinct text are real multi-message turns, but
        // file-change cards still need semantic trailing placement after the final answer.
        var distinctAssistantTexts: Set<String> = []
        var distinctAssistantItemIDs: Set<String> = []
        var hasLargeAssistantText = false
        for message in turnMessages where message.role == .assistant {
            if let text = normalizedSmallMessageText(message.text) {
                distinctAssistantTexts.insert(text)
            } else if hasMeaningfulMessageText(message.text) {
                hasLargeAssistantText = true
            }
            if let itemID = normalizedIdentifier(message.itemId) {
                distinctAssistantItemIDs.insert(itemID)
            }
        }
        let hasFileChangeCard = turnMessages.contains { $0.role == .system && $0.kind == .fileChange }
        if !hasFileChangeCard,
           (distinctAssistantTexts.count > 1 || (hasLargeAssistantText && distinctAssistantItemIDs.count > 1)),
           distinctAssistantItemIDs.count > 1 {
            return true
        }

        // Check for activity after an already-visible assistant row. Preserving command/tool
        // chronology avoids a second jump when the assistant flips from streaming to complete.
        let ordered = turnMessages.sorted { $0.orderIndex < $1.orderIndex }
        var hasActivityBeforeAssistant = false
        var seenAssistant = false
        var seenStreamingAssistant = false
        for message in ordered {
            if message.role == .assistant {
                seenAssistant = true
                if message.isStreaming {
                    seenStreamingAssistant = true
                }
            } else if isInterleavableSystemActivity(message) {
                if seenStreamingAssistant || (seenAssistant && isPostAssistantStatusActivity(message)) {
                    return true
                }
                if !seenAssistant {
                    hasActivityBeforeAssistant = true
                } else if hasActivityBeforeAssistant {
                    return true
                }
            }
        }
        return false
    }

    static func isPostAssistantStatusActivity(_ message: CodexMessage) -> Bool {
        guard message.role == .system else {
            return false
        }

        switch message.kind {
        case .toolActivity, .commandExecution:
            return true
        case .thinking, .chat, .asyncUserInputAnswer, .plan, .userInputPrompt, .fileChange, .subagentAction, .autoApprovalReview:
            return false
        }
    }

    // Turn-end file-change snapshots can land after the user already sent the next
    // message. Relocate them back to the end of their owning turn when a later turn
    // has clearly started in between.
    static func anchorLateFileChangesToOwningTurn(in messages: [CodexMessage]) -> [CodexMessage] {
        var lastContentIndexByTurn: [String: Int] = [:]
        for (index, message) in messages.enumerated() {
            guard let turnId = message.turnId, !turnId.isEmpty,
                  !(message.role == .system && message.kind == .fileChange) else {
                continue
            }
            lastContentIndexByTurn[turnId] = index
        }
        guard !lastContentIndexByTurn.isEmpty else {
            return messages
        }

        var relocatedIndicesByAnchor: [Int: [Int]] = [:]
        var relocatedIndices = Set<Int>()
        for (index, message) in messages.enumerated() {
            guard message.role == .system,
                  message.kind == .fileChange,
                  let turnId = message.turnId, !turnId.isEmpty,
                  let anchorIndex = lastContentIndexByTurn[turnId],
                  anchorIndex < index else {
                continue
            }

            let crossesIntoLaterTurn = messages[(anchorIndex + 1)..<index].contains { between in
                guard let betweenTurnId = between.turnId, !betweenTurnId.isEmpty else {
                    return false
                }
                return betweenTurnId != turnId
            }
            guard crossesIntoLaterTurn else {
                continue
            }

            relocatedIndicesByAnchor[anchorIndex, default: []].append(index)
            relocatedIndices.insert(index)
        }
        guard !relocatedIndices.isEmpty else {
            return messages
        }

        var result: [CodexMessage] = []
        result.reserveCapacity(messages.count)
        for (index, message) in messages.enumerated() {
            if relocatedIndices.contains(index) {
                continue
            }

            result.append(message)
            if let relocated = relocatedIndicesByAnchor[index] {
                for relocatedIndex in relocated {
                    result.append(messages[relocatedIndex])
                }
            }
        }
        return result
    }

    // Mac-started rollout mirrors can interleave many assistant/tool rows before the
    // final answer; edited-file cards are still turn-end artifacts and must trail it.
    static func movingFileChangesToTurnTail(in messages: [CodexMessage]) -> [CodexMessage] {
        guard messages.contains(where: { $0.role == .system && $0.kind == .fileChange }) else {
            return messages
        }

        let nonFileChanges = messages.filter { !($0.role == .system && $0.kind == .fileChange) }
        let fileChanges = messages.filter { $0.role == .system && $0.kind == .fileChange }
        return nonFileChanges + fileChanges
    }

    static func isInterleavableSystemActivity(_ message: CodexMessage) -> Bool {
        guard message.role == .system else {
            return false
        }

        switch message.kind {
        case .thinking, .toolActivity, .commandExecution:
            return true
        case .chat, .asyncUserInputAnswer, .plan, .userInputPrompt, .fileChange, .subagentAction, .autoApprovalReview:
            return false
        }
    }

    static func intraTurnPriority(_ message: CodexMessage) -> Int {
        switch message.role {
        case .user:
            return 0
        case .system:
            switch message.kind {
            case .thinking:
                return 1
            case .toolActivity:
                return 2
            case .commandExecution:
                return 2
            case .subagentAction:
                return 3
            case .autoApprovalReview:
                return 3
            case .chat, .asyncUserInputAnswer:
                return 4
            case .plan:
                return 4
            case .userInputPrompt:
                return 6
            case .fileChange:
                // Keep edited-file cards at the end of the turn timeline.
                return 5
            }
        case .assistant:
            return 4
        }
    }

    // Late terminal replays can arrive with a newer raw order index; stable closed assistant
    // rows should still render by their semantic creation time inside one turn.
    static func intraTurnTieBreak(_ a: CodexMessage, _ b: CodexMessage) -> Bool {
        if a.role == .assistant,
           b.role == .assistant,
           !a.isStreaming,
           !b.isStreaming,
           a.createdAt != b.createdAt {
            return a.createdAt < b.createdAt
        }

        return a.orderIndex < b.orderIndex
    }

    // Hides persisted technical markers that exist only to reset per-chat diff totals.
    static func removeHiddenSystemMarkers(in messages: [CodexMessage]) -> [CodexMessage] {
        messages.filter { message in
            !(message.role == .system && message.itemId == TurnSessionDiffResetMarker.manualPushItemID)
        }
    }

    // Collapses repeated thinking placeholders/activity rows within one turn segment so
    // tool cards can interleave without leaving stacked empty thinking rows behind.
}
