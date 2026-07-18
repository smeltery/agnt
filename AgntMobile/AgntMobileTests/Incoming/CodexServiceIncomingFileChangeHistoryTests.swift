// FILE: CodexServiceIncomingFileChangeHistoryTests.swift
// Purpose: Verifies history file-change reconciliation behavior.
// Layer: Unit Test
// Exports: CodexServiceIncomingFileChangeHistoryTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingFileChangeHistoryTests: CodexServiceIncomingFileChangeTestCase {
    func testHistoryFileChangeReconcilesTurnlessLocalRowWhenTurnIDArrives() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()
        let fileChangeText = """
        Status: completed

        Path: Sources/App.swift
        Kind: update
        Totals: +2 -1
        """

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .fileChange,
                text: fileChangeText,
                createdAt: now,
                turnId: nil,
                itemId: nil,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .fileChange,
                text: fileChangeText,
                createdAt: now.addingTimeInterval(0.2),
                turnId: turnID,
                itemId: "file-1",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let fileRows = merged.filter { $0.role == .system && $0.kind == .fileChange }

        XCTAssertEqual(fileRows.count, 1)
        XCTAssertEqual(fileRows[0].turnId, turnID)
        XCTAssertEqual(fileRows[0].itemId, "file-1")
    }

    func testHistoryFileChangeDoesNotStealPreviousTurnsTurnlessTable() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let newTurnID = "turn-\(UUID().uuidString)"
        let now = Date(timeIntervalSince1970: 1_779_654_720)
        let existing = [
            CodexMessage(
                id: "old-table",
                threadId: threadID,
                role: .system,
                kind: .fileChange,
                text: "package.json +1 -1",
                createdAt: now,
                turnId: nil,
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                id: "user-new-turn",
                threadId: threadID,
                role: .user,
                text: "nice",
                createdAt: now.addingTimeInterval(10),
                turnId: newTurnID,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                id: "new-turn-snapshot",
                threadId: threadID,
                role: .system,
                kind: .fileChange,
                text: "package.json +1 -1",
                createdAt: now.addingTimeInterval(12),
                turnId: newTurnID,
                itemId: "fc-new",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let fileChangeRows = merged.filter { $0.kind == .fileChange }

        XCTAssertEqual(fileChangeRows.count, 2)
        XCTAssertNil(merged.first(where: { $0.id == "old-table" })?.turnId)
    }

    func testHistoryFileChangeDoesNotStealNextTurnsTurnlessTable() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let oldTurnID = "turn-\(UUID().uuidString)"
        let newTurnID = "turn-\(UUID().uuidString)"
        let now = Date(timeIntervalSince1970: 1_779_654_720)
        let existing = [
            CodexMessage(
                id: "user-old-turn",
                threadId: threadID,
                role: .user,
                text: "first change",
                createdAt: now,
                turnId: oldTurnID,
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                id: "user-new-turn",
                threadId: threadID,
                role: .user,
                text: "second change",
                createdAt: now.addingTimeInterval(10),
                turnId: newTurnID,
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                id: "new-turn-table",
                threadId: threadID,
                role: .system,
                kind: .fileChange,
                text: "package.json +1 -1",
                createdAt: now.addingTimeInterval(12),
                turnId: nil,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                id: "old-turn-snapshot",
                threadId: threadID,
                role: .system,
                kind: .fileChange,
                text: "package.json +1 -1",
                createdAt: now.addingTimeInterval(2),
                turnId: oldTurnID,
                itemId: "fc-old",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let fileChangeRows = merged.filter { $0.kind == .fileChange }

        XCTAssertEqual(fileChangeRows.count, 2)
        XCTAssertNil(merged.first(where: { $0.id == "new-turn-table" })?.turnId)
        XCTAssertNotNil(merged.first(where: { $0.id == "old-turn-snapshot" }))
    }

    func testHistoryFileChangeStillBindsSameTurnTurnlessSnapshot() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date(timeIntervalSince1970: 1_779_654_720)
        let existing = [
            CodexMessage(
                id: "user-turn",
                threadId: threadID,
                role: .user,
                text: "bump the version",
                createdAt: now,
                turnId: turnID,
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                id: "turnless-snapshot",
                threadId: threadID,
                role: .system,
                kind: .fileChange,
                text: "package.json +1 -1",
                createdAt: now.addingTimeInterval(5),
                turnId: nil,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                id: "turn-snapshot",
                threadId: threadID,
                role: .system,
                kind: .fileChange,
                text: "package.json +1 -1",
                createdAt: now.addingTimeInterval(6),
                turnId: turnID,
                itemId: "fc-turn",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let fileChangeRows = merged.filter { $0.kind == .fileChange }

        XCTAssertEqual(fileChangeRows.count, 1)
        XCTAssertEqual(fileChangeRows[0].id, "turnless-snapshot")
        XCTAssertEqual(fileChangeRows[0].turnId, turnID)
    }
}
