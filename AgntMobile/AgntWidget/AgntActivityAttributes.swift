// FILE: AgntActivityAttributes.swift
// Purpose: Shared Live Activity contract describing an in-flight agnt turn.
//          Compiled into BOTH the app target and the widget extension target so
//          ActivityKit can match the attributes type across module boundaries.
// Layer: Shared (app + Widget Extension)
//
// Provider-agnostic by design: the state only carries a coarse turn phase plus a
// short human-readable status line. It deliberately holds no provider identity,
// session identifiers, prompt text, or other bearer-like values — nothing here
// should leak Codex/Claude/opencode/Cursor specifics or pairing secrets.

import ActivityKit
import Foundation

enum AgntActivityConversationPhase: String, Codable, Hashable {
    case running
    case completed
    case failed
}

struct AgntActivityConversation: Codable, Hashable, Identifiable {
    var id: String
    var title: String
    var detail: String
    var phase: AgntActivityConversationPhase
    var runningStartedAt: Date?
}

struct AgntActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var runningConversations: [AgntActivityConversation]
        var completedConversations: [AgntActivityConversation]
        var failedConversations: [AgntActivityConversation]
        var updatedAt: Date

        var isEmpty: Bool {
            runningConversations.isEmpty
                && completedConversations.isEmpty
                && failedConversations.isEmpty
        }
    }

    // Immutable for the life of the activity.
    var title: String
    var startedAt: Date
}
