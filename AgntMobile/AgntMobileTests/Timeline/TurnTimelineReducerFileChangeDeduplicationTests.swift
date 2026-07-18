// FILE: TurnTimelineReducerFileChangeDeduplicationTests.swift
// Purpose: Verifies aggregate file-change duplicate filtering.
// Layer: Unit Test
// Exports: TurnTimelineReducerFileChangeDeduplicationTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnTimelineReducerFileChangeDeduplicationTests: XCTestCase {
func testRemoveDuplicateFileChangeMessagesKeepsNewestMatchingTurnSnapshot() {
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
            Status: completed

            Path: Sources/App.swift
            Kind: update
            Totals: +2 -1
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "diff-1",
            isStreaming: false
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateFileChangeMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["diff-2"])
}

func testRemoveDuplicateFileChangeMessagesStreamingAggregateAbsorbsCompletedSubsetCard() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "aggregate-live",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Path: Sources/App.swift
            Kind: update
            Totals: +10 -2

            Path: Sources/Feature.swift
            Kind: update
            Totals: +4 -1
            """,
            createdAt: now,
            turnID: "turn-1",
            itemID: "turn-diff-aggregate",
            isStreaming: true
        ),
        makeTimelineTestMessage(
            id: "card-subset",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/App.swift
            Kind: update
            Totals: +3 -1
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "patch-2",
            isStreaming: false
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateFileChangeMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["aggregate-live"])
}

func testRemoveDuplicateFileChangeMessagesCompletedAggregateAbsorbsStrictSubsetCard() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "aggregate-final",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Path: Sources/App.swift
            Kind: update
            Totals: +10 -2

            Path: Sources/Feature.swift
            Kind: update
            Totals: +4 -1
            """,
            createdAt: now,
            turnID: "turn-1",
            itemID: "turn-diff-aggregate",
            isStreaming: false
        ),
        makeTimelineTestMessage(
            id: "card-subset",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/App.swift
            Kind: update
            Totals: +3 -1
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "patch-2",
            isStreaming: false
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateFileChangeMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["aggregate-final"])
}

func testRemoveDuplicateFileChangeMessagesKnownAggregateAbsorbsEqualPathCard() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "aggregate-final",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Path: Sources/App.swift
            Kind: update
            Totals: +10 -2

            Path: Sources/Feature.swift
            Kind: update
            Totals: +4 -1
            """,
            createdAt: now,
            turnID: "turn-1",
            itemID: CodexSyntheticIdentifiers.placeholderItemID(turnId: "turn-1", kind: .fileChange),
            isStreaming: false
        ),
        makeTimelineTestMessage(
            id: "card-equal",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/App.swift
            Kind: update
            Totals: +3 -1

            Path: Sources/Feature.swift
            Kind: update
            Totals: +1 -0
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "patch-2",
            isStreaming: false
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateFileChangeMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["aggregate-final"])
}

func testRemoveDuplicateFileChangeMessagesUnknownCompletedAggregateKeepsEqualPathCard() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "aggregate-adopted-id",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Path: Sources/App.swift
            Kind: update
            Totals: +10 -2

            Path: Sources/Feature.swift
            Kind: update
            Totals: +4 -1
            """,
            createdAt: now,
            turnID: "turn-1",
            itemID: "item-real-42",
            isStreaming: false
        ),
        makeTimelineTestMessage(
            id: "card-equal",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: completed

            Path: Sources/App.swift
            Kind: update
            Totals: +3 -1

            Path: Sources/Feature.swift
            Kind: update
            Totals: +1 -0
            """,
            createdAt: now.addingTimeInterval(1),
            turnID: "turn-1",
            itemID: "patch-2",
            isStreaming: false
        ),
    ]

    let deduped = TurnTimelineReducer.removeDuplicateFileChangeMessages(in: messages)
    XCTAssertEqual(deduped.map(\.id), ["aggregate-adopted-id", "card-equal"])
}

func testRemoveDuplicateFileChangeMessagesIgnoresStatusOnlyDifferences() {
    let now = Date()
    let messages = [
        makeTimelineTestMessage(
            id: "diff-1",
            threadID: "thread",
            role: .system,
            kind: .fileChange,
            text: """
            Status: inProgress

            Path: Sources/App.swift
            Kind: update
            Totals: +2 -1
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
            Status: completed

            Path: Sources/App.swift
            Kind: update
            Totals: +2 -1
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
}
