// FILE: TurnTimelineReducerIntraTurnOrderingTests.swift
// Purpose: Verifies timeline intra-turn ordering and interleaved flow preservation.
// Layer: Unit Test
// Exports: TurnTimelineReducerIntraTurnOrderingTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineReducerIntraTurnOrderingTests: XCTestCase {
func testEnforceIntraTurnOrderPreservesInterleavedMultiItemFlow() {
    let now = Date()
    var order = 0
    func nextOrder() -> Int { order += 1; return order }

    // Simulates a desktop-style mirror flow: thinking1 -> response1 -> thinking2 -> response2
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
