import Foundation

extension TurnTimelineReducer {
    static func removeDuplicateReasoningSummaryMessages(
        in messages: [CodexMessage]
    ) -> [CodexMessage] {
        var seenSummaryKeysByTurn: [String: Set<String>] = [:]
        var result: [CodexMessage] = []
        result.reserveCapacity(messages.count)

        for var message in messages {
            guard message.role == .system,
                  message.kind == .thinking,
                  message.text.utf8.count <= largeTextDedupeByteLimit,
                  message.text.contains("**"),
                  let turnID = normalizedIdentifier(message.turnId) else {
                result.append(message)
                continue
            }

            let content = ThinkingDisclosureParser.parse(from: message.text)
            guard content.isSummaryOnly else {
                result.append(message)
                continue
            }

            var seenKeys = seenSummaryKeysByTurn[turnID, default: Set<String>()]
            let unseenSections = content.sections.filter { section in
                let key = reasoningSummaryKey(section.title)
                guard !key.isEmpty else { return true }
                return seenKeys.insert(key).inserted
            }
            seenSummaryKeysByTurn[turnID] = seenKeys

            guard !unseenSections.isEmpty else {
                continue
            }
            if unseenSections.count != content.sections.count {
                message.text = unseenSections
                    .map { "**\($0.title)**\n\n<!-- -->" }
                    .joined(separator: "\n\n")
            }
            result.append(message)
        }

        return result
    }

    static func reasoningSummaryKey(_ title: String) -> String {
        title
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
            .lowercased()
    }

    // Collapses optimistic phone-send rows with their confirmed runtime echoes so
    // a locally-started turn does not render duplicate user prompts.
    static func removeDuplicateUserMessages(in messages: [CodexMessage]) -> [CodexMessage] {
        var result: [CodexMessage] = []
        result.reserveCapacity(messages.count)

        for message in messages {
            guard message.role == .user else {
                result.append(message)
                continue
            }

            // Only fold the phone-send echo when there is a single clear local source row.
            let matchingIndices = result.indices.reversed().filter { index in
                shouldMergeUserMessages(previous: result[index], incoming: message)
            }
            guard matchingIndices.count == 1,
                  let previousIndex = matchingIndices.first else {
                result.append(message)
                continue
            }

            result[previousIndex] = mergedUserMessage(previous: result[previousIndex], incoming: message)
        }

        return result
    }

    static func shouldMergeUserMessages(previous: CodexMessage, incoming: CodexMessage) -> Bool {
        guard previous.role == .user,
              incoming.role == .user,
              previous.threadId == incoming.threadId,
              CodexService.userMessagesMatchForHistory(previous, incoming),
              userMessageMetadataLooksCompatible(previous: previous, incoming: incoming) else {
            return false
        }

        let previousTurnId = normalizedIdentifier(previous.turnId)
        let incomingTurnId = normalizedIdentifier(incoming.turnId)
        if let previousTurnId, let incomingTurnId {
            // Some reopen/history fallbacks arrive with epoch timestamps (shown as 1:00).
            // Treat those as stale echoes when identity and content already agree.
            if previousTurnId == incomingTurnId,
               hasFallbackHistoryTimestamp(previous.createdAt) || hasFallbackHistoryTimestamp(incoming.createdAt) {
                return true
            }
            if previousTurnId == incomingTurnId,
               shouldCollapseSemanticMentionEcho(previous: previous, incoming: incoming) {
                return true
            }
            return previousTurnId == incomingTurnId
                && previous.deliveryState == .pending
                && incoming.deliveryState == .confirmed
                && abs(incoming.createdAt.timeIntervalSince(previous.createdAt)) <= 12
        }

        // Allow only the phone-send upgrade path: optimistic local row without turnId
        // becoming the confirmed runtime echo once the turn exists.
        let isPendingToConfirmedUpgrade = previous.deliveryState == .pending
            && incoming.deliveryState == .confirmed
        let isTurnBindingUpgrade = previousTurnId == nil && incomingTurnId != nil
        guard isPendingToConfirmedUpgrade || isTurnBindingUpgrade else {
            return false
        }

        // Stale image pending rows from older sessions should still collapse when
        // the runtime echo finally supplies the turn binding.
        if isPendingToConfirmedUpgrade,
           isTurnBindingUpgrade,
           !previous.attachments.isEmpty,
           previous.attachments.count == incoming.attachments.count {
            return true
        }

        return abs(incoming.createdAt.timeIntervalSince(previous.createdAt)) <= 12
    }

