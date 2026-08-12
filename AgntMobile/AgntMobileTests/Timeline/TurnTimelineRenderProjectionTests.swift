// FILE: TurnTimelineRenderProjectionTests.swift
// Purpose: Verifies timeline render projection collapse behavior.
// Layer: Unit Test
// Exports: TurnTimelineRenderProjectionTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineRenderProjectionTests: XCTestCase {
func testTimelineRenderProjectionCollapsesHistoricalToolBurstToLatestRow() {
    let now = Date()
    let toolMessages = (1...7).map { index in
        makeTimelineTestMessage(
            id: "tool-\(index)",
            threadID: "thread",
            role: .system,
            kind: index.isMultiple(of: 2) ? .toolActivity : .commandExecution,
            text: "Tool \(index)",
            createdAt: now.addingTimeInterval(Double(index)),
            turnID: "turn-1",
            itemID: "item-\(index)",
            isStreaming: index == 7
        )
    }

    let items = TurnTimelineRenderProjection.project(messages: toolMessages)
    XCTAssertEqual(items.count, 1)

    guard case .toolBurst(let group) = items[0] else {
        return XCTFail("Expected one grouped tool burst")
    }

    XCTAssertEqual(group.messages.map(\.id), toolMessages.map(\.id))
    XCTAssertEqual(group.hiddenCount, 6)
    XCTAssertEqual(group.visibleMessages.map(\.id), ["tool-7"])
    XCTAssertEqual(group.overflowMessages.map(\.id), ["tool-1", "tool-2", "tool-3", "tool-4", "tool-5", "tool-6"])
}

func testTimelineRenderProjectionKeepsShortToolRunsExpanded() {
    let now = Date()
    let toolMessages = (1...4).map { index in
        makeTimelineTestMessage(
            id: "tool-\(index)",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Tool \(index)",
            createdAt: now.addingTimeInterval(Double(index)),
            turnID: "turn-1",
            itemID: "item-\(index)"
        )
    }

    let items = TurnTimelineRenderProjection.project(messages: toolMessages)
    XCTAssertEqual(items.count, 5)

    let messageIDs = items.compactMap { item -> String? in
        if case .message(let message) = item {
            return message.id
        }
        return nil
    }

    XCTAssertEqual(messageIDs, toolMessages.map(\.id))
}

func testTimelineRenderProjectionSplitsToolRunsAcrossStableTurnIDs() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "tool-1",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Tool 1",
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-1"
        ),
        makeTimelineTestMessage(
            id: "tool-2",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Tool 2",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-2",
            itemID: "item-2"
        ),
    ]

    let items = TurnTimelineRenderProjection.project(messages: messages)
    XCTAssertEqual(items.count, 2)

    let messageIDs = items.compactMap { item -> String? in
        if case .message(let message) = item {
            return message.id
        }
        return nil
    }

    XCTAssertEqual(messageIDs, ["tool-1", "tool-2"])
}

func testTimelineRenderProjectionGroupsFinishedCommandsIntoDisclosureItem() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "command-1",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Completed rg -n \"needle\" Sources",
            createdAt: now,
            turnID: "turn-1",
            itemID: "command-1"
        ),
        makeTimelineTestMessage(
            id: "command-2",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Failed git diff --check",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "command-2"
        ),
        makeTimelineTestMessage(
            id: "command-3",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Stopped bun test",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "command-3"
        ),
    ]

    let items = TurnTimelineRenderProjection.project(messages: messages)

    XCTAssertEqual(items.map(\.id), ["command-group:command-1"])
    guard case .commandGroup(let group) = items.first else {
        return XCTFail("Expected completed commands behind one disclosure")
    }
    XCTAssertEqual(group.messages.map(\.id), ["command-1", "command-2", "command-3"])
    XCTAssertEqual(group.commandCount, 3)
    XCTAssertEqual(group.failedCommandCount, 1)
    XCTAssertEqual(group.stoppedCommandCount, 1)
    XCTAssertTrue(group.hasUnsuccessfulCommands)
}

