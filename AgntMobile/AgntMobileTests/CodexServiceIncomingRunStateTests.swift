// FILE: CodexServiceIncomingRunStateTests.swift
// Purpose: Verifies running/terminal state transitions from app-server events.
// Layer: Unit Test
// Exports: CodexServiceIncomingRunStateTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingRunStateTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testTurnStartedMarksThreadAsRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
    }

    func testTodoListItemLifecycleRendersAsPlanRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "todo-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("todoList"),
                    "text": .string("1. Audit flow\n2. Ship fix"),
                ]),
            ])
        )

        let planRows = service.messages(for: threadID).filter { $0.kind == .plan }
        XCTAssertEqual(planRows.count, 1)
        XCTAssertEqual(planRows.first?.text, "1. Audit flow\n2. Ship fix")
    }

    func testIncomingMethodIsTrimmedBeforeRouting() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleIncomingRPCMessage(
            RPCMessage(
                method: " turn/started ",
                params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(turnID),
                ])
            )
        )

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
        XCTAssertEqual(service.activeTurnID(for: threadID), turnID)
    }

    func testTurnStartedSupportsConversationIDSnakeCase() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "conversation_id": .string(threadID),
                "turnId": .string(turnID),
            ])
        )

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
        XCTAssertEqual(service.activeTurnID(for: threadID), turnID)
    }

    func testTurnStartedWithoutTurnIDStillMarksThreadAsRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
            ])
        )

        XCTAssertNil(service.activeTurnID(for: threadID))
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
    }

    func testTurnStartedAcceptsTopLevelIDAsTurnID() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "id": .string(turnID),
            ])
        )

        XCTAssertEqual(service.activeTurnID(for: threadID), turnID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
    }

    func testTurnCompletedAcceptsTopLevelIDAsTurnID() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)

        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "id": .string(turnID),
            ])
        )

        XCTAssertNil(service.activeTurnID(for: threadID))
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .ready)
    }

    func testThreadStatusChangedActiveMarksRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.handleNotification(
            method: "thread/status/changed",
            params: .object([
                "threadId": .string(threadID),
                "status": .object([
                    "type": .string("active"),
                ]),
            ])
        )

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
    }

    func testThreadStatusChangedIdleStopsRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        service.handleNotification(
            method: "thread/status/changed",
            params: .object([
                "threadId": .string(threadID),
                "status": .object([
                    "type": .string("active"),
                ]),
            ])
        )

        service.handleNotification(
            method: "thread/status/changed",
            params: .object([
                "threadId": .string(threadID),
                "status": .object([
                    "type": .string("idle"),
                ]),
            ])
        )

        XCTAssertNil(service.threadRunBadgeState(for: threadID))
    }

    func testThreadStatusChangedIdleDoesNotClearWhileTurnIsStillActive() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)

        service.handleNotification(
            method: "thread/status/changed",
            params: .object([
                "threadId": .string(threadID),
                "status": .object([
                    "type": .string("idle"),
                ]),
            ])
        )

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
        XCTAssertEqual(service.activeTurnID(for: threadID), turnID)
    }

    func testThreadStatusChangedIdleDoesNotClearWhileProtectedRunningFallbackIsStillActive() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.runningThreadIDs.insert(threadID)
        service.protectedRunningFallbackThreadIDs.insert(threadID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)

        service.handleNotification(
            method: "thread/status/changed",
            params: .object([
                "threadId": .string(threadID),
                "status": .object([
                    "type": .string("idle"),
                ]),
            ])
        )

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
        XCTAssertNil(service.latestTurnTerminalState(for: threadID))
    }

    func testProtectedRunningFallbackAloneStillKeepsTimelineRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.protectedRunningFallbackThreadIDs.insert(threadID)
        service.refreshThreadTimelineState(for: threadID)

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
        XCTAssertTrue(service.timelineState(for: threadID).renderSnapshot.isThreadRunning)
    }

    func testStreamingFallbackMarksRunningWithoutActiveTurnMapping() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.appendSystemMessage(
            threadId: threadID,
            text: "Thinking...",
            kind: .thinking,
            isStreaming: true
        )

        XCTAssertNil(service.activeTurnID(for: threadID))
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
    }

    func testSuccessfulCompletionMarksThreadAsReadyWhenUnread() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: turnID)

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .ready)
    }

    func testStoppedCompletionRecordsStoppedTerminalStateWithoutReadyBadge() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        sendTurnCompletedStopped(service: service, threadID: threadID, turnID: turnID)

        XCTAssertNil(service.threadRunBadgeState(for: threadID))
        XCTAssertEqual(service.latestTurnTerminalState(for: threadID), .stopped)
        XCTAssertEqual(service.turnTerminalState(for: turnID), .stopped)
    }

    func testStoppedCompletionUpdatesThreadStoppedTurnCache() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        sendTurnCompletedStopped(service: service, threadID: threadID, turnID: turnID)

        XCTAssertEqual(service.stoppedTurnIDs(for: threadID), Set([turnID]))
        XCTAssertEqual(service.timelineState(for: threadID).renderSnapshot.stoppedTurnIDs, Set([turnID]))
    }

    func testProjectedDesktopTurnTerminalStateIsThreadScoped() {
        let service = makeService()
        let firstThreadID = "thread-\(UUID().uuidString)"
        let secondThreadID = "thread-\(UUID().uuidString)"
        let projectedTurnID = "ipc-turn-1"

        service.appendMessage(
            CodexMessage(
                threadId: firstThreadID,
                role: .assistant,
                text: "First projected reply",
                turnId: projectedTurnID,
                isStreaming: false
            )
        )
        service.appendMessage(
            CodexMessage(
                threadId: secondThreadID,
                role: .assistant,
                text: "Second projected reply",
                turnId: projectedTurnID,
                isStreaming: false
            )
        )
        service.recordTurnTerminalState(threadId: firstThreadID, turnId: projectedTurnID, state: .completed)
        service.recordTurnTerminalState(threadId: secondThreadID, turnId: projectedTurnID, state: .stopped)

        XCTAssertNil(service.turnTerminalState(for: projectedTurnID))
        XCTAssertEqual(service.turnTerminalState(for: projectedTurnID, threadId: firstThreadID), .completed)
        XCTAssertEqual(service.turnTerminalState(for: projectedTurnID, threadId: secondThreadID), .stopped)
        XCTAssertTrue(service.timelineState(for: firstThreadID).renderSnapshot.completedTurnIDs.contains(projectedTurnID))
        XCTAssertEqual(service.timelineState(for: secondThreadID).renderSnapshot.stoppedTurnIDs, Set([projectedTurnID]))
    }

    func testProjectedDesktopTurnTerminalStateFromHistoryDoesNotPersistGlobally() {
        let suiteName = "CodexServiceIncomingRunStateTests.projected.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let firstService = CodexService(defaults: defaults)
        let threadID = "thread-\(UUID().uuidString)"
        let projectedTurnID = "ipc-turn-1"

        firstService.mergeHistoryTurnTerminalStates(
            threadId: threadID,
            terminalStatesByTurnID: [projectedTurnID: .completed]
        )

        let reloadedService = CodexService(defaults: defaults)
        Self.retainedServices.append(firstService)
        Self.retainedServices.append(reloadedService)

        XCTAssertEqual(firstService.turnTerminalState(for: projectedTurnID, threadId: threadID), .completed)
        XCTAssertNil(firstService.turnTerminalState(for: projectedTurnID))
        XCTAssertNil(reloadedService.turnTerminalState(for: projectedTurnID))
        XCTAssertNil(reloadedService.turnTerminalState(for: projectedTurnID, threadId: threadID))
    }

    private func sendTurnStarted(service: CodexService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
    }

    private func sendTurnCompletedSuccess(service: CodexService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
    }

    private func sendTurnCompletedStopped(service: CodexService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turn": .object([
                    "id": .string(turnID),
                    "status": .string("interrupted"),
                ]),
            ])
        )
    }

    private func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingRunStateTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        Self.retainedServices.append(service)
        return service
    }
}
