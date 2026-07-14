// FILE: CodexServiceIncomingStreamingTests.swift
// Purpose: Verifies assistant streaming and replay deduplication behavior from incoming events.
// Layer: Unit Test
// Exports: CodexServiceIncomingStreamingTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingStreamingTests: CodexServiceIncomingStreamingTestCase {
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
}
