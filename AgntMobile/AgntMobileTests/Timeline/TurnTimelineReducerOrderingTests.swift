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

func testEnforceIntraTurnOrderPreservesInterleavedMultiItemFlow() {
    let now = Date()
    var order = 0
    func nextOrder() -> Int { order += 1; return order }

    // Simulates a desktop-style mirror flow: thinking1 → response1 → thinking2 → response2
    let messages = [
        makeTimelineTestMessage(
            id: "user-1",
            threadID: "thread",
            role: .user,
            kind: .chat,
            text: "Hello",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "thinking-1",
            threadID: "thread",
            role: .system,
            kind: .thinking,
            text: "Reasoning block A",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "item-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "First response",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "item-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "thinking-2",
            threadID: "thread",
            role: .system,
            kind: .thinking,
            text: "Reasoning block B",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "item-2",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "assistant-2",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Second response",
            createdAt: now.addingTimeInterval(4),
            turnID: "turn-1",
            itemID: "item-2",
            orderIndex: nextOrder()
        ),
    ]

    let reordered = TurnTimelineReducer.enforceIntraTurnOrder(in: messages)
    // User must come first, but the interleaved flow must be preserved.
    XCTAssertEqual(reordered.map(\.id), [
        "user-1",
        "thinking-1",
        "assistant-1",
        "thinking-2",
        "assistant-2",
    ])
}

func testEnforceIntraTurnOrderStillReordersSingleItemTurn() {
    let now = Date()
    var order = 0
    func nextOrder() -> Int { order += 1; return order }

    // Single-item turn where assistant arrives before thinking (out of order).
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Response",
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "thinking-1",
            threadID: "thread",
            role: .system,
            kind: .thinking,
            text: "Thinking...",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "item-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "user-1",
            threadID: "thread",
            role: .user,
            kind: .chat,
            text: "Hello",
            createdAt: now.addingTimeInterval(-1),
            turnID: "turn-1",
            orderIndex: 0
        ),
    ]

    let reordered = TurnTimelineReducer.enforceIntraTurnOrder(in: messages)
    // Single-item turn: normal role-based ordering applies.
    XCTAssertEqual(reordered.map(\.id), [
        "user-1",
        "thinking-1",
        "assistant-1",
    ])
}

func testEnforceIntraTurnOrderKeepsFileChangeAfterFinalAssistantWhenStatusTextPrecedesIt() {
    let now = Date()
    var order = 0
    func nextOrder() -> Int { order += 1; return order }

    let messages = [
        makeTimelineTestMessage(
            id: "user-1",
            threadID: "thread",
            role: .user,
            kind: .chat,
            text: "Change the app",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "assistant-status",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Working on it",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "status-item",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "file-change",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: "Path: Sources/App.swift\nKind: update\nTotals: +1 -0",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "file-change-item",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "assistant-final",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Done",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "final-item",
            orderIndex: nextOrder()
        ),
    ]

    let reordered = TurnTimelineReducer.enforceIntraTurnOrder(in: messages)
    XCTAssertEqual(reordered.map(\.id), [
        "user-1",
        "assistant-status",
        "assistant-final",
        "file-change",
    ])
}

func testEnforceIntraTurnOrderKeepsSteerUserNearBottomOfInterleavedTurn() {
    let now = Date()
    var order = 0
    func nextOrder() -> Int { order += 1; return order }

    let messages = [
        makeTimelineTestMessage(
            id: "user-1",
            threadID: "thread",
            role: .user,
            kind: .chat,
            text: "Initial prompt",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "thinking-1",
            threadID: "thread",
            role: .system,
            kind: .thinking,
            text: "Reasoning block A",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "item-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "First response",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "item-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "user-steer",
            threadID: "thread",
            role: .user,
            kind: .chat,
            text: "Steer follow-up",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "thinking-2",
            threadID: "thread",
            role: .system,
            kind: .thinking,
            text: "Reasoning block B",
            createdAt: now.addingTimeInterval(4),
            turnID: "turn-1",
            itemID: "item-2",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "assistant-2",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Second response",
            createdAt: now.addingTimeInterval(5),
            turnID: "turn-1",
            itemID: "item-2",
            orderIndex: nextOrder()
        ),
    ]

    let reordered = TurnTimelineReducer.enforceIntraTurnOrder(in: messages)
    XCTAssertEqual(reordered.map(\.id), [
        "user-1",
        "thinking-1",
        "assistant-1",
        "user-steer",
        "thinking-2",
        "assistant-2",
    ])
}

func testEnforceIntraTurnOrderPreservesPartialInterleavedFlow() {
    let now = Date()
    var order = 0
    func nextOrder() -> Int { order += 1; return order }

    // Mid-stream state: thinking2 arrived after assistant1, but assistant2 not yet here.
    let messages = [
        makeTimelineTestMessage(
            id: "user-1",
            threadID: "thread",
            role: .user,
            kind: .chat,
            text: "Hello",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "thinking-1",
            threadID: "thread",
            role: .system,
            kind: .thinking,
            text: "Reasoning block A",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "item-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "First response",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "item-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "thinking-2",
            threadID: "thread",
            role: .system,
            kind: .thinking,
            text: "Reasoning block B",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "item-2",
            isStreaming: true,
            orderIndex: nextOrder()
        ),
    ]

    let reordered = TurnTimelineReducer.enforceIntraTurnOrder(in: messages)
    // Even without assistant-2 yet, thinking-2 must NOT jump before assistant-1.
    XCTAssertEqual(reordered.map(\.id), [
        "user-1",
        "thinking-1",
        "assistant-1",
        "thinking-2",
    ])
}

func testEnforceIntraTurnOrderPreservesToolActivityAfterAssistantInInterleavedFlow() {
    let now = Date()
    var order = 0
    func nextOrder() -> Int { order += 1; return order }

    let messages = [
        makeTimelineTestMessage(
            id: "user-1",
            threadID: "thread",
            role: .user,
            kind: .chat,
            text: "Hello",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "thinking-1",
            threadID: "thread",
            role: .system,
            kind: .thinking,
            text: "Reasoning block A",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "item-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "First response",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "item-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "tool-1",
            threadID: "thread",
            role: .system,
            kind: .toolActivity,
            text: "Read Sources/App.swift",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "tool-1",
            orderIndex: nextOrder()
        ),
    ]

    let reordered = TurnTimelineReducer.enforceIntraTurnOrder(in: messages)
    XCTAssertEqual(reordered.map(\.id), [
        "user-1",
        "thinking-1",
        "assistant-1",
        "tool-1",
    ])
}

func testEnforceIntraTurnOrderPreservesSteerPromptAfterAssistantWithinSameTurn() {
    let now = Date()
    var order = 0
    func nextOrder() -> Int { order += 1; return order }

    let messages = [
        makeTimelineTestMessage(
            id: "user-1",
            threadID: "thread",
            role: .user,
            kind: .chat,
            text: "Initial request",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "First pass",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "item-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "user-2",
            threadID: "thread",
            role: .user,
            kind: .chat,
            text: "Actually check the failing tests first",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            orderIndex: nextOrder()
        ),
        makeTimelineTestMessage(
            id: "assistant-2",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Refocusing on failures",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "item-2",
            orderIndex: nextOrder()
        ),
    ]

    let reordered = TurnTimelineReducer.enforceIntraTurnOrder(in: messages)
    XCTAssertEqual(reordered.map(\.id), [
        "user-1",
        "assistant-1",
        "user-2",
        "assistant-2",
    ])
}
}
