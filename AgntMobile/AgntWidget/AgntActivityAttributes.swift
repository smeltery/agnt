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

struct AgntActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Phase: String, Codable, Hashable {
            case running
            case completed
            case failed
        }

        var phase: Phase
        // Short status line, e.g. "Working…" / "Done" / "Stopped". Never a prompt
        // or model name — keep it generic so no provider detail surfaces.
        var detail: String
        var updatedAt: Date
    }

    // Immutable for the life of the activity.
    var threadTitle: String
    var startedAt: Date
}
