// FILE: TurnTimelineReducerFileChangeSnapshotDeduplicationTests.swift
// Purpose: Verifies file-change path and snapshot duplicate filtering.
// Layer: Unit Test
// Exports: TurnTimelineReducerFileChangeSnapshotDeduplicationTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineReducerFileChangeSnapshotDeduplicationTests: XCTestCase {
func testRemoveDuplicateFileChangeMessagesDedupesSingleFileRowsAcrossPathRepresentations() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "diff-1",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: "Edited TurnToolbarContent.swift +2 -13",
            createdAt: now,
            turnID: nil,
            itemID: nil,
            isStreaming: true
        ),
        makeTimelineTestMessage(
            id: "diff-2",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: AgntMobile/AgntMobile/Views/Turn/TurnToolbarContent.swift
            Kind: update
            Totals: +2 -13
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "turn-diff-1",
            isStreaming: false
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateFileChangeMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["diff-2"])
}

func testRemoveDuplicateFileChangeMessagesKeepsDistinctDirectoryScopedSnapshots() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "diff-1",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/FeatureA/TurnToolbarContent.swift
            Kind: update
            Totals: +2 -13
            """,
            createdAt: now,
            turnID: "turn-1",
            itemID: "diff-a",
            isStreaming: false
        ),
        makeTimelineTestMessage(
            id: "diff-2",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/FeatureB/TurnToolbarContent.swift
            Kind: update
            Totals: +2 -13
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "diff-b",
            isStreaming: false
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateFileChangeMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["diff-1", "diff-2"])
}

func testRemoveDuplicateFileChangeMessagesKeepsNewestSnapshotForSamePaths() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "diff-1",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Edited Sources/App.swift +2 -1
            Edited Sources/Composer.swift +3 -1
            """,
            createdAt: now,
            turnID: "turn-1",
            itemID: "filechange-1",
            isStreaming: true
        ),
        makeTimelineTestMessage(
            id: "diff-2",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Edited Sources/App.swift +4 -2
            Edited Sources/Composer.swift +6 -2
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "turn-diff-1",
            isStreaming: false
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateFileChangeMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["diff-2"])
}

func testRemoveDuplicateFileChangeMessagesKeepsDistinctCompletedSnapshotsForSamePaths() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "diff-1",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Edited Sources/App.swift +2 -1
            Edited Sources/Composer.swift +3 -1
            """,
            createdAt: now,
            turnID: "turn-1",
            itemID: "turn-diff-1",
            isStreaming: false
        ),
        makeTimelineTestMessage(
            id: "diff-2",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Edited Sources/App.swift +4 -2
            Edited Sources/Composer.swift +6 -2
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "turn-diff-2",
            isStreaming: false
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateFileChangeMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["diff-1", "diff-2"])
}

func testRemoveDuplicateFileChangeMessagesDropsStreamingSubsetWhenLaterSnapshotAddsFiles() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "diff-1",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: "Edited Sources/App.swift +2 -1",
            createdAt: now,
            turnID: "turn-1",
            itemID: "filechange-1",
            isStreaming: true
        ),
        makeTimelineTestMessage(
            id: "diff-2",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Edited Sources/App.swift +4 -2
            Edited Sources/Composer.swift +6 -2
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "turn-diff-1",
            isStreaming: false
        ),
        makeTimelineTestMessage(
            id: "diff-3",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: "Edited Sources/Other.swift +1 -0",
            createdAt: now.addingTimeInterval(2),
            turnID: "turn-1",
            itemID: "turn-diff-2",
            isStreaming: false
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateFileChangeMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["diff-2", "diff-3"])
}

func testRemoveDuplicateFileChangeMessagesKeepsDistinctTurnSnapshots() {
    let now = Date()
    let messages = [
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
            createdAt: now,
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
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1"
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateFileChangeMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["diff-1", "diff-2"])
}
}
