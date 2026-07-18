// FILE: TurnTimelineAssistantBlockDiffSummaryTests.swift
// Purpose: Verifies assistant block diff summary totals and summary-only entries.
// Layer: Unit Test
// Exports: TurnTimelineAssistantBlockDiffSummaryTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineAssistantBlockDiffSummaryTests: XCTestCase {
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
