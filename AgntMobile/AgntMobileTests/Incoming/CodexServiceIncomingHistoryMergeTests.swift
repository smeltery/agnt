// FILE: CodexServiceIncomingHistoryMergeTests.swift
// Purpose: Verifies reasoning and history-merge reconciliation behavior from incoming events.
// Layer: Unit Test
// Exports: CodexServiceIncomingHistoryMergeTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingHistoryMergeTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testReasoningDeltasPreserveWhitespaceAndCompletionReplacesSnapshot() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "reasoning-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string("**Providing"),
            ])
        )
        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string(" exact 200-word paragraph**"),
            ])
        )
        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("reasoning"),
                    "content": .array([
                        .object([
                            "type": .string("text"),
                            "text": .string("**Providing exact 200-word paragraph**"),
                        ]),
                    ]),
                ]),
            ])
        )

        let thinkingRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .thinking
        }
        XCTAssertEqual(thinkingRows.count, 1)
        XCTAssertEqual(thinkingRows[0].text, "**Providing exact 200-word paragraph**")
    }

    func testReasoningSummaryPartBoundariesStayPlainDuringStreaming() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "reasoning-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "item/reasoning/summaryTextDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "summaryIndex": .integer(0),
                "delta": .string("**Testing notify command behavior**\n\n<!-- -->"),
            ])
        )
        service.handleNotification(
            method: "item/reasoning/summaryPartAdded",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "summary_index": .integer(1),
                "delta": .string("**Analyzing notify hook JSON output format**\n\n<!-- -->"),
            ])
        )
        service.flushPendingSystemDeltas(threadId: threadID, itemId: itemID)

        let thinkingRow = service.messages(for: threadID).first(where: {
            $0.role == .system && $0.kind == .thinking && $0.itemId == itemID
        })
        let text = try? XCTUnwrap(thinkingRow?.text)
        XCTAssertEqual(
            text,
            "**Testing notify command behavior**\n\n<!-- -->\n\n**Analyzing notify hook JSON output format**\n\n<!-- -->"
        )
        XCTAssertTrue(text.map { ThinkingDisclosureParser.parse(from: $0).isSummaryOnly } ?? false)
    }

    func testLateReasoningDeltaAfterTurnCompletionDoesNotCreateNewThinkingRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "reasoning-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )

        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string("Late reasoning chunk"),
            ])
        )

        let thinkingRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .thinking
        }
        XCTAssertTrue(thinkingRows.isEmpty)
    }

    func testLateReasoningDeltaAfterTurnCompletionUpdatesExistingThinkingWithoutStreaming() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "reasoning-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string("First"),
            ])
        )
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string(" second"),
            ])
        )

        let thinkingRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .thinking
        }
        XCTAssertEqual(thinkingRows.count, 1)
        XCTAssertEqual(thinkingRows[0].text, "First second")
        XCTAssertFalse(thinkingRows[0].isStreaming)
    }

    func testHistoryMergeReconcilesThinkingByTurnWhenTextDiffers() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .thinking,
                text: "**Providingexact200-wordparagraph**",
                createdAt: now,
                turnId: turnID,
                itemId: nil,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .thinking,
                text: "**Providing exact 200-word paragraph**",
                createdAt: now.addingTimeInterval(1),
                turnId: turnID,
                itemId: nil,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].text, "**Providing exact 200-word paragraph**")
    }

    func testReasoningDeltaWithoutIDsIsIgnoredWhenMultipleThreadsExist() {
        let service = makeService()
        let firstThreadID = "thread-\(UUID().uuidString)"
        let secondThreadID = "thread-\(UUID().uuidString)"
        service.threads = [
            CodexThread(id: firstThreadID, title: "First"),
            CodexThread(id: secondThreadID, title: "Second"),
        ]
        service.activeThreadId = firstThreadID

        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "delta": .string("Should not route"),
            ])
        )

        XCTAssertTrue(service.messages(for: firstThreadID).isEmpty)
        XCTAssertTrue(service.messages(for: secondThreadID).isEmpty)
    }

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


    private func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingHistoryMergeTests.(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        Self.retainedServices.append(service)
        return service
    }
}
