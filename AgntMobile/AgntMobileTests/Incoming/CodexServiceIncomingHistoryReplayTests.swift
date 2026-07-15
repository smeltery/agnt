// FILE: CodexServiceIncomingHistoryReplayTests.swift
// Purpose: Verifies history merge replay and assistant-row deduplication behavior.
// Layer: Unit Test
// Exports: CodexServiceIncomingHistoryReplayTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingHistoryReplayTests: CodexServiceIncomingHistoryMergeTestCase {
    func testHistoryMergeDedupesQuotedCommandExecutionPreviews() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .commandExecution,
                text: "completed /bin/zsh -lc rg --files",
                createdAt: now,
                turnId: turnID,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .commandExecution,
                text: "completed /bin/zsh -lc \"rg --files\"",
                createdAt: now.addingTimeInterval(1),
                turnId: turnID,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let commandRows = merged.filter { $0.role == .system && $0.kind == .commandExecution }

        XCTAssertEqual(commandRows.count, 1)
        XCTAssertEqual(commandRows[0].turnId, turnID)
    }

    func testHistoryMergeReconcilesClosedSingleAssistantTurnWhenCanonicalSnapshotDiffers() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Testo parziale",
                createdAt: now,
                turnId: turnID,
                itemId: "local-message",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Testo finale",
                createdAt: now.addingTimeInterval(1),
                turnId: turnID,
                itemId: "server-message",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let assistantRows = merged.filter { $0.role == .assistant }

        XCTAssertEqual(assistantRows.count, 1)
        XCTAssertEqual(assistantRows[0].turnId, turnID)
        XCTAssertEqual(assistantRows[0].itemId, "server-message")
        XCTAssertEqual(assistantRows[0].text, "Testo finale")
    }

    func testHistoryMergeDoesNotCollapseSingleAssistantTurnWhileStillRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        service.runningThreadIDs.insert(threadID)

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Testo parziale",
                createdAt: now,
                turnId: turnID,
                itemId: "local-message",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Testo finale",
                createdAt: now.addingTimeInterval(1),
                turnId: turnID,
                itemId: "server-message",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let assistantRows = merged.filter { $0.role == .assistant }

        XCTAssertEqual(assistantRows.count, 2)
        XCTAssertEqual(assistantRows.map(\.itemId), ["local-message", "server-message"])
    }

    func testHistoryMergeSkipsFlattenedAssistantBlockReplay() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()
        let introText = "I'll check Gmail for the latest TestFlight message."
        let finalText = "Latest TestFlight version: 1.4 (123)."

        let existing = [
            CodexMessage(
                id: "assistant-intro",
                threadId: threadID,
                role: .assistant,
                text: introText,
                createdAt: now,
                turnId: turnID,
                itemId: "item-intro",
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                id: "tool-row",
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read 6807e4de/...",
                createdAt: now.addingTimeInterval(1),
                turnId: turnID,
                itemId: "tool-1",
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                id: "assistant-final",
                threadId: threadID,
                role: .assistant,
                text: finalText,
                createdAt: now.addingTimeInterval(2),
                turnId: nil,
                itemId: "item-final",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                id: "assistant-replay",
                threadId: threadID,
                role: .assistant,
                text: "\(introText)\n\n\(finalText)",
                createdAt: now.addingTimeInterval(3),
                turnId: turnID,
                itemId: "item-replay",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let assistantRows = merged.filter { $0.role == .assistant }

        XCTAssertEqual(assistantRows.map(\.id), ["assistant-intro", "assistant-final"])
        XCTAssertEqual(assistantRows.map(\.text), [introText, finalText])
    }

    func testHistoryMergeSkipsLongExactTerminalReplayAfterTurnlessFinal() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()
        let finalText = """
        Latest TestFlight inbox email says:

        agnt version 1.4, build 124

        Subject: "agnt - Remote AI Coding 1.4 (124) for iOS is now available to test."
        """

        let existing = [
            CodexMessage(
                id: "assistant-final",
                threadId: threadID,
                role: .assistant,
                text: finalText,
                createdAt: now,
                turnId: nil,
                itemId: "item-final",
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                id: "assistant-status",
                threadId: threadID,
                role: .assistant,
                text: "I'll use the Gmail connector to search recent inbox mentions.",
                createdAt: now.addingTimeInterval(1),
                turnId: turnID,
                itemId: "item-status",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                id: "assistant-terminal-replay",
                threadId: threadID,
                role: .assistant,
                text: finalText,
                createdAt: now.addingTimeInterval(2),
                turnId: turnID,
                itemId: "item-terminal",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let assistantRows = merged.filter { $0.role == .assistant }

        XCTAssertEqual(assistantRows.map(\.id), ["assistant-final", "assistant-status"])
        XCTAssertEqual(assistantRows.map(\.text), [
            finalText,
            "I'll use the Gmail connector to search recent inbox mentions.",
        ])
    }

    func testInitialHistorySkipsFlattenedAssistantBlockReplay() throws {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()
        let introText = "I'll check Gmail for the latest TestFlight message."
        let finalText = "Latest TestFlight version: 1.4 (123)."
        let history = [
            CodexMessage(
                id: "assistant-intro",
                threadId: threadID,
                role: .assistant,
                text: introText,
                createdAt: now,
                turnId: turnID,
                itemId: "item-intro",
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                id: "tool-row",
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read 6807e4de/...",
                createdAt: now.addingTimeInterval(1),
                turnId: turnID,
                itemId: "tool-1",
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                id: "assistant-final",
                threadId: threadID,
                role: .assistant,
                text: finalText,
                createdAt: now.addingTimeInterval(2),
                turnId: nil,
                itemId: "item-final",
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                id: "assistant-replay",
                threadId: threadID,
                role: .assistant,
                text: "\(introText)\n\n\(finalText)",
                createdAt: now.addingTimeInterval(3),
                turnId: turnID,
                itemId: "item-replay",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = try CodexService.mergeHistoryMessages(
            [],
            history,
            activeThreadIDs: [],
            runningThreadIDs: []
        )
        let assistantRows = merged.filter { $0.role == .assistant }

        XCTAssertEqual(assistantRows.map(\.id), ["assistant-intro", "assistant-final"])
        XCTAssertEqual(assistantRows.map(\.text), [introText, finalText])
    }

    func testHistoryMergeDoesNotRegressClosedSingleAssistantTurnToShorterSnapshot() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Testo finale completo",
                createdAt: now,
                turnId: turnID,
                itemId: "local-message",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Testo finale",
                createdAt: now.addingTimeInterval(1),
                turnId: turnID,
                itemId: "server-message",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let assistantRows = merged.filter { $0.role == .assistant }

        XCTAssertEqual(assistantRows.count, 1)
        XCTAssertEqual(assistantRows[0].text, "Testo finale completo")
        XCTAssertEqual(assistantRows[0].itemId, "local-message")
    }

    func testHistoryMergeKeepsDistinctAssistantItemsInSameTurnWhenHistoryIDsArriveLater() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Prima risposta",
                createdAt: now,
                turnId: turnID,
                itemId: nil,
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Seconda risposta",
                createdAt: now.addingTimeInterval(1),
                turnId: turnID,
                itemId: "message-2",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Terza risposta",
                createdAt: now.addingTimeInterval(2),
                turnId: turnID,
                itemId: "message-3",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let assistantRows = merged.filter { $0.role == .assistant }

        XCTAssertEqual(assistantRows.count, 3)
        XCTAssertEqual(assistantRows.map(\.text), ["Prima risposta", "Seconda risposta", "Terza risposta"])
        XCTAssertEqual(assistantRows.map(\.itemId), [nil, "message-2", "message-3"])
    }

    func testHistoryMergeDoesNotCollapseRepeatedAssistantTextAcrossDistinctItemsInSameTurn() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Ok",
                createdAt: now,
                turnId: turnID,
                itemId: "message-1",
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Ok",
                createdAt: now.addingTimeInterval(1),
                turnId: turnID,
                itemId: "message-2",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Ok",
                createdAt: now.addingTimeInterval(2),
                turnId: turnID,
                itemId: "message-3",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let assistantRows = merged.filter { $0.role == .assistant }

        XCTAssertEqual(assistantRows.count, 3)
        XCTAssertEqual(assistantRows.map(\.itemId), ["message-1", "message-2", "message-3"])
    }
}
