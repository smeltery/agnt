// FILE: CodexServiceIncomingHistoryMergeTests.swift
// Purpose: Verifies reasoning and history-merge reconciliation behavior from incoming events.
// Layer: Unit Test
// Exports: CodexServiceIncomingHistoryMergeTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingHistoryMergeTests: CodexServiceIncomingHistoryMergeTestCase {
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

}
