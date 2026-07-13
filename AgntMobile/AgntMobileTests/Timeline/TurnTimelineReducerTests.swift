// FILE: TurnTimelineReducerTests.swift
// Purpose: Verifies core timeline reducer projection behavior.
// Layer: Unit Test
// Exports: TurnTimelineReducerTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineReducerTests: XCTestCase {
func testCollapseConsecutiveThinkingKeepsNewestState() {
    let threadID = "thread"
    let now = Date()

    let messages = [
        makeTimelineTestMessage(
            id: "thinking-1",
            threadID: threadID,
            role: .system,
            kind: .thinking,
            text: "Thinking...",
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-1",
            isStreaming: true
        ),
        makeTimelineTestMessage(
            id: "thinking-2",
            threadID: threadID,
            role: .system,
            kind: .thinking,
            text: "Resolved thought",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "item-1",
            isStreaming: false
        ),
    ]

    let projection = TurnTimelineReducer.project(messages: messages)
    XCTAssertEqual(projection.messages.count, 1)
    XCTAssertEqual(projection.messages[0].text, "Resolved thought")
    XCTAssertFalse(projection.messages[0].isStreaming)
    XCTAssertEqual(projection.messages[0].itemId, "item-1")
}

func testCollapseConsecutiveThinkingKeepsExistingActivityWhenIncomingIsPlaceholder() {
    let threadID = "thread"
    let now = Date()

    let messages = [
        makeTimelineTestMessage(
            id: "thinking-activity",
            threadID: threadID,
            role: .system,
            kind: .thinking,
            text: "Running /usr/bin/bash -lc \"echo test\"",
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-1",
            isStreaming: true
        ),
        makeTimelineTestMessage(
            id: "thinking-placeholder",
            threadID: threadID,
            role: .system,
            kind: .thinking,
            text: "Thinking...",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "item-1",
            isStreaming: true
        ),
    ]

    let projection = TurnTimelineReducer.project(messages: messages)
    XCTAssertEqual(projection.messages.count, 1)
    XCTAssertTrue(projection.messages[0].text.contains("Running /usr/bin/bash"))
}

func testCollapseConsecutiveThinkingKeepsDistinctItemsSeparated() {
    let threadID = "thread"
    let now = Date()

    let messages = [
        makeTimelineTestMessage(
            id: "thinking-1",
            threadID: threadID,
            role: .system,
            kind: .thinking,
            text: "Reasoning block A",
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-1",
            isStreaming: true
        ),
        makeTimelineTestMessage(
            id: "thinking-2",
            threadID: threadID,
            role: .system,
            kind: .thinking,
            text: "Reasoning block B",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "item-2",
            isStreaming: true
        ),
    ]

    let projection = TurnTimelineReducer.project(messages: messages)
    XCTAssertEqual(projection.messages.count, 2)
    XCTAssertEqual(projection.messages.map(\.id), ["thinking-1", "thinking-2"])
}

func testDeduplicatesCumulativeReasoningSummarySnapshots() {
    let threadID = "thread"
    let now = Date()

    let messages = [
        makeTimelineTestMessage(
            id: "summary-a",
            threadID: threadID,
            role: .system,
            kind: .thinking,
            text: "**Testing notify command behavior**\n\n<!-- -->",
            createdAt: now,
            turnID: "turn-1",
            itemID: "summary-a",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "summary-b",
            threadID: threadID,
            role: .system,
            kind: .thinking,
            text: "**Testing notify command behavior**\n\n<!-- -->\n\n**Analyzing notify hook JSON output format**\n\n<!-- -->",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "summary-b",
            orderIndex: 2
        ),
    ]

    let projection = TurnTimelineReducer.project(messages: messages)

    XCTAssertEqual(projection.messages.map(\.id), ["summary-a", "summary-b"])
    XCTAssertEqual(
        projection.messages[1].text,
        "**Analyzing notify hook JSON output format**\n\n<!-- -->"
    )
}

