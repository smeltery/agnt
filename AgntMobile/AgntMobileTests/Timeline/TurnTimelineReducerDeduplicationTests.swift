// FILE: TurnTimelineReducerDeduplicationTests.swift
// Purpose: Verifies timeline duplicate assistant and user message filtering.
// Layer: Unit Test
// Exports: TurnTimelineReducerDeduplicationTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineReducerDeduplicationTests: XCTestCase {
func testRemoveDuplicateAssistantMessagesByTurnAndText() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "same",
            createdAt: now,
            turnID: "turn-1"
        ),
        makeTimelineTestMessage(
            id: "assistant-2",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "same",
            createdAt: now.addingTimeInterval(0.2),
            turnID: "turn-1"
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateAssistantMessages(in: messages)
    XCTAssertEqual(deduped.count, 1)
    XCTAssertEqual(deduped.first?.id, "assistant-1")
}

func testRemoveDuplicateAssistantMessagesWithoutTurnWithinTimeWindow() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "no turn",
            createdAt: now
        ),
        makeTimelineTestMessage(
            id: "assistant-2",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "no turn",
            createdAt: now.addingTimeInterval(5)
        ),
        makeTimelineTestMessage(
            id: "assistant-3",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "no turn",
            createdAt: now.addingTimeInterval(20)
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateAssistantMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["assistant-1", "assistant-3"])
}

func testRemoveDuplicateUserMessagesCollapsesPendingPhoneRowWithConfirmedEcho() {
    let now = Date()
    var pending = makeTimelineTestMessage(
        id: "user-pending",
        threadID: "thread",
        role: .user,
        text: "Fix this",
        createdAt: now
    )
    pending.deliveryState = .pending

    let confirmed = makeTimelineTestMessage(
        id: "user-confirmed",
        threadID: "thread",
        role: .user,
        text: "Fix this",
        createdAt: now.addingTimeInterval(1),
        turnID: "turn-1"
    )

    let deduped = TurnTimelineReducer.removeDuplicateUserMessages(in: [pending, confirmed])

    XCTAssertEqual(deduped.count, 1)
    XCTAssertEqual(deduped[0].id, "user-pending")
    XCTAssertEqual(deduped[0].deliveryState, .confirmed)
    XCTAssertEqual(deduped[0].turnId, "turn-1")
}

func testRemoveDuplicateUserMessagesKeepsRepeatedConfirmedPrompts() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "user-1",
            threadID: "thread",
            role: .user,
            text: "Fix this",
            createdAt: now,
            turnID: "turn-1"
        ),
        makeTimelineTestMessage(
            id: "user-2",
            threadID: "thread",
            role: .user,
            text: "Fix this",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-2"
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateUserMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["user-1", "user-2"])
}

func testRemoveDuplicateUserMessagesKeepsPromptsWithDifferentFileMentions() {
    let now = Date()
    var first = makeTimelineTestMessage(
        id: "user-1",
        threadID: "thread",
        role: .user,
        text: "Fix this",
        createdAt: now
    )
    first.deliveryState = .pending
    first.fileMentions = ["Sources/App.swift"]

    var second = makeTimelineTestMessage(
        id: "user-2",
        threadID: "thread",
        role: .user,
        text: "Fix this",
        createdAt: now.addingTimeInterval(1),
        turnID: "turn-1"
    )
    second.deliveryState = .confirmed
    second.fileMentions = ["Sources/Other.swift"]

    let deduped = TurnTimelineReducer.removeDuplicateUserMessages(in: [first, second])
    XCTAssertEqual(deduped.map(\.id), ["user-1", "user-2"])
}

func testRemoveDuplicateUserMessagesDoesNotGuessBetweenTwoIdenticalPendingRows() {
    let now = Date()
    var first = makeTimelineTestMessage(
        id: "user-1",
        threadID: "thread",
        role: .user,
        text: "Fix this",
        createdAt: now
    )
    first.deliveryState = .pending

    var second = makeTimelineTestMessage(
        id: "user-2",
        threadID: "thread",
        role: .user,
        text: "Fix this",
        createdAt: now.addingTimeInterval(0.2)
    )
    second.deliveryState = .pending

    let confirmed = makeTimelineTestMessage(
        id: "user-3",
        threadID: "thread",
        role: .user,
        text: "Fix this",
        createdAt: now.addingTimeInterval(0.4),
        turnID: "turn-1"
    )

    let deduped = TurnTimelineReducer.removeDuplicateUserMessages(in: [first, second, confirmed])
    XCTAssertEqual(deduped.map(\.id), ["user-1", "user-2", "user-3"])
}

