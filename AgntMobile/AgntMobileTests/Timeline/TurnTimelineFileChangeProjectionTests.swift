// FILE: TurnTimelineFileChangeProjectionTests.swift
// Purpose: Verifies file-change timeline render projection behavior.
// Layer: Unit Test
// Exports: TurnTimelineFileChangeProjectionTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineFileChangeProjectionTests: XCTestCase {
func testTimelineProjectionCollapsesTurnFileChangesIntoOneRenderedTable() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            text: "Build the feature",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "final",
            threadID: "thread",
            role: .assistant,
            text: "Done.",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "final-item",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "file-change-a",
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
            orderIndex: 3
        ),
        makeTimelineTestMessage(
            id: "file-change-b",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/Composer.swift
            Kind: update
            Totals: +3 -0
            """,
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            orderIndex: 4
        ),
    ]

    let items = TurnTimelineRenderProjection.project(
        messages: messages,
        completedTurnIDs: ["turn-1"]
    )

    XCTAssertEqual(items.map(\.id), ["user", "final", "file-change-b"])
    guard case .message(let fileChange) = items[2] else {
        return XCTFail("Expected one aggregate file-change message")
    }
    let summary = TurnFileChangeSummaryParser.parse(from: fileChange.text)
    XCTAssertEqual(summary?.entries.map(\.path), ["Sources/App.swift", "Sources/Composer.swift"])
    XCTAssertEqual(summary?.entries.map(\.additions), [2, 3])
    XCTAssertEqual(summary?.entries.map(\.deletions), [1, 0])
}

func testTimelineProjectionMergesAdjacentSameFileChangeRows() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "file-change-add",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: AgntMobile/AgntMobile/Views/Turn/TurnTimelineView.swift
            Kind: update
            Totals: +6 -0
            """,
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "file-change-remove",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: AgntMobile/AgntMobile/Views/Turn/TurnTimelineView.swift
            Kind: update
            Totals: +0 -6
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            orderIndex: 2
        ),
    ]

    let items = TurnTimelineRenderProjection.project(messages: messages)

    XCTAssertEqual(items.map(\.id), ["file-change-remove"])
    guard case .message(let fileChange)? = items.first else {
        return XCTFail("Expected one merged file-change message")
    }
    let summary = TurnFileChangeSummaryParser.parse(from: fileChange.text)
    XCTAssertEqual(summary?.entries.count, 1)
    XCTAssertEqual(summary?.entries.first?.path, "AgntMobile/AgntMobile/Views/Turn/TurnTimelineView.swift")
    XCTAssertEqual(summary?.entries.first?.additions, 6)
    XCTAssertEqual(summary?.entries.first?.deletions, 6)
}

func testTimelineProjectionKeepsAdjacentFileChangeRowsSeparateAcrossTurns() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "file-change-previous-turn",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/Previous.swift
            Kind: update
            Totals: +2 -1
            """,
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "file-change-new-turn",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/New.swift
            Kind: update
            Totals: +3 -0
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-2",
            orderIndex: 2
        ),
    ]

    let items = TurnTimelineRenderProjection.project(messages: messages)

    XCTAssertEqual(items.map(\.id), ["file-change-previous-turn", "file-change-new-turn"])
}

func testTimelineProjectionMergesAdjacentFinalFileChangeRowsIntoOneTable() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "file-change-a",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/App.swift
            Kind: update
            Totals: +2 -1
            """,
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "file-change-b",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/Composer.swift
            Kind: update
            Totals: +3 -0
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            orderIndex: 2
        ),
    ]

    let items = TurnTimelineRenderProjection.project(messages: messages)

    XCTAssertEqual(items.map(\.id), ["file-change-b"])
    guard case .message(let fileChange)? = items.first else {
        return XCTFail("Expected one final file-change table")
    }
    let summary = TurnFileChangeSummaryParser.parse(from: fileChange.text)
    XCTAssertEqual(summary?.entries.map(\.path), ["Sources/App.swift", "Sources/Composer.swift"])
    XCTAssertEqual(summary?.entries.map(\.additions), [2, 3])
    XCTAssertEqual(summary?.entries.map(\.deletions), [1, 0])
}

func testCollapsedFinalDoesNotDuplicateActionsWhenVisibleFileChangeOwnsThem() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            text: "Build the feature",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "final",
            threadID: "thread",
            role: .assistant,
            text: "Done.",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "final-item",
            orderIndex: 2
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
            orderIndex: 3
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

    XCTAssertNil(rehousedStates["final"]?.blockDiffEntries)
    XCTAssertEqual(rehousedStates["file-change"]?.blockDiffEntries?.first?.path, "Sources/App.swift")
}

func testTimelineProjectionDoesNotTreatImageOnlyArtifactAsFinalAnswer() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "user",
            threadID: "thread",
            role: .user,
            text: "Create an image",
            createdAt: now,
            turnID: "turn-1",
            orderIndex: 1
        ),
        makeTimelineTestMessage(
            id: "status",
            threadID: "thread",
            role: .assistant,
            text: "Generating it now.",
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "status-item",
            orderIndex: 2
        ),
        makeTimelineTestMessage(
            id: "final",
            threadID: "thread",
            role: .assistant,
            text: "Here is the final result.",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "final-item",
            orderIndex: 3
        ),
        makeTimelineTestMessage(
            id: "image",
            threadID: "thread",
            role: .assistant,
            text: "![Generated image](/Users/example/generated.png)",
            createdAt: now.addingTimeInterval(3),
            turnID: "turn-1",
            itemID: "image-item",
            orderIndex: 4
        ),
    ]

    let items = TurnTimelineRenderProjection.project(
        messages: messages,
        completedTurnIDs: ["turn-1"]
    )

    XCTAssertEqual(items.map(\.id), [
        "user",
        "previous-messages:final",
        "final",
        "image",
    ])
    XCTAssertEqual(
        TurnTimelineRenderProjection.collapsedFinalMessageIDs(
            in: messages,
            completedTurnIDs: ["turn-1"]
        ),
        Set(["final"])
    )
}
}
