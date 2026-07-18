// FILE: TurnTimelineAssistantBlockInfoTests.swift
// Purpose: Verifies assistant block copy and accessory placement metadata.
// Layer: Unit Test
// Exports: TurnTimelineAssistantBlockInfoTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineAssistantBlockInfoTests: XCTestCase {
func testAssistantBlockInfoShowsCopyWhenLatestRunCompleted() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Completed response",
            createdAt: now,
            turnID: "turn-1"
        ),
    ]

    let blockInfo = TurnTimelineView<EmptyView, EmptyView>.assistantBlockInfo(
        for: messages,
        activeTurnID: nil,
        isThreadRunning: false,
        latestTurnTerminalState: .completed,
        stoppedTurnIDs: []
    )

    XCTAssertEqual(blockInfo[0]?.allowsCopy, true)
    XCTAssertNil(blockInfo[0]?.copyText)
}

func testAssistantBlockInfoKeepsCopyAtEndOfTrailingToolCallBlock() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant",
            threadID: "thread",
            role: .assistant,
            text: "Completed response",
            createdAt: now,
            turnID: "turn-1"
        ),
        makeTimelineTestMessage(
            id: "tool",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Run wait",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1"
        ),
    ]

    let blockInfo = TurnTimelineView<EmptyView, EmptyView>.assistantBlockInfo(
        for: messages,
        activeTurnID: nil,
        isThreadRunning: false,
        latestTurnTerminalState: .completed,
        stoppedTurnIDs: []
    )

    XCTAssertNil(blockInfo[0])
    XCTAssertEqual(blockInfo[1]?.allowsCopy, true)
    XCTAssertEqual(blockInfo[1]?.copyText, "Completed response")
}

func testToolBurstAccessoryResolverMovesCopyAndRunningStateToGroupFooter() {
    let messages = (1...5).map { index in
        makeTimelineTestMessage(
            id: "tool-\(index)",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Tool \(index)",
            turnID: "turn-1"
        )
    }
    let group = TurnTimelineToolBurstGroup(messages: messages)
    guard let hostID = group.latestMessage?.id else {
        return XCTFail("Expected the tool burst to expose its latest message as footer host")
    }
    let state = AssistantBlockAccessoryState(
        copyText: "Completed response",
        showsRunningIndicator: true,
        allowsCopy: true,
        blockDiffText: "diff payload"
    )

    let footerState = TurnTimelineToolBurstAccessoryResolver.copyFooterState(
        for: group,
        statesByMessageID: [hostID: state],
        suppressesRunningIndicator: false
    )
    let globallySuppressedState = TurnTimelineToolBurstAccessoryResolver.copyFooterState(
        for: group,
        statesByMessageID: [hostID: state],
        suppressesRunningIndicator: true
    )
    let rowState = state.suppressingCopyAndRunningAccessory()

    XCTAssertEqual(footerState?.copyText, "Completed response")
    XCTAssertEqual(footerState?.showsRunningIndicator, true)
    XCTAssertEqual(globallySuppressedState?.copyText, "Completed response")
    XCTAssertEqual(globallySuppressedState?.showsRunningIndicator, false)
    XCTAssertNil(rowState.copyText)
    XCTAssertEqual(rowState.allowsCopy, false)
    XCTAssertEqual(rowState.showsRunningIndicator, false)
    XCTAssertEqual(rowState.blockDiffText, "diff payload")
}

func testAssistantBlockInfoSeparatesAdjacentBlocksByStableTurnID() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "First response",
            createdAt: now,
            turnID: "turn-1"
        ),
        makeTimelineTestMessage(
            id: "assistant-2",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Second response",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-2"
        ),
    ]

    let blockInfo = TurnTimelineView<EmptyView, EmptyView>.assistantBlockInfo(
        for: messages,
        activeTurnID: nil,
        isThreadRunning: false,
        latestTurnTerminalState: .completed,
        stoppedTurnIDs: []
    )

    XCTAssertEqual(blockInfo[0]?.allowsCopy, true)
    XCTAssertNil(blockInfo[0]?.copyText)
    XCTAssertEqual(blockInfo[1]?.allowsCopy, true)
    XCTAssertNil(blockInfo[1]?.copyText)
}

func testAssistantBlockInfoDoesNotMoveCopyAcrossTurnBoundary() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-old-turn",
            threadID: "thread",
            role: .assistant,
            text: "Completed response",
            createdAt: now,
            turnID: "turn-1"
        ),
        makeTimelineTestMessage(
            id: "tool-new-turn",
            threadID: "thread",
            role: .system,
            kind: .commandExecution,
            text: "Run wait",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-2"
        ),
    ]

    let blockInfo = TurnTimelineView<EmptyView, EmptyView>.assistantBlockInfo(
        for: messages,
        activeTurnID: nil,
        isThreadRunning: false,
        latestTurnTerminalState: .completed,
        stoppedTurnIDs: []
    )

    XCTAssertEqual(blockInfo[0]?.allowsCopy, true)
    XCTAssertNil(blockInfo[1])
}

func testAssistantBlockInfoDoesNotShowCopyForToolOnlyBlock() {
    let message = makeTimelineTestMessage(
        id: "tool-only",
        threadID: "thread",
        role: .system,
        kind: .toolActivity,
        text: "Search files",
        turnID: "turn-1"
    )

    let blockInfo = TurnTimelineView<EmptyView, EmptyView>.assistantBlockInfo(
        for: [message],
        activeTurnID: nil,
        isThreadRunning: false,
        latestTurnTerminalState: .completed,
        stoppedTurnIDs: []
    )

    XCTAssertNil(blockInfo[0])
}

func testAssistantBlockInfoHidesCopyWhenLatestRunStopped() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "assistant-1",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Interrupted response",
            createdAt: now,
            turnID: "turn-1"
        ),
    ]

    let blockInfo = TurnTimelineView<EmptyView, EmptyView>.assistantBlockInfo(
        for: messages,
        activeTurnID: nil,
        isThreadRunning: false,
        latestTurnTerminalState: .stopped,
        stoppedTurnIDs: ["turn-1"]
    )

    XCTAssertEqual(blockInfo, [nil])
}
}
