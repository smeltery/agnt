// FILE: TurnTimelineRenderModels.swift
// Purpose: Defines render projection item models.
// Layer: View Model / Projection
// Depends on: Foundation, CodexMessage

import Foundation

// ─── Render Item Models ───────────────────────────────────────

struct TurnTimelineToolBurstGroup: Identifiable, Equatable {
    static let collapseThreshold = 4

    let id: String
    let messages: [CodexMessage]

    init(messages: [CodexMessage]) {
        self.messages = messages
        self.id = "tool-burst:\(messages.first?.id ?? "unknown")"
    }

    var latestMessage: CodexMessage? {
        messages.last
    }

    var visibleMessages: [CodexMessage] {
        latestMessage.map { [$0] } ?? []
    }

    var overflowMessages: [CodexMessage] {
        guard !messages.isEmpty else { return [] }
        return Array(messages.dropLast())
    }

    var hiddenCount: Int {
        overflowMessages.count
    }
}

struct TurnTimelinePreviousMessagesGroup: Identifiable, Equatable {
    let id: String
    let finalMessageID: String
    let messages: [CodexMessage]

    init(finalMessage: CodexMessage, messages: [CodexMessage]) {
        self.id = "previous-messages:\(finalMessage.id)"
        self.finalMessageID = finalMessage.id
        self.messages = messages
    }

    var hiddenCount: Int {
        messages.count
    }
}

struct TurnTimelineCommandGroup: Identifiable, Equatable {
    let id: String
    let messages: [CodexMessage]
    let orderedMessages: [CodexMessage]

    init(messages: [CodexMessage], orderedMessages: [CodexMessage]? = nil) {
        self.messages = messages
        self.orderedMessages = orderedMessages ?? messages
        self.id = "command-group:\(messages.first?.id ?? "unknown")"
    }

    var commandCount: Int {
        messages.count
    }

    var traceMessages: [CodexMessage] {
        orderedMessages.filter { $0.role == .system && $0.kind == .thinking }
    }

    var collapsedDetailMessages: [CodexMessage] {
        orderedMessages.filter { message in
            guard message.role == .system else { return false }
            return message.kind == .thinking || message.kind == .fileChange
        }
    }

    var accessoryHostMessage: CodexMessage? {
        orderedMessages.last
    }

    var failedCommandCount: Int {
        messages.count { commandStatusWord(in: $0) == "failed" }
    }

    var stoppedCommandCount: Int {
        messages.count { commandStatusWord(in: $0) == "stopped" }
    }

    var hasUnsuccessfulCommands: Bool {
        failedCommandCount > 0 || stoppedCommandCount > 0
    }

    private func commandStatusWord(in message: CodexMessage) -> String? {
        message.text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: \.isWhitespace)
            .first?
            .lowercased()
    }
}

enum TurnTimelineRenderItem: Identifiable, Equatable {
    case message(CodexMessage)
    case toolBurst(TurnTimelineToolBurstGroup)
    case commandGroup(TurnTimelineCommandGroup)
    case previousMessages(TurnTimelinePreviousMessagesGroup)

    var id: String {
        switch self {
        case .message(let message):
            return message.id
        case .toolBurst(let group):
            return group.id
        case .commandGroup(let group):
            return group.id
        case .previousMessages(let group):
            return group.id
        }
    }
}
