// FILE: TurnTimelineAssistantBlockInfoTests.swift
// Purpose: Verifies assistant block copy and diff metadata.
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

func testAssistantBlockInfoDeduplicatesEquivalentSingleFileDiffSnapshots() {
    let now = Date()
    let diffCode = """
    @@ -1,3 +1,4 @@
     struct TurnMessageComponents {}
    +let assistantCopyText = true
    """
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
        makeTimelineTestMessage(
            id: "diff-absolute",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: /Users/dev/agnt/AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift
            Kind: update
            Totals: +1 -0

            `@agnt``diff
            \(diffCode)
            `@agnt``
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1"
        ),
        makeTimelineTestMessage(
            id: "diff-relative",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift
            Kind: update
            Totals: +1 -0

            `@agnt``diff
            \(diffCode)
            `@agnt``
            """,
            createdAt: now.addingTimeInterval(2),
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

    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.count, 1)
    XCTAssertEqual(
        blockInfo[2]?.blockDiffEntries?.first?.path,
        "AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift"
    )
    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.first?.additions, 1)
    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.first?.deletions, 0)
}

func testCollapsedFinalMessageKeepsBlockDiffActionsWhenLateActivityIsHidden() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            kind: .chat,
            text: "Fix the bug",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
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
            Totals: +1 -0
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "final",
            threadID: "thread",
            role: .assistant,
            kind: .chat,
            text: "Done.",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "final-item",
            orderIndex: 3
        ),
        makeTimelineTestMessage(
            id: "late-tool",
            threadID: "thread",
            role: .system,
            kind: .toolActivity,
            text: "Late metadata refresh",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            orderIndex: 4
        ),
    ]

    let blockInfo = TurnTimelineView<EmptyView, EmptyView>.assistantBlockInfo(
        for: messages,
        activeTurnID: nil,
        isThreadRunning: false,
        latestTurnTerminalState: .completed,
        stoppedTurnIDs: []
    )
    let initialStates = [String: AssistantBlockAccessoryState](
        uniqueKeysWithValues: zip(messages, blockInfo).compactMap { message, state in
            guard let state else { return nil }
            return (message.id, state)
        }
    )

    let rehousedStates = TurnTimelineView<EmptyView, EmptyView>.rehomeCollapsedFinalAccessoryStates(
        initialStates,
        messages: messages,
        completedTurnIDs: ["turn-1"]
    )

    XCTAssertEqual(
        TurnTimelineRenderProjection.project(
            messages: messages,
            completedTurnIDs: ["turn-1"]
        ).map(\.id),
        ["user", "previous-messages:final", "file-change", "final"]
    )
    XCTAssertNil(initialStates["final"]?.blockDiffEntries)
    XCTAssertEqual(rehousedStates["final"]?.copyText, "Done.")
    XCTAssertEqual(rehousedStates["final"]?.blockDiffEntries?.count, 1)
    XCTAssertEqual(rehousedStates["final"]?.blockDiffEntries?.first?.path, "Sources/App.swift")
}

func testAssistantBlockInfoMergesDifferentSnapshotsForSameFile() {
    let now = Date()
    let firstDiff = """
    @@ -1,3 +1,4 @@
    struct TurnMessageComponents {}
    +let firstChange = true
    """
    let secondDiff = """
    @@ -10,3 +10,4 @@
     struct TurnDiffSheet {}
    +let secondChange = true
    """
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
        makeTimelineTestMessage(
            id: "diff-1",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift
            Kind: update
            Totals: +1 -0

            `@agnt``diff
            \(firstDiff)
            `@agnt``
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1"
        ),
        makeTimelineTestMessage(
            id: "diff-2",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: /Users/dev/agnt/AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift
            Kind: update
            Totals: +1 -0

            `@agnt``diff
            \(secondDiff)
            `@agnt``
            """,
            createdAt: now.addingTimeInterval(2),
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

    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.count, 1)
    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.first?.additions, 2)
    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.first?.deletions, 0)
}