func testTimelineRenderProjectionPreservesCommandTraceOrderInsideDisclosure() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "command-1",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Completed git status",
            createdAt: now,
            turnID: "turn-1",
            itemID: "command-1"
        ),
        makeTimelineTestMessage(
            id: "reasoning",
            threadID: "thread",
            role: .system,
            kind: .thinking,
            text: "Reasoning summary between command tool calls",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "reasoning"
        ),
        makeTimelineTestMessage(
            id: "file-change",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/App.swift
            Kind: update
            Totals: +2 -1
            """,
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "file-change"
        ),
        makeTimelineTestMessage(
            id: "command-2",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Completed git diff --stat",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "command-2"
        ),
    ]

    let items = TurnTimelineRenderProjection.project(messages: messages)

    XCTAssertEqual(items.map(\.id), ["command-group:command-1"])
    guard case .commandGroup(let group) = items.first else {
        return XCTFail("Expected one command disclosure across the trace")
    }
    XCTAssertEqual(group.messages.map(\.id), ["command-1", "command-2"])
    XCTAssertEqual(group.traceMessages.map(\.id), ["reasoning"])
    XCTAssertEqual(group.collapsedDetailMessages.map(\.id), ["reasoning", "file-change"])
    XCTAssertEqual(group.orderedMessages.map(\.id), ["command-1", "reasoning", "file-change", "command-2"])
}

func testTimelineRenderProjectionFoldsToolActivityIntoCommandDisclosure() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "write-terminal",
            threadID: "thread",
            role: .system,
            kind: .toolActivity,
            text: "Wrote to terminal",
            createdAt: now,
            turnID: "turn-1",
            itemID: "write-terminal"
        ),
        makeTimelineTestMessage(
            id: "command-1",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Completed npm test",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "command-1"
        ),
        makeTimelineTestMessage(
            id: "read-terminal",
            threadID: "thread",
            role: .system,
            kind: .toolActivity,
            text: "Read terminal output\nWrote to terminal",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "read-terminal"
        ),
        makeTimelineTestMessage(
            id: "command-2",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Completed git diff --check",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "command-2"
        ),
    ]

    let items = TurnTimelineRenderProjection.project(messages: messages)

    XCTAssertEqual(items.map(\.id), ["command-group:command-1"])
    guard case .commandGroup(let group) = items.first else {
        return XCTFail("Expected command disclosure to absorb adjacent tool activity")
    }
    XCTAssertEqual(group.messages.map(\.id), ["command-1", "command-2"])
    XCTAssertEqual(group.orderedMessages.map(\.id), ["write-terminal", "command-1", "read-terminal", "command-2"])
    XCTAssertEqual(group.commandCount, 2)
    XCTAssertEqual(group.toolCallCount, 3)
    XCTAssertEqual(group.accessoryHostMessage?.id, "command-2")
}

func testTimelineRenderProjectionKeepsLiveTrailingToolActivityVisible() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "command-1",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Completed npm test",
            createdAt: now,
            turnID: "turn-1",
            itemID: "command-1"
        ),
        makeTimelineTestMessage(
            id: "read-terminal",
            threadID: "thread",
            role: .system,
            kind: .toolActivity,
            text: "Reading terminal output",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "read-terminal",
            isStreaming: true
        ),
    ]

    let items = TurnTimelineRenderProjection.project(
        messages: messages,
        activeTurnID: "turn-1",
        isThreadRunning: true
    )

    XCTAssertEqual(items.map(\.id), ["command-group:command-1", "read-terminal"])
    guard case .commandGroup(let group) = items.first,
          case .message(let liveToolActivity) = items.last else {
        return XCTFail("Expected finished command group followed by live tool activity")
    }
    XCTAssertEqual(group.toolCallCount, 0)
    XCTAssertEqual(liveToolActivity.id, "read-terminal")
}

func testTimelineRenderProjectionCollapsesCompletedTurnBeforeFinalAnswer() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            text: "Check Gmail",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "status",
            threadID: "thread",
            role: .assistant,
            text: "I'll use the Gmail connector.",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "status-item",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "tool",
            threadID: "thread",
            role: .system,
            kind: .toolActivity,
            text: "Read inbox",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "tool-item",
            orderIndex: 3
        ),
        makeTimelineTestMessage(
            id: "final",
            threadID: "thread",
            role: .assistant,
            text: "Latest TestFlight version: 1.4 (124).",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "final-item",
            orderIndex: 4
        ),
    ]

    let items = TurnTimelineRenderProjection.project(
        messages: messages,
        completedTurnIDs: ["turn-1"]
    )

    XCTAssertEqual(items.count, 3)
    guard case .message(let user) = items[0],
          case .previousMessages(let previousGroup) = items[1],
          case .message(let final) = items[2] else {
        return XCTFail("Expected user, previous-messages disclosure, final answer")
    }

    XCTAssertEqual(user.id, "user")
    XCTAssertEqual(previousGroup.finalMessageID, "final")
    XCTAssertEqual(previousGroup.hiddenCount, 2)
    XCTAssertEqual(previousGroup.messages.map(\.id), ["status", "tool"])
    XCTAssertEqual(final.id, "final")
    XCTAssertEqual(
        TurnTimelineRenderProjection.collapsedFinalMessageIDs(
            in: messages,
            completedTurnIDs: ["turn-1"]
        ),
        Set(["final"])
    )
}

func testTimelineRenderProjectionCollapsesApprovedAutoReviewsButKeepsDeniedReviewVisible() {
    let now = Date()
    var approvedReview = makeTimelineTestMessage(
        id: "approved-review",
        threadID: "thread",
        role: .system,
        kind: .autoApprovalReview,
        text: "Approved automatically",
        createdAt: now.addingTimeInterval(2),
        turnID: "turn-1",
        orderIndex: 3
    )
    approvedReview.autoApprovalReview = makeTimelineTestAutoApprovalReview(
        id: "approved-review",
        status: .approved
    )

    var deniedReview = makeTimelineTestMessage(
        id: "denied-review",
        threadID: "thread",
        role: .system,
        kind: .autoApprovalReview,
        text: "Approval denied",
        createdAt: now.addingTimeInterval(3),
        turnID: "turn-1",
        orderIndex: 4
    )
    deniedReview.autoApprovalReview = makeTimelineTestAutoApprovalReview(
        id: "denied-review",
        status: .denied
    )

    let messages = [
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            text: "Finish the task",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "thinking",
            threadID: "thread",
            role: .system,
            kind: .thinking,
            text: "Checking the implementation",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            orderIndex: 2
        ),
        approvedReview,
        deniedReview,
        makeTimelineTestMessage(
            id: "final",
            threadID: "thread",
            role: .assistant,
            text: "Done.",
            createdAt: now.addingTimeInterval(4),
            turnID: "turn-1",
            itemID: "final-item",
            orderIndex: 5
        ),
    ]

    let items = TurnTimelineRenderProjection.project(
        messages: messages,
        completedTurnIDs: ["turn-1"]
    )

    XCTAssertEqual(items.map(\.id), [
        "user",
        "previous-messages:final",
        "denied-review",
        "final",
    ])
    guard case .previousMessages(let previousGroup) = items[1] else {
        return XCTFail("Expected approved review inside previous messages")
    }
    XCTAssertEqual(previousGroup.messages.map(\.id), ["thinking", "approved-review"])
}

func testTimelineRenderProjectionNeverShowsDetachedApprovedAutoReviewAtLiveTail() {
    let now = Date()
    var approvedReview = makeTimelineTestMessage(
        id: "approved-review",
        threadID: "thread",
        role: .system,
        kind: .autoApprovalReview,
        text: "Approved automatically",
        createdAt: now,
        turnID: "older-turn"
    )
    approvedReview.autoApprovalReview = makeTimelineTestAutoApprovalReview(
        id: "approved-review",
        status: .approved
    )

    var deniedReview = makeTimelineTestMessage(
        id: "denied-review",
        threadID: "thread",
        role: .system,
        kind: .autoApprovalReview,
        text: "Approval denied",
        createdAt: now.addingTimeInterval(1),
        turnID: "older-turn"
    )
    deniedReview.autoApprovalReview = makeTimelineTestAutoApprovalReview(
        id: "denied-review",
        status: .denied
    )

    let items = TurnTimelineRenderProjection.project(
        messages: [approvedReview, deniedReview]
    )
    let activeItems = TurnTimelineRenderProjection.project(
        messages: [approvedReview, deniedReview],
        activeTurnID: "older-turn",
        isThreadRunning: true
    )

    XCTAssertEqual(items.map(\.id), ["denied-review"])
    XCTAssertEqual(activeItems.map(\.id), ["approved-review", "denied-review"])
}

func testTimelineRenderProjectionKeepsRunningTurnExpandedBeforeFinalAnswer() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "status",
            threadID: "thread",
            role: .assistant,
            text: "Working",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "final",
            threadID: "thread",
            role: .assistant,
            text: "Final",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            orderIndex: 2
        ),
    ]

    let items = TurnTimelineRenderProjection.project(messages: messages)
    let messageIDs = items.compactMap { item -> String? in
        if case .message(let message) = item {
            return message.id
        }
        return nil
    }

    XCTAssertEqual(messageIDs, ["status", "final"])
}
}
