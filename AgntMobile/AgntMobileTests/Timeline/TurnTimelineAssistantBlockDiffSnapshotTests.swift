// FILE: TurnTimelineAssistantBlockDiffSnapshotTests.swift
// Purpose: Verifies assistant block diff snapshot deduplication and merging.
// Layer: Unit Test
// Exports: TurnTimelineAssistantBlockDiffSnapshotTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineAssistantBlockDiffSnapshotTests: XCTestCase {
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
}
