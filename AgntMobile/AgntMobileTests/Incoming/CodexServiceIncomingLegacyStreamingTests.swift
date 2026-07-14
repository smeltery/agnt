// FILE: CodexServiceIncomingLegacyStreamingTests.swift
// Purpose: Verifies legacy incoming streaming replay and completion behavior.
// Layer: Unit Test
// Exports: CodexServiceIncomingLegacyStreamingTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingLegacyStreamingTests: CodexServiceIncomingStreamingTestCase {
    func testTurnlessFinalThenTerminalReplayDoesNotDuplicateAssistantAnswer() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let finalText = """
        Latest TestFlight inbox email says:

        agnt version 1.4, build 124

        Subject: "agnt - Remote AI Coding 1.4 (124) for iOS is now available to test."
        """

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: nil,
            itemId: "item-final",
            text: finalText
        )
        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.markTurnCompleted(threadId: threadID, turnId: turnID)

        service.appendAssistantDelta(
            threadId: threadID,
            turnId: turnID,
            itemId: "item-status",
            delta: "I'll use the Gmail connector to search your recent inbox."
        )
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID, itemId: "item-status")
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "item-terminal",
            text: finalText
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages.first?.text, finalText)
        XCTAssertEqual(assistantMessages.first?.turnId, turnID)
        XCTAssertFalse(assistantMessages.first?.isStreaming ?? true)
    }

    func testTurnlessTerminalReplayDoesNotDuplicateAssistantAnswer() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let finalText = """
        Latest TestFlight inbox email says:

        agnt version 1.4, build 124

        Subject: "agnt - Remote AI Coding 1.4 (124) for iOS is now available to test."
        """

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: nil,
            itemId: "item-final",
            text: finalText
        )
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: nil,
            itemId: "item-terminal",
            text: finalText
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages.first?.text, finalText)
    }

    func testMergeAssistantDeltaKeepsLongReplayOverlapWithoutDuplication() {
        let service = makeService()
        let overlap = String(repeating: "a", count: 300)
        let existing = "prefix-" + overlap
        let incoming = overlap + "-suffix"

        let merged = service.mergeAssistantDelta(existingText: existing, incomingDelta: incoming)

        XCTAssertEqual(merged, "prefix-" + overlap + "-suffix")
    }

    func testMarkTurnCompletedFinalizesAllAssistantItemsForTurn() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: "A")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-2", delta: "B")

        service.markTurnCompleted(threadId: threadID, turnId: turnID)

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertTrue(assistantMessages.allSatisfy { !$0.isStreaming })

        let turnStreamingKey = "\(threadID)|\(turnID)"
        XCTAssertNil(service.streamingAssistantFallbackMessageByTurnID[turnStreamingKey])
        XCTAssertFalse(service.streamingAssistantMessageByItemKey.keys.contains { key in
            key.hasPrefix("\(turnStreamingKey)|item:")
        })
    }

    func testSuccessfulTurnCompletionFinalizesIncompletePlanSteps() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/plan/updated",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "explanation": .string("Finish the work in safe slices."),
                "plan": .array([
                    .object([
                        "step": .string("Inspect"),
                        "status": .string("completed"),
                    ]),
                    .object([
                        "step": .string("Implement"),
                        "status": .string("in_progress"),
                    ]),
                    .object([
                        "step": .string("Verify"),
                        "status": .string("pending"),
                    ]),
                ]),
            ])
        )

        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("plan"),
                    "content": .array([
                        .object([
                            "type": .string("text"),
                            "text": .string("1. Inspect\n2. Implement\n3. Verify"),
                        ]),
                    ]),
                ]),
            ])
        )

        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: turnID)

        let planMessages = service.messages(for: threadID).filter { $0.kind == .plan }
        XCTAssertEqual(planMessages.count, 1)
        XCTAssertFalse(planMessages[0].isStreaming)
        XCTAssertEqual(planMessages[0].planState?.steps.map(\.status), [.completed, .completed, .completed])
        XCTAssertFalse(planMessages[0].shouldDisplayPinnedPlanAccessory)
    }

    func testLegacyAgentDeltaParsesTopLevelTurnIdAndMessageId() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "codex/event/agent_message_content_delta",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message_content_delta"),
                    "message_id": .string("message-1"),
                    "delta": .string("Primo blocco"),
                ]),
            ])
        )

        service.handleNotification(
            method: "codex/event/agent_message_content_delta",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message_content_delta"),
                    "message_id": .string("message-2"),
                    "delta": .string("Secondo blocco"),
                ]),
            ])
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertEqual(assistantMessages[0].turnId, turnID)
        XCTAssertEqual(assistantMessages[0].itemId, "message-1")
        XCTAssertEqual(assistantMessages[0].text, "Primo blocco")
        XCTAssertFalse(assistantMessages[0].isStreaming)

        XCTAssertEqual(assistantMessages[1].turnId, turnID)
        XCTAssertEqual(assistantMessages[1].itemId, "message-2")
        XCTAssertEqual(assistantMessages[1].text, "Secondo blocco")
        XCTAssertTrue(assistantMessages[1].isStreaming)
    }

    func testLegacyAgentCompletionUsesMessageIdToFinalizeMatchingStream() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "codex/event/agent_message_content_delta",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message_content_delta"),
                    "message_id": .string("message-1"),
                    "delta": .string("Testo parziale"),
                ]),
            ])
        )

        service.handleNotification(
            method: "codex/event/agent_message",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message"),
                    "message_id": .string("message-1"),
                    "message": .string("Testo finale"),
                ]),
            ])
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages[0].turnId, turnID)
        XCTAssertEqual(assistantMessages[0].itemId, "message-1")
        XCTAssertEqual(assistantMessages[0].text, "Testo finale")
        XCTAssertFalse(assistantMessages[0].isStreaming)
    }

    func testIncomingItemCompletionBeforeFallbackDoesNotCaptureTurnScopedDelta() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "codex/event/agent_message",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message"),
                    "message_id": .string("message-1"),
                    "message": .string("Risposta precedente"),
                ]),
            ])
        )

        service.handleNotification(
            method: "codex/event/agent_message_content_delta",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message_content_delta"),
                    "delta": .string("Risposta corrente"),
                ]),
            ])
        )
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertEqual(assistantMessages.map { $0.itemId ?? "" }, ["message-1", ""])
        XCTAssertEqual(assistantMessages.map(\.text), ["Risposta precedente", "Risposta corrente"])
        XCTAssertFalse(assistantMessages[0].isStreaming)
        XCTAssertTrue(assistantMessages[1].isStreaming)
    }

    func testLateLegacyAgentCompletionWithoutMessageIdUpdatesClosedSingleAssistantBubble() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "codex/event/agent_message_content_delta",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message_content_delta"),
                    "message_id": .string("message-1"),
                    "delta": .string("Testo parziale"),
                ]),
            ])
        )

        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: turnID)

        service.handleNotification(
            method: "codex/event/agent_message",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message"),
                    "message": .string("Testo finale"),
                ]),
            ])
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages[0].turnId, turnID)
        XCTAssertEqual(assistantMessages[0].itemId, "message-1")
        XCTAssertEqual(assistantMessages[0].text, "Testo finale")
        XCTAssertFalse(assistantMessages[0].isStreaming)
    }

    func testLateLegacyAgentCompletionWithoutMessageIdIsIgnoredForClosedMultiAssistantTurn() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "codex/event/agent_message_content_delta",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message_content_delta"),
                    "message_id": .string("message-1"),
                    "delta": .string("Primo blocco"),
                ]),
            ])
        )
        service.handleNotification(
            method: "codex/event/agent_message_content_delta",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message_content_delta"),
                    "message_id": .string("message-2"),
                    "delta": .string("Secondo blocco"),
                ]),
            ])
        )

        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: turnID)

        service.handleNotification(
            method: "codex/event/agent_message",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message"),
                    "message": .string("Risposta finale ambigua"),
                ]),
            ])
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertEqual(assistantMessages[0].text, "Primo blocco")
        XCTAssertEqual(assistantMessages[1].text, "Secondo blocco")
    }

    func testLateLegacyAgentCompletionWithoutMessageIdDoesNotRegressClosedSingleAssistantBubble() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "codex/event/agent_message_content_delta",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message_content_delta"),
                    "message_id": .string("message-1"),
                    "delta": .string("Testo finale completo"),
                ]),
            ])
        )

        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: turnID)

        service.handleNotification(
            method: "codex/event/agent_message",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("agent_message"),
                    "message": .string("Testo finale"),
                ]),
            ])
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages[0].text, "Testo finale completo")
        XCTAssertEqual(assistantMessages[0].itemId, "message-1")
    }

    func testLongerClosedAssistantSnapshotDoesNotAppendOtherAssistantBlocks() {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let finalText = """
        Summary

        TLDR: risposta finale.
        """
        let flattenedText = """
        Summary

        TLDR: risposta finale.

        Uso la skill check-code perché sto controllando la repo.

        Riprendo da dove avevo lasciato.
        """
        let localMessage = CodexMessage(
            threadId: threadID,
            role: .assistant,
            text: finalText,
            turnId: turnID,
            itemId: "message-1",
            isStreaming: false
        )
        let serverMessage = CodexMessage(
            threadId: threadID,
            role: .assistant,
            text: flattenedText,
            turnId: turnID,
            itemId: "message-1",
            isStreaming: false
        )

        XCTAssertFalse(
            CodexService.shouldReplaceClosedAssistantMessage(localMessage, with: serverMessage)
        )
    }
}
