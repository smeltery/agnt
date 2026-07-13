// FILE: TurnTimelineReducerDeduplicationTests.swift
// Purpose: Verifies timeline duplicate message filtering.
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
