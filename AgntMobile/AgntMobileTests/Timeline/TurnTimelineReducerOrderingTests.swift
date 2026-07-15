// FILE: TurnTimelineReducerOrderingTests.swift
// Purpose: Verifies timeline message ordering and anchoring.
// Layer: Unit Test
// Exports: TurnTimelineReducerOrderingTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineReducerOrderingTests: XCTestCase {
func testProjectOrdersLateStatusBeforeFinalUsingCreatedAt() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "tool-row",
            threadID: "thread",
            role: .system,
            kind: .toolActivity,
            text: "Read 6807e4de/...",
            createdAt: now,
            turnID: "turn-1",
            itemID: "tool-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "assistant-final",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Latest TestFlight inbox email says: agnt version 1.4, build 124.",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "item-final",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "assistant-status",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "I'll use the Gmail connector to search recent inbox mentions.",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "item-status",
            orderIndex: 3
        ),
    ]

    let projection = TurnTimelineReducer.project(messages: messages)

    XCTAssertEqual(projection.messages.map(\.id), ["tool-row", "assistant-status", "assistant-final"])
}

func testProjectFiltersHiddenPushResetMarker() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "visible-diff",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: "Edited Sources/App.swift +2 -1",
            createdAt: now
        ),
        makeTimelineTestMessage(
            id: "hidden-push-reset",
            threadID: "thread",
            role: .system,
            kind: .chat,
            text: TurnSessionDiffResetMarker.text(branch: "feature/test", remote: "origin"),
            createdAt: now.addingTimeInterval(1),
            itemID: TurnSessionDiffResetMarker.manualPushItemID
        ),
    ]

    let projection = TurnTimelineReducer.project(messages: messages)

    XCTAssertEqual(projection.messages.map(\.id), ["visible-diff"])
}

func testProjectPlacesSubagentActionBeforeAssistantReplyWithinTurn() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Here is the combined result.",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "assistant-1",
            orderIndex: 3
        ),
        makeTimelineTestMessage(
            id: "subagents",
            threadID: "thread",
            role: .system,
            kind: .subagentAction,
            text: "Spawning 2 agents",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "subagents-1",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            kind: .chat,
            text: "Investigate the repo",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
    ]

    let projection = TurnTimelineReducer.project(messages: messages)

    XCTAssertEqual(projection.messages.map(\.id), ["user", "subagents", "assistant"])
}

func testProjectPlacesFileChangeAfterAssistantReplyWithinTurn() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Done.",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "assistant-1",
            orderIndex: 3
        ),
        makeTimelineTestMessage(
            id: "diff",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/App.swift
            Kind: update
            Totals: +2 -1
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "diff-1",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            kind: .chat,
            text: "Ship it",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
    ]

    let projection = TurnTimelineReducer.project(messages: messages)

    XCTAssertEqual(projection.messages.map(\.id), ["user", "assistant", "diff"])
}

func testAssistantAnchorPrefersActiveTurnThenStreamingFallback() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "old",
            createdAt: now,
            turnID: "turn-old"
        ),
        makeTimelineTestMessage(
            id: "assistant-2",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "streaming",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-active",
            isStreaming: true
        ),
    ]

    let activeAnchor = TurnTimelineReducer.assistantResponseAnchorMessageID(
        in: messages,
        activeTurnID: "turn-active"
    )
    XCTAssertEqual(activeAnchor, "assistant-2")

    let fallbackAnchor = TurnTimelineReducer.assistantResponseAnchorMessageID(
        in: messages,
        activeTurnID: nil
    )
    XCTAssertEqual(fallbackAnchor, "assistant-2")
}

}
