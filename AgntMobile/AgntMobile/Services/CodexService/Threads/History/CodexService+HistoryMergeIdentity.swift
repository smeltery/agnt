// FILE: CodexService+HistoryMergeIdentity.swift
// Purpose: Identity and text helpers for history merge reconciliation.
// Layer: Service

import Foundation

extension CodexService {
    nonisolated static func historyMessageKey(for message: CodexMessage) -> String {
        if let itemId = message.itemId, !itemId.isEmpty {
            return "item:\(message.role.rawValue):\(message.kind.rawValue):\(itemId)"
        }

        return [
            message.role.rawValue,
            message.turnId ?? "no-turn",
            message.role == .user ? userSemanticHistoryTextKey(for: message) : historyTextKey(for: message.text),
            attachmentSignature(for: message.attachments),
        ].joined(separator: "|")
    }

    nonisolated static let identitylessUserHistoryEchoWindow: TimeInterval = 2

    nonisolated static func hasFallbackHistoryTimestamp(_ date: Date) -> Bool {
        !CodexTimestampParser.isTrustworthyServerDate(date)
    }

    nonisolated static func normalizedHistoryIdentifier(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    nonisolated static func isProvisionalHistoryTurnIdentifier(_ turnId: String?) -> Bool {
        guard let turnId = normalizedHistoryIdentifier(turnId) else {
            return false
        }
        return CodexSyntheticIdentifiers.isProjectedDesktopTurnID(turnId)
            || CodexSyntheticIdentifiers.isBridgeMintedTurnID(turnId)
    }

    // Mirrors t3code's provider-message identity as closely as the mobile schema allows.
    nonisolated static func stableAssistantMessageID(threadId: String, turnId: String?, itemId: String?) -> String? {
        guard let itemId = normalizedHistoryIdentifier(itemId) else {
            return nil
        }
        return "assistant:\(threadId):item:\(itemId)"
    }

    // Finds the contiguous timeline block owned by one turn; turnless artifact
    // rows inside that range may be rebound without stealing adjacent turns.
    nonisolated static func contiguousTurnBlockRange(
        in messages: [CodexMessage],
        turnId: String
    ) -> Range<Int>? {
        guard let startIndex = messages.firstIndex(where: { $0.turnId == turnId }) else {
            return nil
        }
        let endIndex = messages.indices.first { index in
            guard index > startIndex else {
                return false
            }
            let message = messages[index]
            if let candidateTurnId = message.turnId, !candidateTurnId.isEmpty {
                return candidateTurnId != turnId
            }
            // A user prompt without a turn id still marks a boundary: the next
            // turn's opener lands before turn/started tags it, and this turn's
            // artifacts must not reach past it.
            return message.role == .user
        } ?? messages.endIndex
        return startIndex..<endIndex
    }

    // Single rule for claiming a turnless file-change row into a turn, shared
    // by live reconciliation and history merge. A transient duplicate is safer
    // than stealing an adjacent turn's file-change table.
    nonisolated static func turnlessFileChangeRowIsClaimable(
        in messages: [CodexMessage],
        candidateIndex: Int,
        turnId: String,
        turnBlockRange: Range<Int>?
    ) -> Bool {
        guard messages.indices.contains(candidateIndex) else {
            return false
        }
        if let turnBlockRange {
            return turnBlockRange.contains(candidateIndex)
        }

        guard !messages.contains(where: {
            Self.normalizedHistoryIdentifier($0.turnId) != nil
        }) else {
            return false
        }

        guard !messages[(candidateIndex + 1)...].contains(where: { $0.role == .user }) else {
            return false
        }

        let candidate = messages[candidateIndex]
        let bootstrapRows = messages.filter {
            $0.role == .system
                && $0.kind == .fileChange
                && Self.normalizedHistoryIdentifier($0.turnId) == nil
        }
        return bootstrapRows.count == 1 && bootstrapRows[0].id == candidate.id
    }

    // Real provider item ids must not be rebound to a different history item mid-stream.
    nonisolated static func hasStableAssistantIdentity(_ itemId: String?) -> Bool {
        guard let itemId = normalizedHistoryIdentifier(itemId) else {
            return false
        }
        return !CodexSyntheticIdentifiers.isMirrorMintedItemID(itemId)
    }

    // Rollout mirrors tag reasoning rows with synthetic "rollout-*" item ids
    // and live streams may use turn-scoped placeholders; both are provisional
    // and must merge with the real reasoning identity of the same turn.
    nonisolated static func isProvisionalThinkingIdentifier(_ itemId: String?) -> Bool {
        guard let itemId = normalizedHistoryIdentifier(itemId) else {
            return true
        }
        return CodexSyntheticIdentifiers.isMirrorMintedItemID(itemId)
    }

    // Running assistant rows may absorb history only when the provider item identity agrees.
    nonisolated static func assistantHistoryIdentityAllowsRunningReconcile(
        localMessage: CodexMessage,
        serverMessage: CodexMessage
    ) -> Bool {
        let localItemId = normalizedHistoryIdentifier(localMessage.itemId)
        let serverItemId = normalizedHistoryIdentifier(serverMessage.itemId)

        if let localItemId, let serverItemId {
            return localItemId == serverItemId || !hasStableAssistantIdentity(localItemId)
        }

        if let localItemId, serverItemId == nil {
            return !hasStableAssistantIdentity(localItemId)
        }

        return true
    }

    // History can revisit an assistant turn multiple times while local rows still
    // have provisional identity. Only reconcile by text when the candidate is unique.
    nonisolated static func uniqueAssistantHistoryTextMergeIndex(
        in messages: [CodexMessage],
        message: CodexMessage,
        turnId: String
    ) -> Int? {
        let normalizedText = normalizedMessageText(message.text)
        guard !normalizedText.isEmpty else {
            return nil
        }

        let normalizedTurnId = normalizedHistoryIdentifier(turnId) ?? turnId
        let candidates = messages.indices.filter { index in
            let candidate = messages[index]
            let candidateTurnId = normalizedHistoryIdentifier(candidate.turnId)
            return candidate.role == .assistant
                && (candidateTurnId == nil || candidateTurnId == normalizedTurnId)
                && normalizedMessageText(candidate.text) == normalizedText
        }

        guard candidates.count == 1,
              let index = candidates.last else {
            return nil
        }

        let localItemId = normalizedHistoryIdentifier(messages[index].itemId)
        let incomingItemId = normalizedHistoryIdentifier(message.itemId)
        if let localItemId, let incomingItemId, localItemId != incomingItemId,
           hasStableAssistantIdentity(localItemId),
           hasStableAssistantIdentity(incomingItemId) {
            return nil
        }

        return index
    }

    nonisolated static func shouldReconcileToolActivityRow(
        _ localMessage: CodexMessage,
        with serverMessage: CodexMessage,
        requiresExactText: Bool
    ) -> Bool {
        let localItemId = normalizedHistoryIdentifier(localMessage.itemId)
        let serverItemId = normalizedHistoryIdentifier(serverMessage.itemId)
        if let localItemId, let serverItemId, localItemId == serverItemId {
            return true
        }

        let localHasStableIdentity = hasStableToolActivityIdentity(localItemId)
        let serverHasStableIdentity = hasStableToolActivityIdentity(serverItemId)
        if localHasStableIdentity && serverHasStableIdentity {
            return false
        }

        let localLines = normalizedToolActivityLines(from: localMessage.text)
        let serverLines = normalizedToolActivityLines(from: serverMessage.text)
        if localLines.isEmpty || serverLines.isEmpty {
            return !localHasStableIdentity || !serverHasStableIdentity
        }

        if localLines == serverLines {
            return true
        }

        guard !requiresExactText else {
            return false
        }

        return localLines.starts(with: serverLines) || serverLines.starts(with: localLines)
    }

    nonisolated static func hasStableToolActivityIdentity(_ value: String?) -> Bool {
        guard let value else {
            return false
        }
        return !CodexSyntheticIdentifiers.isPlaceholderItemID(value, kind: .toolActivity)
    }

    // Treats only streaming/skeleton tool rows as safe to rebind by text alone.
    nonisolated static func isProvisionalToolActivityRow(_ message: CodexMessage) -> Bool {
        let itemId = normalizedHistoryIdentifier(message.itemId)
        guard !hasStableToolActivityIdentity(itemId) else {
            return false
        }

        return message.isStreaming || normalizedToolActivityLines(from: message.text).isEmpty
    }

    nonisolated static func normalizedToolActivityLines(from text: String) -> [String] {
        normalizedMessageText(text)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
    }

    // Merges a resume/history snapshot into the local streaming buffer without
    // losing already-rendered tokens when the server snapshot is slightly stale.
    nonisolated static func mergeStreamingSnapshotText(existingText: String, incomingText: String) -> String {
        if existingText.isEmpty {
            return incomingText
        }

        if incomingText == existingText {
            return existingText
        }

        if existingText.hasSuffix(incomingText) {
            return existingText
        }

        if incomingText.count > existingText.count, incomingText.hasPrefix(existingText) {
            let suffix = incomingText.dropFirst(existingText.count)
            if !existingText.isEmpty, suffix.range(of: existingText) != nil {
                return existingText
            }
            return incomingText
        }

        if existingText.count > incomingText.count, existingText.hasPrefix(incomingText) {
            return existingText
        }

        let maxOverlap = min(existingText.count, incomingText.count)
        if maxOverlap > 0 {
            for overlap in stride(from: maxOverlap, through: 1, by: -1) {
                if existingText.suffix(overlap) == incomingText.prefix(overlap) {
                    return existingText + incomingText.dropFirst(overlap)
                }
            }
        }

        return incomingText
    }

    // Assistant history snapshots can be flattened across messages during reconnect.
    // Keep the live bubble anchored to live deltas unless history is an exact/stale match.
    nonisolated static func mergeAssistantRunningSnapshotText(existingText: String, incomingText: String) -> String {
        if existingText.isEmpty {
            return incomingText
        }

        if incomingText == existingText {
            return existingText
        }

        if existingText.hasSuffix(incomingText) {
            return existingText
        }

        if existingText.count > incomingText.count, existingText.hasPrefix(incomingText) {
            return existingText
        }

        return existingText
    }

    // Closed-turn snapshots are only allowed to replace the visible assistant reply
    // when they are clearly the same message and at least as complete.
    nonisolated static func shouldReplaceClosedAssistantMessage(
        _ localMessage: CodexMessage,
        with serverMessage: CodexMessage
    ) -> Bool {
        let localText = normalizedMessageText(localMessage.text)
        let serverText = normalizedMessageText(serverMessage.text)

        guard !serverText.isEmpty else {
            return false
        }

        if localText.isEmpty || localText == serverText {
            return true
        }

        if localText.count > serverText.count, localText.hasPrefix(serverText) {
            return false
        }

        if looksLikeFlattenedAssistantReplacement(localText: localText, serverText: serverText) {
            return false
        }

        return true
    }

    // Rejects closed assistant replacements that look like multiple assistant rows
    // collapsed into one payload instead of a single canonical final message.
    nonisolated static func looksLikeFlattenedAssistantReplacement(localText: String, serverText: String) -> Bool {
        if serverText.hasPrefix(localText) {
            let suffix = serverText.dropFirst(localText.count)
            return suffix.range(of: "\n\n") != nil || suffix.range(of: localText) != nil
        }

        if let range = serverText.range(of: localText),
           range.lowerBound != serverText.startIndex {
            return true
        }

        return serverText.range(of: "\n\n") != nil
    }

}
