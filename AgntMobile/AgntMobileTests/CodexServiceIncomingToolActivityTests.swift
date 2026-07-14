// FILE: CodexServiceIncomingToolActivityTests.swift
// Purpose: Verifies incoming tool-activity rows and merge behavior.
// Layer: Unit Test
// Exports: CodexServiceIncomingToolActivityTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingToolActivityTests: CodexServiceIncomingCommandExecutionTestCase {
    func testEssentialReadEventUsesToolActivityInsteadOfThinking() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "codex/event/read",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "path": .string("A.swift"),
            ])
        )

        let toolRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .toolActivity
        }
        let thinkingRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .thinking
        }

        XCTAssertEqual(toolRows.count, 1)
        XCTAssertEqual(toolRows[0].text, "Read A.swift")
        XCTAssertTrue(thinkingRows.isEmpty)
    }

    func testLiveToolActivityReusesSingleMatchingTurnRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let existing = CodexMessage(
            threadId: threadID,
            role: .system,
            kind: .toolActivity,
            text: "Read A.swift",
            turnId: turnID,
            itemId: nil,
            isStreaming: true,
            deliveryState: .confirmed
        )
        service.messagesByThread[threadID] = [existing]

        service.upsertStreamingSystemItemMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "tool-real",
            kind: .toolActivity,
            text: "Read A.swift",
            isStreaming: true
        )

        let toolRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .toolActivity
        }
        XCTAssertEqual(toolRows.count, 1)
        XCTAssertEqual(toolRows[0].id, existing.id)
        XCTAssertEqual(toolRows[0].itemId, "tool-real")
    }

    func testLiveToolActivityKeepsDistinctStableItemsWithIdenticalTextSeparated() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.upsertStreamingSystemItemMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "tool-1",
            kind: .toolActivity,
            text: "Read foo.swift",
            isStreaming: true
        )
        service.upsertStreamingSystemItemMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "tool-2",
            kind: .toolActivity,
            text: "Read foo.swift",
            isStreaming: true
        )

        let toolRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .toolActivity
        }
        XCTAssertEqual(toolRows.count, 2)
        XCTAssertEqual(toolRows.map(\.itemId), ["tool-1", "tool-2"])
    }

    func testCompletedToolActivityPlaceholderIsRemovedWhenNoContentArrives() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "tool-\(UUID().uuidString)"

        service.upsertStreamingSystemItemMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: itemID,
            kind: .toolActivity,
            text: "",
            isStreaming: true
        )
        service.completeStreamingSystemItemMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: itemID,
            kind: .toolActivity,
            text: nil
        )

        let toolRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .toolActivity
        }
        XCTAssertTrue(toolRows.isEmpty)
    }

    func testLegacyToolActivityAfterAssistantCreatesNewLaterRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        service.messagesByThread[threadID] = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read A.swift",
                createdAt: now,
                turnId: turnID,
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                kind: .chat,
                text: "Prima risposta",
                createdAt: now.addingTimeInterval(0.1),
                turnId: turnID,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        service.appendToolActivityLine(
            threadId: threadID,
            turnId: turnID,
            line: "Read B.swift"
        )

        let messages = service.messages(for: threadID)
        let toolRows = messages.filter { $0.role == .system && $0.kind == .toolActivity }

        XCTAssertEqual(toolRows.count, 2)
        XCTAssertEqual(toolRows[0].text, "Read A.swift")
        XCTAssertEqual(toolRows[1].text, "Read B.swift")
        XCTAssertEqual(messages.map(\.role), [.system, .assistant, .system])
    }

    func testHistoryMergeDoesNotCollapseRepeatedToolActivityRowsWhenTurnHasMultipleCandidates() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now,
                turnId: turnID,
                itemId: "tool-1",
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now.addingTimeInterval(0.1),
                turnId: turnID,
                itemId: "tool-2",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now.addingTimeInterval(0.2),
                turnId: turnID,
                itemId: "tool-3",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let toolRows = merged.filter { $0.role == .system && $0.kind == .toolActivity }

        XCTAssertEqual(toolRows.map(\.itemId), ["tool-1", "tool-2", "tool-3"])
    }

    func testHistoryMergeUpgradesSyntheticToolActivityIdentityToRealItemID() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now,
                turnId: turnID,
                itemId: "turn:\(turnID)|kind:toolActivity",
                isStreaming: true,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now.addingTimeInterval(0.2),
                turnId: turnID,
                itemId: "tool-1",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let toolRows = merged.filter { $0.role == .system && $0.kind == .toolActivity }

        XCTAssertEqual(toolRows.count, 1)
        XCTAssertEqual(toolRows[0].itemId, "tool-1")
    }

    func testHistoryMergeKeepsSingleCompletedSyntheticToolActivitySeparateFromRepeatedHistoryRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now,
                turnId: turnID,
                itemId: "turn:\(turnID)|kind:toolActivity",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now.addingTimeInterval(0.2),
                turnId: turnID,
                itemId: "tool-1",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let toolRows = merged.filter { $0.role == .system && $0.kind == .toolActivity }

        XCTAssertEqual(toolRows.count, 2)
        XCTAssertEqual(toolRows.map(\.itemId), ["turn:\(turnID)|kind:toolActivity", "tool-1"])
    }
}