    static func mergedUserMessage(previous: CodexMessage, incoming: CodexMessage) -> CodexMessage {
        var merged = previous
        let shouldPreferIncomingPresentation = CodexService.shouldPreferIncomingUserPresentationText(
            existing: previous,
            incoming: incoming
        )

        if merged.deliveryState == .pending || incoming.deliveryState == .confirmed {
            merged.deliveryState = incoming.deliveryState
        }
        if merged.turnId == nil {
            merged.turnId = incoming.turnId
        }
        if merged.itemId == nil {
            merged.itemId = incoming.itemId
        }
        if merged.fileMentions.isEmpty && !incoming.fileMentions.isEmpty {
            merged.fileMentions = incoming.fileMentions
        }
        if merged.skillMentions.isEmpty && !incoming.skillMentions.isEmpty {
            merged.skillMentions = incoming.skillMentions
        }
        if merged.pluginMentions.isEmpty && !incoming.pluginMentions.isEmpty {
            merged.pluginMentions = incoming.pluginMentions
        }
        if merged.attachments.isEmpty && !incoming.attachments.isEmpty {
            merged.attachments = incoming.attachments
        }

        let semanticUserMatch = CodexService.userMessagesMatchForHistory(merged, incoming)
        if shouldPreferIncomingPresentation {
            merged.text = incoming.text
        } else if hasMeaningfulMessageText(incoming.text),
                  (!semanticUserMatch || (merged.skillMentions.isEmpty && merged.pluginMentions.isEmpty)) {
            merged.text = incoming.text
        }
        if hasFallbackHistoryTimestamp(merged.createdAt),
           !hasFallbackHistoryTimestamp(incoming.createdAt) {
            merged.createdAt = incoming.createdAt
        }

        return merged
    }

    static func shouldCollapseSemanticMentionEcho(previous: CodexMessage, incoming: CodexMessage) -> Bool {
        let previousHasMentionMetadata = hasMentionMetadata(previous)
        let incomingHasMentionMetadata = hasMentionMetadata(incoming)
        guard previousHasMentionMetadata != incomingHasMentionMetadata else {
            return false
        }

        return (previousHasMentionMetadata && containsInlineMentionToken(incoming.text))
            || (incomingHasMentionMetadata && containsInlineMentionToken(previous.text))
    }

    static func hasMentionMetadata(_ message: CodexMessage) -> Bool {
        !message.skillMentions.isEmpty || !message.pluginMentions.isEmpty
    }

    static func containsInlineMentionToken(_ text: String) -> Bool {
        guard text.utf8.count <= largeTextDedupeByteLimit,
              let regex = try? NSRegularExpression(
                pattern: #"(?<!\S)([$/@])([A-Za-z0-9][A-Za-z0-9._-]*)(?=[\s,.;:!?)\]}>]|$)"#
              ) else {
            return false
        }

        let range = NSRange(text.startIndex..., in: text)
        return regex.firstMatch(in: text, range: range) != nil
    }

    static func hasFallbackHistoryTimestamp(_ date: Date) -> Bool {
        !CodexTimestampParser.isTrustworthyServerDate(date)
    }

    static func normalizedSmallMessageText(_ text: String) -> String? {
        guard text.utf8.count <= largeTextDedupeByteLimit else {
            return nil
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func messageTextsMatchForDedupe(_ lhs: String, _ rhs: String) -> Bool {
        guard lhs.utf8.count <= largeTextDedupeByteLimit,
              rhs.utf8.count <= largeTextDedupeByteLimit else {
            return lhs == rhs
        }

        return lhs.trimmingCharacters(in: .whitespacesAndNewlines)
            == rhs.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func hasMeaningfulMessageText(_ text: String) -> Bool {
        guard !text.isEmpty else { return false }
        guard text.utf8.count <= smallWhitespaceScanByteLimit else { return true }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func assistantReplayTextAlreadyRepresented(previous: String, incoming: String) -> Bool {
        guard previous.utf8.count <= largeTextDedupeByteLimit,
              incoming.utf8.count <= largeTextDedupeByteLimit else {
            return previous == incoming
        }
        let previousText = previous.trimmingCharacters(in: .whitespacesAndNewlines)
        let incomingText = incoming.trimmingCharacters(in: .whitespacesAndNewlines)
        return previousText.count >= incomingText.count || previousText.contains(incomingText)
    }

    static func attachmentSignature(for message: CodexMessage) -> String {
        message.attachments
            .map(\.stableIdentityKey)
            .joined(separator: "|")
    }

    static func fileMentionsSignature(for fileMentions: [String]) -> String {
        fileMentions
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
            .sorted()
            .joined(separator: "|")
    }

    static func userMessageMetadataLooksCompatible(previous: CodexMessage, incoming: CodexMessage) -> Bool {
        let previousFileMentions = fileMentionsSignature(for: previous.fileMentions)
        let incomingFileMentions = fileMentionsSignature(for: incoming.fileMentions)
        if !previousFileMentions.isEmpty,
           !incomingFileMentions.isEmpty,
           previousFileMentions != incomingFileMentions {
            return false
        }

        let previousAttachments = attachmentSignature(for: previous)
        let incomingAttachments = attachmentSignature(for: incoming)
        if !previousAttachments.isEmpty,
           !incomingAttachments.isEmpty,
           previousAttachments != incomingAttachments {
            // Render dedupe mirrors history reconciliation for optimistic image sends
            // whose confirmed echo has a different attachment storage identity.
            return previous.attachments.count == incoming.attachments.count
        }

        return true
    }

    // Hides duplicated assistant rows caused by mixed completion/history payloads.
}
