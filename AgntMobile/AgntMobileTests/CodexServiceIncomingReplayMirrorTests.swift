// FILE: CodexServiceIncomingReplayMirrorTests.swift
// Purpose: Verifies replayed and desktop-mirrored incoming event handling.
// Layer: Unit Test
// Exports: CodexServiceIncomingReplayMirrorTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingReplayMirrorTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testReplayedTurnStartedDoesNotReviveRunningState() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "agntReplayedEvent": .bool(true),
            ])
        )

        XCTAssertNil(service.activeTurnID(for: threadID))
        XCTAssertNil(service.threadRunBadgeState(for: threadID))
        XCTAssertEqual(service.threadIdByTurnID[turnID], threadID)
    }

    func testReplayedAssistantDeltaAppendsNonStreamingHistory() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/agentMessage/delta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string("Historical reply"),
                "agntReplayedEvent": .bool(true),
            ])
        )
        service.flushAllPendingStreamingDeltas()

        let messages = service.messages(for: threadID)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.text, "Historical reply")
        XCTAssertFalse(messages.first?.isStreaming ?? true)
        XCTAssertNil(service.threadRunBadgeState(for: threadID))
        XCTAssertNil(service.activeTurnID(for: threadID))
    }

    func testReplayedActiveThreadStatusDoesNotMarkRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.handleNotification(
            method: "thread/status/changed",
            params: .object([
                "threadId": .string(threadID),
                "status": .object(["type": .string("active")]),
                "agntReplayedEvent": .bool(true),
            ])
        )

        XCTAssertNil(service.threadRunBadgeState(for: threadID))
    }

    func testDesktopMirroredUserMessageItemStartedAppendsImmediately() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "agntDesktopMirror": .bool(true),
                "item": .object([
                    "id": .string("\(turnID):input"),
                    "type": .string("userMessage"),
                    "content": .array([
                        .object([
                            "type": .string("text"),
                            "text": .string("Show the failing test"),
                        ]),
                    ]),
                ]),
            ])
        )

        let messages = service.messages(for: threadID)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.role, .user)
        XCTAssertEqual(messages.first?.text, "Show the failing test")
        XCTAssertEqual(messages.first?.turnId, turnID)
        XCTAssertEqual(messages.first?.deliveryState, .confirmed)
    }

    func testDesktopMirroredUserMessageItemCompletedDedupsStartedRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let params: JSONValue = .object([
            "threadId": .string(threadID),
            "turnId": .string(turnID),
            "agntDesktopMirror": .bool(true),
            "item": .object([
                "id": .string("\(turnID):input"),
                "type": .string("userMessage"),
                "content": .array([
                    .object([
                        "type": .string("text"),
                        "text": .string("Fix the login bug"),
                    ]),
                ]),
            ]),
        ])

        service.handleNotification(method: "item/started", params: params)
        service.handleNotification(method: "item/completed", params: params)

        let userRows = service.messages(for: threadID).filter { $0.role == .user }
        XCTAssertEqual(userRows.count, 1)
        XCTAssertEqual(userRows.first?.text, "Fix the login bug")
        XCTAssertEqual(userRows.first?.deliveryState, .confirmed)
    }

    func testDesktopMirroredUserMessageItemCompletedAppendsWithoutStartedEvent() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "agntDesktopMirror": .bool(true),
                "item": .object([
                    "id": .string("\(turnID):input"),
                    "type": .string("userMessage"),
                    "content": .array([
                        .object([
                            "type": .string("text"),
                            "text": .string("Summarize the thread"),
                        ]),
                    ]),
                ]),
            ])
        )

        let userRows = service.messages(for: threadID).filter { $0.role == .user }
        XCTAssertEqual(userRows.count, 1)
        XCTAssertEqual(userRows.first?.text, "Summarize the thread")
        XCTAssertEqual(userRows.first?.turnId, turnID)
        XCTAssertEqual(userRows.first?.deliveryState, .confirmed)
    }

    private func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingReplayMirrorTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        Self.retainedServices.append(service)
        return service
    }
}