func testDeduplicatesStalePendingImagePromptWhenConfirmedEchoUsesDifferentAttachmentIdentity() {
    let threadID = "thread"
    let now = Date()
    let pendingAttachment = CodexImageAttachment(
        id: "pending-image",
        thumbnailBase64JPEG: "local-thumb",
        payloadDataURL: "data:image/jpeg;base64,LOCAL"
    )
    let confirmedAttachment = CodexImageAttachment(
        id: "confirmed-image",
        thumbnailBase64JPEG: "server-thumb",
        sourceURL: "data:image/jpeg;base64,SERVER"
    )

    let messages = [
        makeTimelineTestMessage(
            id: "pending-user",
            threadID: threadID,
            role: .user,
            text: "Describe this screenshot",
            createdAt: now,
            attachments: [pendingAttachment],
            deliveryState: .pending,
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "confirmed-user",
            threadID: threadID,
            role: .user,
            text: "Describe this screenshot",
            createdAt: now.addingTimeInterval(3600),
            turnID: "turn-1",
            attachments: [confirmedAttachment],
            deliveryState: .confirmed,
            orderIndex: 2
        ),
    ]

    let projection = TurnTimelineReducer.project(messages: messages)
    XCTAssertEqual(projection.messages.count, 1)
    XCTAssertEqual(projection.messages[0].id, "pending-user")
    XCTAssertEqual(projection.messages[0].turnId, "turn-1")
    XCTAssertEqual(projection.messages[0].attachments.map(\.id), ["pending-image"])
}

func testCollapseThinkingReusesPlaceholderAcrossCommandRows() {
    let threadID = "thread"
    let now = Date()

    let messages = [
        makeTimelineTestMessage(
            id: "thinking-1",
            threadID: threadID,
            role: .system,
            kind: .thinking,
            text: "Thinking...",
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-1",
            isStreaming: true
        ),
        makeTimelineTestMessage(
            id: "command-1",
            threadID: threadID,
            role: .system,
            kind: .commandExecution,
            text: "Running rg -n \"needle\"",
            createdAt: now.addingTimeInterval(0.5),
            turnID: "turn-1",
            itemID: "command-1",
            isStreaming: true
        ),
        makeTimelineTestMessage(
            id: "thinking-2",
            threadID: threadID,
            role: .system,
            kind: .thinking,
            text: "Resolved thought",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "item-2",
            isStreaming: false
        ),
    ]

    let projection = TurnTimelineReducer.project(messages: messages)
    XCTAssertEqual(projection.messages.map(\.id), ["thinking-1", "command-1"])
    XCTAssertEqual(projection.messages[0].text, "Resolved thought")
    XCTAssertEqual(projection.messages[0].itemId, "item-2")
}

func testProjectRemovesThinkingCommandEchoWhenCommandCardExists() {
    let threadID = "thread"
    let now = Date()

    let messages = [
        makeTimelineTestMessage(
            id: "thinking-echo",
            threadID: threadID,
            role: .system,
            kind: .thinking,
            text: "Thinking...\nRunning rg -n \"needle\"",
            createdAt: now,
            turnID: "turn-1",
            itemID: "thinking-1",
            isStreaming: true
        ),
        makeTimelineTestMessage(
            id: "command-1",
            threadID: threadID,
            role: .system,
            kind: .commandExecution,
            text: "Running rg -n \"needle\"",
            createdAt: now.addingTimeInterval(0.2),
            turnID: "turn-1",
            itemID: "command-1",
            isStreaming: true
        ),
    ]

    let projection = TurnTimelineReducer.project(messages: messages)
    XCTAssertEqual(projection.messages.map(\.id), ["command-1"])
}

func testToolActivityStaysSeparateFromThinkingRows() {
    let threadID = "thread"
    let now = Date()

    let messages = [
        makeTimelineTestMessage(
            id: "thinking-1",
            threadID: threadID,
            role: .system,
            kind: .thinking,
            text: "Reasoning block",
            createdAt: now,
            turnID: "turn-1",
            itemID: "thinking-1",
            isStreaming: true
        ),
        makeTimelineTestMessage(
            id: "tool-1",
            threadID: threadID,
            role: .system,
            kind: .toolActivity,
            text: "Read Sources/App.swift",
            createdAt: now.addingTimeInterval(0.1),
            turnID: "turn-1",
            itemID: "tool-1",
            isStreaming: true
        ),
    ]

    let projection = TurnTimelineReducer.project(messages: messages)
    XCTAssertEqual(projection.messages.map(\.id), ["thinking-1", "tool-1"])
}
}