func testRemoveDuplicateAssistantMessagesKeepsDistinctItemsInSameTurn() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "same",
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-1"
        ),
        makeTimelineTestMessage(
            id: "assistant-2",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "same",
            createdAt: now.addingTimeInterval(0.2),
            turnID: "turn-1",
            itemID: "item-2"
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateAssistantMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["assistant-1", "assistant-2"])
}

func testRemoveDuplicateAssistantMessagesStillDedupesTurnTextWhenOneIdentityIsMissing() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "same",
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-1"
        ),
        makeTimelineTestMessage(
            id: "assistant-2",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "same",
            createdAt: now.addingTimeInterval(0.2),
            turnID: "turn-1"
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateAssistantMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["assistant-1"])
}

func testRemoveDuplicateAssistantMessagesCollapsesLateReplaySubsetForSameTurn() {
    let now = Date()
    let finalText = """
    I checked the latest TestFlight email and found the current build.

    Latest TestFlight version: agnt 1.4 (122) for iOS.
    """
    let replayText = "Latest TestFlight version: agnt 1.4 (122) for iOS."
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-final",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: finalText,
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-1"
        ),
        makeTimelineTestMessage(
            id: "assistant-replay",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: replayText,
            createdAt: now.addingTimeInterval(180),
            turnID: "turn-1"
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateAssistantMessages(in: messages)

    XCTAssertEqual(deduped.map(\.id), ["assistant-final"])
}

func testRemoveDuplicateAssistantMessagesKeepsStableOverlappingItems() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "A stable assistant response with an overlapping shared explanation.",
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-1"
        ),
        makeTimelineTestMessage(
            id: "assistant-2",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "stable assistant response with an overlapping shared explanation",
            createdAt: now.addingTimeInterval(180),
            turnID: "turn-1",
            itemID: "item-2"
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateAssistantMessages(in: messages)

    XCTAssertEqual(deduped.map(\.id), ["assistant-1", "assistant-2"])
}

func testRemoveDuplicateAssistantMessagesDropsFullBlockReplayEvenWithStableItem() {
    let now = Date()
    let introText = "I'll check Gmail for the latest TestFlight message."
    let finalText = "Latest TestFlight version: 1.4 (123)."
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-intro",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: introText,
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-intro"
        ),
        makeTimelineTestMessage(
            id: "tool",
            threadID: "thread",
            role: .system,
            kind: .toolActivity,
            text: "Read 6807e4de/...",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "tool-1"
        ),
        makeTimelineTestMessage(
            id: "assistant-final",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: finalText,
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "item-final"
        ),
        makeTimelineTestMessage(
            id: "assistant-replay",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "\(introText)\n\n\(finalText)",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "item-replay"
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateAssistantMessages(in: messages)

    XCTAssertEqual(deduped.map(\.id), ["assistant-intro", "tool", "assistant-final"])
}

func testRemoveDuplicateAssistantMessagesDropsFullBlockReplayWhenPriorAssistantTurnIsMissing() {
    let now = Date()
    let introText = "I'll check Gmail for the latest TestFlight message."
    let finalText = "Latest TestFlight version: 1.4 (123)."
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-intro",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: introText,
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-intro"
        ),
        makeTimelineTestMessage(
            id: "tool",
            threadID: "thread",
            role: .system,
            kind: .toolActivity,
            text: "Read 6807e4de/...",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "tool-1"
        ),
        makeTimelineTestMessage(
            id: "assistant-final",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: finalText,
            createdAt: now.addingTimeInterval(2),
            itemID: "item-final"
        ),
        makeTimelineTestMessage(
            id: "assistant-replay",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "\(introText)\n\n\(finalText)",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "item-replay"
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateAssistantMessages(in: messages)

    XCTAssertEqual(deduped.map(\.id), ["assistant-intro", "tool", "assistant-final"])
}

func testRemoveDuplicateAssistantMessagesDropsLongExactTerminalReplayWithStableItem() {
    let now = Date()
    let finalText = """
    Latest TestFlight inbox email says:

    agnt version 1.4, build 124

    Subject: "agnt - Remote AI Coding 1.4 (124) for iOS is now available to test."
    """
    let statusText = "I'll use the Gmail connector to search recent inbox mentions."
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-final",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: finalText,
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-final"
        ),
        makeTimelineTestMessage(
            id: "assistant-status",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: statusText,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "item-status"
        ),
        makeTimelineTestMessage(
            id: "assistant-terminal-replay",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: finalText,
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "item-terminal"
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateAssistantMessages(in: messages)

    XCTAssertEqual(deduped.map(\.id), ["assistant-final", "assistant-status"])
}
}
