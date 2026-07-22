// FILE: TurnTimelineProjectionPredicates.swift
// Purpose: Shared predicate helpers for timeline render projection grouping.
// Layer: View Model / Projection
// Depends on: Foundation, CodexMessage, ThinkingDisclosureParser

import Foundation

extension TurnTimelineRenderProjection {
    static func isToolBurstCandidate(_ message: CodexMessage) -> Bool {
        guard message.role == .system else {
            return false
        }

        switch message.kind {
        case .toolActivity, .commandExecution:
            return true
        case .thinking, .chat, .plan, .userInputPrompt, .fileChange, .subagentAction, .autoApprovalReview:
            return false
        }
    }

    static func isFinishedCommandToolCall(_ message: CodexMessage) -> Bool {
        guard message.role == .system,
              message.kind == .commandExecution,
              !message.isStreaming else {
            return false
        }

        guard let firstWord = message.text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: \.isWhitespace)
            .first?
            .lowercased() else {
            return false
        }

        return firstWord == "completed"
            || firstWord == "failed"
            || firstWord == "stopped"
    }

    static func isCommandGroupingTrace(_ message: CodexMessage) -> Bool {
        message.role == .system && message.kind == .thinking
    }

    static func isCommandGroupingInterstitial(_ message: CodexMessage) -> Bool {
        guard message.role == .system else { return false }
        return message.kind == .thinking || message.kind == .fileChange
    }

    // Drops placeholder-only system rows before SwiftUI can reserve timeline spacing for them.
    static func shouldSkipVisualRow(
        _ message: CodexMessage,
        activeTurnID: String? = nil,
        isThreadRunning: Bool = false
    ) -> Bool {
        if isThreadRunning,
           message.role == .system,
           message.kind == .fileChange,
           normalizedIdentifier(message.turnId) == normalizedIdentifier(activeTurnID) {
            return true
        }

        guard message.role == .system,
              message.kind == .thinking else {
            return false
        }

        return ThinkingDisclosureParser
            .normalizedThinkingContent(from: message.text)
            .isEmpty
    }

    // Late turn ids can arrive mid-stream, so only split when both rows already
    // have distinct stable turn ids.
    static func canShareToolBurst(previous: CodexMessage, incoming: CodexMessage) -> Bool {
        let previousTurnID = normalizedIdentifier(previous.turnId)
        let incomingTurnID = normalizedIdentifier(incoming.turnId)

        guard let previousTurnID, let incomingTurnID else {
            return true
        }

        return previousTurnID == incomingTurnID
    }

    static func normalizedIdentifier(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
