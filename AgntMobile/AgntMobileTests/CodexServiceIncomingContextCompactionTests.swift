// FILE: CodexServiceIncomingContextCompactionTests.swift
// Purpose: Verifies context-compaction event and history decoding.
// Layer: Unit Test
// Exports: CodexServiceIncomingContextCompactionTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingContextCompactionTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testContextCompactionLifecycleTracksProgressAndCompletesSingleRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "compact-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("contextCompaction"),
                ]),
            ])
        )

        let startedRow = service.messages(for: threadID).first(where: {
            $0.role == .system && $0.kind == .commandExecution && $0.itemId == itemID
        })
        XCTAssertEqual(startedRow?.text, "Compacting context…")
        XCTAssertEqual(startedRow?.isStreaming, true)

        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("contextCompaction"),
                ]),
            ])
        )

        let rows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .commandExecution && $0.itemId == itemID
        }
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].text, "Context compacted")
        XCTAssertFalse(rows[0].isStreaming)
    }

    func testThreadReadRestoresContextCompactionAsCompletedCommandRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let history = service.decodeMessagesFromThreadRead(
            threadId: threadID,
            threadObject: [
                "createdAt": .string("2026-03-12T10:00:00Z"),
                "turns": .array([
                    .object([
                        "id": .string(turnID),
                        "items": .array([
                            .object([
                                "id": .string("compact-item"),
                                "type": .string("contextCompaction"),
                            ]),
                        ]),
                    ]),
                ]),
            ]
        )

        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history[0].kind, .commandExecution)
        XCTAssertEqual(history[0].text, "Context compacted")
        XCTAssertEqual(history[0].turnId, turnID)
    }

    private func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingContextCompactionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        Self.retainedServices.append(service)
        return service
    }
}