func testAssistantBlockInfoPrefersLatestSummaryTotalsAfterDiffChunk() {
    let now = Date()
    let diffCode = """
    @@ -1,3 +1,4 @@
    +let diffBackedFile = true
    """
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
        makeTimelineTestMessage(
            id: "diff-1",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/App.swift
            Kind: update
            Totals: +1 -0

            `@agnt``diff
            \(diffCode)
            `@agnt``
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1"
        ),
        makeTimelineTestMessage(
            id: "summary-2",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/App.swift
            Kind: update
            Totals: +3 -1
            """,
            createdAt: now.addingTimeInterval(2),
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

    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.count, 1)
    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.first?.path, "Sources/App.swift")
    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.first?.additions, 3)
    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.first?.deletions, 1)
    XCTAssertEqual(blockInfo[2]?.blockDiffText?.contains("`@agnt``diff"), true)
}

func testAssistantBlockInfoPrefersInlineTotalsOverSameMessageDiffCounts() {
    let now = Date()
    let diffCode = """
    @@ -1,3 +1,4 @@
    +let diffBackedFile = true
    """
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
        makeTimelineTestMessage(
            id: "diff-with-inline-totals",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/App.swift
            Kind: update

            `@agnt``diff
            \(diffCode)
            `@agnt``

            Totals: +3 -1
            """,
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

    XCTAssertEqual(blockInfo[1]?.blockDiffEntries?.count, 1)
    XCTAssertEqual(blockInfo[1]?.blockDiffEntries?.first?.path, "Sources/App.swift")
    XCTAssertEqual(blockInfo[1]?.blockDiffEntries?.first?.additions, 3)
    XCTAssertEqual(blockInfo[1]?.blockDiffEntries?.first?.deletions, 1)
    XCTAssertEqual(blockInfo[1]?.blockDiffText?.contains("`@agnt``diff"), true)
}

func testAssistantBlockInfoKeepsRepeatedSameFileChunksAtFinalTotals() {
    let now = Date()
    let firstDiff = """
    @@ -1,3 +1,4 @@
    +let firstChange = true
    """
    let secondDiff = """
    @@ -10,3 +10,4 @@
    +let secondChange = true
    """
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
        makeTimelineTestMessage(
            id: "diff-with-repeated-path",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/App.swift
            Kind: update

            `@agnt``diff
            \(firstDiff)
            `@agnt``

            Path: Sources/App.swift

            `@agnt``diff
            \(secondDiff)
            `@agnt``

            Totals: +2 -0
            """,
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

    XCTAssertEqual(blockInfo[1]?.blockDiffEntries?.count, 1)
    XCTAssertEqual(blockInfo[1]?.blockDiffEntries?.first?.path, "Sources/App.swift")
    XCTAssertEqual(blockInfo[1]?.blockDiffEntries?.first?.additions, 2)
    XCTAssertEqual(blockInfo[1]?.blockDiffEntries?.first?.deletions, 0)
    XCTAssertEqual(blockInfo[1]?.blockDiffText?.contains("firstChange"), true)
    XCTAssertEqual(blockInfo[1]?.blockDiffText?.contains("secondChange"), true)
}

func testAssistantBlockInfoKeepsSummaryOnlyFileWhenSiblingHasDiffChunk() {
    let now = Date()
    let diffCode = """
    @@ -1,3 +1,4 @@
    +let diffBackedFile = true
    """
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
        makeTimelineTestMessage(
            id: "diff-with-code",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/App.swift
            Kind: update
            Totals: +1 -0

            `@agnt``diff
            \(diffCode)
            `@agnt``
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1"
        ),
        makeTimelineTestMessage(
            id: "summary-only",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/Composer.swift
            Kind: update
            Totals: +3 -1
            """,
            createdAt: now.addingTimeInterval(2),
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

    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.count, 2)
    XCTAssertEqual(
        blockInfo[2]?.blockDiffEntries?.map(\.path),
        ["Sources/App.swift", "Sources/Composer.swift"]
    )
}

func testAssistantBlockInfoKeepsSummaryOnlyEntriesWithoutDiffFencesSeparated() {
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
        makeTimelineTestMessage(
            id: "diff-1",
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
            turnID: "turn-1"
        ),
        makeTimelineTestMessage(
            id: "diff-2",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/Composer.swift
            Kind: update
            Totals: +3 -1
            """,
            createdAt: now.addingTimeInterval(2),
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

    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.count, 2)
    XCTAssertEqual(
        blockInfo[2]?.blockDiffEntries?.map(\.path),
        ["Sources/App.swift", "Sources/Composer.swift"]
    )
}

func testAssistantBlockInfoDoesNotDoubleCountIdenticalSummaryOnlySnapshots() {
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
        makeTimelineTestMessage(
            id: "diff-1",
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
            turnID: "turn-1"
        ),
        makeTimelineTestMessage(
            id: "diff-2",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: /Users/dev/agnt/Sources/App.swift
            Kind: update
            Totals: +2 -1
            """,
            createdAt: now.addingTimeInterval(2),
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

    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.count, 1)
    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.first?.path, "Sources/App.swift")
    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.first?.additions, 2)
    XCTAssertEqual(blockInfo[2]?.blockDiffEntries?.first?.deletions, 1)
}
}
