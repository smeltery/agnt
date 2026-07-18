// FILE: TurnTimelineReducer.swift
// Purpose: Projects raw service timelines into render-ready message lists.
// Layer: View Helper
// Exports: TurnTimelineReducer, TurnTimelineProjection
// Depends on: CodexMessage

import Foundation

struct TurnTimelineProjection {
    let messages: [CodexMessage]
}

enum TurnTimelineReducer {
    static let largeTextDedupeByteLimit = 64_000
    static let smallWhitespaceScanByteLimit = 512

    // ─── ENTRY POINT ─────────────────────────────────────────────

    // Applies all render-only timeline transforms in one pass.
    static func project(messages: [CodexMessage]) -> TurnTimelineProjection {
        let visibleMessages = removeHiddenSystemMarkers(in: messages)
        let anchored = anchorLateFileChangesToOwningTurn(in: visibleMessages)
        let reordered = enforceIntraTurnOrder(in: anchored)
        let collapsedThinking = collapseThinkingMessages(in: reordered)
        let withoutCommandThinkingEchoes = removeRedundantThinkingCommandActivityMessages(in: collapsedThinking)
        let withoutRepeatedReasoningSummaries = removeDuplicateReasoningSummaryMessages(
            in: withoutCommandThinkingEchoes
        )
        let dedupedUsers = removeDuplicateUserMessages(in: withoutRepeatedReasoningSummaries)
        let dedupedFileChanges = removeDuplicateFileChangeMessages(in: dedupedUsers)
        let dedupedSubagentActions = removeDuplicateSubagentActionMessages(in: dedupedFileChanges)
        let dedupedAssistant = removeDuplicateAssistantMessages(in: dedupedSubagentActions)
        return TurnTimelineProjection(messages: dedupedAssistant)
    }

    // Resolves where the viewport should anchor when assistant output starts streaming.
    static func assistantResponseAnchorMessageID(
        in messages: [CodexMessage],
        activeTurnID: String?
    ) -> String? {
        if let activeTurnID,
           let message = messages.last(where: { $0.role == .assistant && $0.turnId == activeTurnID }) {
            return message.id
        }

        return messages.last(where: { $0.role == .assistant && $0.isStreaming })?.id
    }

}
