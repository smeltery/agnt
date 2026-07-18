// FILE: CodexServiceIncomingRunIndicatorTests.swift
// Purpose: Verifies runtime debug and streaming coalescing from app-server events.
// Layer: Unit Test
// Exports: CodexServiceIncomingRunIndicatorTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingRunIndicatorTests: CodexServiceRunIndicatorTestCase {
    func testRuntimeItemCompletionDebugLogCoalescesBursts() {
        let service = makeService()

        service.recordCompactRuntimeItemCompletion(itemType: "agent_message")
        service.recordCompactRuntimeItemCompletion(itemType: "tool_call")
        service.recordCompactRuntimeItemCompletion(itemType: "agent_message")

        XCTAssertTrue(service.runtimeDebugLogEntries.isEmpty)

        service.flushCompactRuntimeItemCompletions()

        XCTAssertEqual(service.runtimeDebugLogEntries.count, 1)
        XCTAssertTrue(service.runtimeDebugLogEntries[0].contains("rpc item/completed x3"))
        XCTAssertTrue(service.runtimeDebugLogEntries[0].contains("agent_message:2"))
        XCTAssertTrue(service.runtimeDebugLogEntries[0].contains("tool_call:1"))
    }

    func testRuntimeDebugLogClearDropsPendingItemCompletionBatch() {
        let service = makeService()

        service.recordCompactRuntimeItemCompletion(itemType: "agent_message")
        service.clearRuntimeDebugLog()
        service.flushCompactRuntimeItemCompletions()

        XCTAssertTrue(service.runtimeDebugLogEntries.isEmpty)
    }

    func testAssistantDeltaCoalescingAppliesOrderedDeltasOnFlush() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"

        service.enqueueAssistantDelta(threadId: threadID, turnId: turnID, itemId: itemID, delta: "Hello")
        service.enqueueAssistantDelta(threadId: threadID, turnId: turnID, itemId: itemID, delta: " world")

        XCTAssertTrue(service.messages(for: threadID).isEmpty)

        service.flushAllPendingStreamingDeltas()

        let messages = service.messages(for: threadID)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.role, .assistant)
        XCTAssertEqual(messages.first?.text, "Hello world")
        XCTAssertTrue(messages.first?.isStreaming == true)
    }

    func testAssistantDeltaCoalescingMergesCumulativeSnapshotsBeforeFlush() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"

        service.enqueueAssistantDelta(threadId: threadID, turnId: turnID, itemId: itemID, delta: "Yes")
        service.enqueueAssistantDelta(threadId: threadID, turnId: turnID, itemId: itemID, delta: "Yes, the")
        service.enqueueAssistantDelta(threadId: threadID, turnId: turnID, itemId: itemID, delta: "Yes, the imagegen skill")

        service.flushAllPendingStreamingDeltas()

        let messages = service.messages(for: threadID)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.text, "Yes, the imagegen skill")
        XCTAssertTrue(messages.first?.isStreaming == true)
    }

    func testSystemDeltaCoalescingAppliesThinkingDeltasOnFlush() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "thinking-\(UUID().uuidString)"

        service.appendStreamingSystemItemDelta(
            threadId: threadID,
            turnId: turnID,
            itemId: itemID,
            kind: .thinking,
            delta: "Looking"
        )
        service.appendStreamingSystemItemDelta(
            threadId: threadID,
            turnId: turnID,
            itemId: itemID,
            kind: .thinking,
            delta: " around"
        )

        XCTAssertTrue(service.messages(for: threadID).isEmpty)

        service.flushAllPendingStreamingDeltas()

        let messages = service.messages(for: threadID)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.role, .system)
        XCTAssertEqual(messages.first?.kind, .thinking)
        XCTAssertEqual(messages.first?.text, "Looking around")
        XCTAssertTrue(messages.first?.isStreaming == true)
    }

    func testNilTurnSystemDeltasFlushBeforeTurnCompletionClosesRows() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let itemID = "thinking-\(UUID().uuidString)"

        service.appendStreamingSystemItemDelta(
            threadId: threadID,
            turnId: nil,
            itemId: itemID,
            kind: .thinking,
            delta: "Recovering"
        )

        XCTAssertTrue(service.messages(for: threadID).isEmpty)

        service.markTurnCompleted(threadId: threadID, turnId: nil)

        let messages = service.messages(for: threadID)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.kind, .thinking)
        XCTAssertEqual(messages.first?.text, "Recovering")
        XCTAssertFalse(messages.first?.isStreaming ?? true)
        XCTAssertTrue(service.pendingSystemDeltasByKey.isEmpty)
    }

    func testTimelineStateTracksLatestRepoRefreshSignal() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.appendSystemMessage(
            threadId: threadID,
            text: "Status: completed\n\nPath: Sources/App.swift\nKind: update\nTotals: +1 -0",
            kind: .fileChange
        )

        let state = service.timelineState(for: threadID)

        XCTAssertNotNil(state.repoRefreshSignal)
        XCTAssertEqual(state.repoRefreshSignal, state.renderSnapshot.repoRefreshSignal)
    }
}
