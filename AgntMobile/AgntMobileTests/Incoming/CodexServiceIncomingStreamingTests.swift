// FILE: CodexServiceIncomingStreamingTests.swift
// Purpose: Verifies assistant streaming, replay, and deduplication behavior from incoming events.
// Layer: Unit Test
// Exports: CodexServiceIncomingStreamingTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingStreamingTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testAssistantStreamingKeepsSeparateBlocksWhenItemChangesWithinTurn() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: "First")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: " chunk")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-2", delta: "Second")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertEqual(assistantMessages[0].itemId, "item-1")
        XCTAssertEqual(assistantMessages[0].text, "First chunk")
        XCTAssertFalse(assistantMessages[0].isStreaming)

        XCTAssertEqual(assistantMessages[1].itemId, "item-2")
        XCTAssertEqual(assistantMessages[1].text, "Second")
        XCTAssertTrue(assistantMessages[1].isStreaming)
    }

    func testAssistantStreamingUpdatesExistingRenderSnapshotText() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        _ = service.timelineState(for: threadID)
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: "First")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)
        let firstSnapshot = service.timelineState(for: threadID).renderSnapshot

        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: " chunk")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)
        let secondSnapshot = service.timelineState(for: threadID).renderSnapshot

        XCTAssertEqual(firstSnapshot.messages.count, 1)
        XCTAssertEqual(firstSnapshot.messages[0].text, "First")
        XCTAssertEqual(secondSnapshot.messages.count, 1)
        XCTAssertEqual(secondSnapshot.messages[0].text, "First chunk")
        XCTAssertGreaterThan(secondSnapshot.timelineChangeToken, firstSnapshot.timelineChangeToken)
    }

    func testAssistantStreamingFastPathKeepsCurrentOutputInSync() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        _ = service.timelineState(for: threadID)
        service.activeThreadId = threadID

        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: "First")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: " chunk")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        XCTAssertEqual(service.currentOutput, "First chunk")
    }

    func testAssistantStreamingFallbackKeepsCurrentOutputInSyncWithoutTimelineState() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.activeThreadId = threadID

        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: "First")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: " chunk")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        XCTAssertEqual(service.currentOutput, "First chunk")
        XCTAssertEqual(service.timelineState(for: threadID).renderSnapshot.messages.first?.text, "First chunk")
    }

    func testLateDeltaForOlderAssistantItemDoesNotReplaceLatestOutput() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        _ = service.timelineState(for: threadID)
        service.activeThreadId = threadID

        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: "First")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-2", delta: "Second")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: " tail")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        XCTAssertEqual(service.currentOutput, "Second")
    }

    func testLateOlderAssistantItemDeltaDoesNotStealTurnFallbackStream() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: "First")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-2", delta: "Second")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: " tail")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: nil, delta: " current")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.map { $0.itemId ?? "" }, ["item-1", "item-2"])
        XCTAssertEqual(assistantMessages.map(\.text), ["First tail", "Second current"])
    }

    func testLateOlderAssistantCompletionDoesNotStealTurnFallbackStream() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-1", delta: "First")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-2", delta: "Second")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        service.completeAssistantMessage(threadId: threadID, turnId: turnID, itemId: "item-1", text: "First final")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: nil, delta: " current")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.map { $0.itemId ?? "" }, ["item-1", "item-2"])
        XCTAssertEqual(assistantMessages.map(\.text), ["First final", "Second current"])
    }

    func testUnseenItemCompletionDoesNotStealTurnFallbackStream() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: "item-2", delta: "Second")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        service.completeAssistantMessage(threadId: threadID, turnId: turnID, itemId: "item-1", text: "First final")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: nil, delta: " current")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.map { $0.itemId ?? "" }, ["item-2", "item-1"])
        XCTAssertEqual(assistantMessages.map(\.text), ["Second current", "First final"])
        XCTAssertFalse(assistantMessages.last?.isStreaming ?? true)
    }

    func testItemCompletionBeforeFallbackDoesNotCaptureTurnScopedDelta() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.completeAssistantMessage(threadId: threadID, turnId: turnID, itemId: "item-1", text: "First final")
        service.appendAssistantDelta(threadId: threadID, turnId: turnID, itemId: nil, delta: " current")
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.map { $0.itemId ?? "" }, ["item-1", ""])
        XCTAssertEqual(assistantMessages.map(\.text), ["First final", " current"])
        XCTAssertFalse(assistantMessages.first?.isStreaming ?? true)
        XCTAssertTrue(assistantMessages.last?.isStreaming ?? false)
    }

    func testProjectionPreservesVisibleTurnPromptAndDurableArtifacts() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let visibleTurnID = "turn-\(UUID().uuidString)"
        let olderTurnID = "turn-\(UUID().uuidString)"
        var messages: [CodexMessage] = [
            makeTimelineMessage(
                id: "older-plan",
                threadID: threadID,
                role: .system,
                kind: .plan,
                text: "Older plan",
                turnID: olderTurnID,
                orderIndex: 0
            ),
            makeTimelineMessage(
                id: "visible-prompt",
                threadID: threadID,
                role: .user,
                text: "Fix the long-running thread",
                turnID: visibleTurnID,
                orderIndex: 1
            ),
            makeTimelineMessage(
                id: "visible-plan",
                threadID: threadID,
                role: .system,
                kind: .plan,
                text: "1. Inspect\n2. Patch",
                turnID: visibleTurnID,
                orderIndex: 2
            ),
            makeTimelineMessage(
                id: "visible-file-change",
                threadID: threadID,
                role: .system,
                kind: .fileChange,
                text: "Modified Sources/App.swift",
                turnID: visibleTurnID,
                orderIndex: 3
            ),
        ]

        for index in 4..<95 {
            messages.append(makeTimelineMessage(
                id: "assistant-\(index)",
                threadID: threadID,
                role: .assistant,
                text: "Chunk \(index)",
                turnID: visibleTurnID,
                orderIndex: index
            ))
        }

        let projected = service.snapshotProjectionSourceMessages(
            threadId: threadID,
            from: messages,
            usesPaginatedHistory: true
        )
        let projectedIDs = projected.map(\.id)

        XCTAssertGreaterThan(messages.count, TurnTimelineProjectionPolicy.initialMessageLimit)
        XCTAssertTrue(projectedIDs.contains("visible-prompt"))
        XCTAssertTrue(projectedIDs.contains("visible-plan"))
        XCTAssertTrue(projectedIDs.contains("visible-file-change"))
        XCTAssertTrue(projectedIDs.contains("older-plan"))
        XCTAssertEqual(projectedIDs.last, "assistant-94")
        XCTAssertEqual(projected.map(\.orderIndex), projected.map(\.orderIndex).sorted())
    }

    func testIdentifierlessLateCompletionDoesNotAttachPreviousResponseToNewTurn() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let firstTurnID = "turn-\(UUID().uuidString)"
        let secondTurnID = "turn-\(UUID().uuidString)"

        service.appendUserMessage(threadId: threadID, text: "First prompt", turnId: firstTurnID)
        service.appendAssistantDelta(
            threadId: threadID,
            turnId: firstTurnID,
            itemId: "item-1",
            delta: "Previous final"
        )
        service.flushPendingAssistantDeltas(for: threadID, turnId: firstTurnID)
        service.markTurnCompleted(threadId: threadID, turnId: firstTurnID)

        service.setActiveTurnID(secondTurnID, for: threadID)
        service.appendUserMessage(threadId: threadID, text: "Second prompt", turnId: secondTurnID)
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: nil,
            itemId: nil,
            text: "Previous final"
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages.first?.turnId, firstTurnID)
        XCTAssertEqual(assistantMessages.first?.text, "Previous final")
    }

    func testIdentifierlessLateCompletionDoesNotOverwriteActiveTurnResponse() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let firstTurnID = "turn-\(UUID().uuidString)"
        let secondTurnID = "turn-\(UUID().uuidString)"

        service.appendUserMessage(threadId: threadID, text: "First prompt", turnId: firstTurnID)
        service.appendAssistantDelta(
            threadId: threadID,
            turnId: firstTurnID,
            itemId: "item-1",
            delta: "Previous final"
        )
        service.flushPendingAssistantDeltas(for: threadID, turnId: firstTurnID)
        service.markTurnCompleted(threadId: threadID, turnId: firstTurnID)

        service.setActiveTurnID(secondTurnID, for: threadID)
        service.appendUserMessage(threadId: threadID, text: "Second prompt", turnId: secondTurnID)
        service.appendAssistantDelta(
            threadId: threadID,
            turnId: secondTurnID,
            itemId: nil,
            delta: "Current answer"
        )
        service.flushPendingAssistantDeltas(for: threadID, turnId: secondTurnID)

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: nil,
            itemId: nil,
            text: "Previous final\n\nOlder replay block"
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 2)
        XCTAssertEqual(assistantMessages.map(\.turnId), [firstTurnID, secondTurnID])
        XCTAssertEqual(assistantMessages.map(\.text), ["Previous final", "Current answer"])
        XCTAssertTrue(assistantMessages.last?.isStreaming ?? false)
    }

    func testNoItemCompletionReusesClosedAssistantRowWhileThreadStillLooksRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let finalText = "Final answer that was already persisted before mirror replay."

        service.appendMessage(
            CodexMessage(
                id: "assistant-existing",
                threadId: threadID,
                role: .assistant,
                text: finalText,
                turnId: turnID,
                isStreaming: false
            )
        )
        service.markThreadAsRunning(threadID)

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: finalText
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages.first?.id, "assistant-existing")
        XCTAssertEqual(assistantMessages.first?.text, finalText)
        XCTAssertFalse(assistantMessages.first?.isStreaming ?? true)
    }

    func testFullBlockCompletionReplayDoesNotAppendDuplicateAssistantRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let introText = "I'll check Gmail for the latest TestFlight message."
        let finalText = "Latest TestFlight version: 1.4 (123)."

        service.appendMessage(
            CodexMessage(
                id: "assistant-intro",
                threadId: threadID,
                role: .assistant,
                text: introText,
                turnId: turnID,
                itemId: "item-intro",
                isStreaming: false
            )
        )
        service.appendMessage(
            CodexMessage(
                id: "assistant-final",
                threadId: threadID,
                role: .assistant,
                text: finalText,
                turnId: turnID,
                itemId: "item-final",
                isStreaming: false
            )
        )

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "item-replay",
            text: "\(introText)\n\n\(finalText)"
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.map(\.id), ["assistant-intro", "assistant-final"])
        XCTAssertEqual(assistantMessages.map(\.text), [introText, finalText])
    }

    func testFullBlockCompletionReplayWithoutTurnIdUsesActiveTurnAndDoesNotAppendDuplicateRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let introText = "I'll check Gmail for the latest TestFlight message."
        let finalText = "Latest TestFlight version: 1.4 (123)."

        service.setActiveTurnID(turnID, for: threadID)
        service.appendMessage(
            CodexMessage(
                id: "assistant-intro",
                threadId: threadID,
                role: .assistant,
                text: introText,
                turnId: turnID,
                itemId: "item-intro",
                isStreaming: false
            )
        )
        service.appendMessage(
            CodexMessage(
                id: "assistant-final",
                threadId: threadID,
                role: .assistant,
                text: finalText,
                turnId: nil,
                itemId: "item-final",
                isStreaming: false
            )
        )

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: nil,
            itemId: "item-replay",
            text: "\(introText)\n\n\(finalText)"
        )

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.map(\.id), ["assistant-intro", "assistant-final"])
        XCTAssertEqual(assistantMessages.map(\.text), [introText, finalText])
    }

    func testLateDeltaForCompletedTurnDoesNotReopenAssistantBubble() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.appendAssistantDelta(
            threadId: threadID,
            turnId: turnID,
            itemId: "item-1",
            delta: "Final answer"
        )
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)
        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.markTurnCompleted(threadId: threadID, turnId: turnID)

        service.appendAssistantDelta(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            delta: " replay"
        )
        service.flushPendingAssistantDeltas(for: threadID, turnId: turnID)

        let assistantMessages = service.messages(for: threadID).filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages.first?.text, "Final answer replay")
        XCTAssertFalse(assistantMessages.first?.isStreaming ?? true)
    }

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

    func testClosedAssistantSnapshotWithOlderPrefixDoesNotReplaceFinalBlock() {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let finalText = "TLDR: risposta finale."
        let flattenedText = """
        Uso la skill check-code perché sto controllando la repo.

        TLDR: risposta finale.
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

    func testRunningHistorySnapshotWithoutItemDoesNotPolluteItemScopedAssistant() throws {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let currentText = "Si, sure-sure per i processi pesanti."
        let flattenedText = """
        Si, sure-sure per i processi pesanti.

        Controllo solo i processi attivi, senza lanciare build o test.

        Si, sure-sure per i processi pesanti.
        """
        let localMessage = CodexMessage(
            id: CodexService.stableAssistantMessageID(threadId: threadID, turnId: turnID, itemId: "message-current")!,
            threadId: threadID,
            role: .assistant,
            text: currentText,
            turnId: turnID,
            itemId: "message-current",
            isStreaming: true
        )
        let serverSnapshot = CodexMessage(
            threadId: threadID,
            role: .assistant,
            text: flattenedText,
            turnId: turnID,
            itemId: nil,
            isStreaming: false
        )

        let merged = try CodexService.mergeHistoryMessages(
            [localMessage],
            [serverSnapshot],
            activeThreadIDs: [threadID],
            runningThreadIDs: []
        )

        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].text, currentText)
        XCTAssertEqual(merged[0].itemId, "message-current")
        XCTAssertTrue(merged[0].isStreaming)
    }

    func testRunningHistorySnapshotWithRepeatedPrefixDoesNotDuplicateAssistantText() throws {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "message-current"
        let currentText = "Si, sure-sure per i processi pesanti."
        let flattenedText = """
        Si, sure-sure per i processi pesanti.

        Controllo solo i processi attivi, senza lanciare build o test.

        Si, sure-sure per i processi pesanti.
        """
        let localMessage = CodexMessage(
            id: CodexService.stableAssistantMessageID(threadId: threadID, turnId: turnID, itemId: itemID)!,
            threadId: threadID,
            role: .assistant,
            text: currentText,
            turnId: turnID,
            itemId: itemID,
            isStreaming: true
        )
        let serverSnapshot = CodexMessage(
            id: CodexService.stableAssistantMessageID(threadId: threadID, turnId: turnID, itemId: itemID)!,
            threadId: threadID,
            role: .assistant,
            text: flattenedText,
            turnId: turnID,
            itemId: itemID,
            isStreaming: false
        )

        let merged = try CodexService.mergeHistoryMessages(
            [localMessage],
            [serverSnapshot],
            activeThreadIDs: [threadID],
            runningThreadIDs: []
        )

        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].text, currentText)
        XCTAssertEqual(merged[0].itemId, itemID)
        XCTAssertTrue(merged[0].isStreaming)
    }

    func testRunningHistorySnapshotWithExtraOlderSuffixDoesNotExtendAssistantText() throws {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "message-current"
        let currentText = "Si, sure-sure per i processi pesanti."
        let flattenedText = """
        Si, sure-sure per i processi pesanti.

        Controllo solo i processi attivi, senza lanciare build o test.
        """
        let localMessage = CodexMessage(
            id: CodexService.stableAssistantMessageID(threadId: threadID, turnId: turnID, itemId: itemID)!,
            threadId: threadID,
            role: .assistant,
            text: currentText,
            turnId: turnID,
            itemId: itemID,
            isStreaming: true
        )
        let serverSnapshot = CodexMessage(
            id: CodexService.stableAssistantMessageID(threadId: threadID, turnId: turnID, itemId: itemID)!,
            threadId: threadID,
            role: .assistant,
            text: flattenedText,
            turnId: turnID,
            itemId: itemID,
            isStreaming: false
        )

        let merged = try CodexService.mergeHistoryMessages(
            [localMessage],
            [serverSnapshot],
            activeThreadIDs: [threadID],
            runningThreadIDs: []
        )

        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].text, currentText)
        XCTAssertEqual(merged[0].itemId, itemID)
        XCTAssertTrue(merged[0].isStreaming)
    }


    private func sendTurnCompletedSuccess(service: CodexService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "usage": .object([:]),
            ])
        )
    }

    private func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingStreamingTests.(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        Self.retainedServices.append(service)
        return service
    }

    private func makeTimelineMessage(
        id: String,
        threadID: String,
        role: CodexMessageRole,
        kind: CodexMessageKind = .chat,
        text: String,
        turnID: String,
        orderIndex: Int
    ) -> CodexMessage {
        CodexMessage(
            id: id,
            threadId: threadID,
            role: role,
            kind: kind,
            text: text,
            turnId: turnID,
            orderIndex: orderIndex
        )
    }
}
