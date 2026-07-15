// FILE: CodexServiceIncomingFileChangeTests.swift
// Purpose: Verifies live and history file-change reconciliation behavior.
// Layer: Unit Test
// Exports: CodexServiceIncomingFileChangeTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingFileChangeTests: CodexServiceIncomingFileChangeTestCase {
    func testLiveFileChangeReusesTurnlessRowWhenTurnIDArrives() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let fileChangeText = """
        Status: inProgress

        Path: Sources/App.swift
        Kind: update
        Totals: +2 -1
        """

        service.appendSystemMessage(
            threadId: threadID,
            text: fileChangeText,
            kind: .fileChange,
            isStreaming: true
        )
        service.upsertStreamingSystemItemMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "file-1",
            kind: .fileChange,
            text: fileChangeText,
            isStreaming: true
        )

        let fileRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .fileChange
        }
        XCTAssertEqual(fileRows.count, 1)
        XCTAssertEqual(fileRows[0].turnId, turnID)
        XCTAssertEqual(fileRows[0].itemId, "file-1")
    }

    func testLiveFileChangeSnapshotFallbackReusesTurnlessRowWithoutPathKeys() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let fileChangeText = """
        Status: completed

        Diff available in the changes sheet.
        """

        service.appendSystemMessage(
            threadId: threadID,
            text: fileChangeText,
            kind: .fileChange,
            isStreaming: true
        )
        service.upsertStreamingSystemItemMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "file-snapshot",
            kind: .fileChange,
            text: fileChangeText,
            isStreaming: false
        )

        let fileRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .fileChange
        }
        XCTAssertEqual(fileRows.count, 1)
        XCTAssertEqual(fileRows[0].turnId, turnID)
        XCTAssertEqual(fileRows[0].itemId, "file-snapshot")
    }

    func testTurnDiffUpdatedDoesNotCreateVisibleFileChangeRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let diff = """
        diff --git a/README.md b/README.md
        index 1111111..2222222 100644
        --- a/README.md
        +++ b/README.md
        @@ -1,1 +1,1 @@
        -old
        +new
        """

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: "Checked the repo."
        )
        service.handleNotification(
            method: "turn/diff/updated",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "diff": .string(diff),
            ])
        )

        let visibleFileRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .fileChange
        }
        XCTAssertTrue(visibleFileRows.isEmpty)

        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.noteTurnFinished(threadId: threadID, turnId: turnID)
        let assistantMessage = try? XCTUnwrap(service.messages(for: threadID).last(where: { $0.role == .assistant }))
        XCTAssertNil(assistantMessage.flatMap { service.readyChangeSet(forAssistantMessage: $0) })
    }

    func testTurnDiffUpdatedCanRecordUndoAfterRealFileChangeEvidence() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let diff = """
        diff --git a/README.md b/README.md
        index 1111111..2222222 100644
        --- a/README.md
        +++ b/README.md
        @@ -1,1 +1,1 @@
        -old
        +new
        """

        service.appendSystemMessage(
            threadId: threadID,
            text: """
            Status: completed

            Path: README.md
            Kind: update
            Totals: +1 -1
            """,
            turnId: turnID,
            kind: .fileChange
        )
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: "Updated README."
        )
        service.handleNotification(
            method: "turn/diff/updated",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "diff": .string(diff),
            ])
        )
        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.noteTurnFinished(threadId: threadID, turnId: turnID)

        let assistantMessage = try? XCTUnwrap(service.messages(for: threadID).last(where: { $0.role == .assistant }))
        let changeSet = assistantMessage.flatMap { service.readyChangeSet(forAssistantMessage: $0) }
        XCTAssertEqual(changeSet?.fileChanges.map(\.path), ["README.md"])
    }

    func testTurnDiffUpdatedIgnoresTurnlessFileChangeEvidence() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let diff = """
        diff --git a/README.md b/README.md
        index 1111111..2222222 100644
        --- a/README.md
        +++ b/README.md
        @@ -1,1 +1,1 @@
        -old
        +new
        """

        service.appendSystemMessage(
            threadId: threadID,
            text: """
            Status: completed

            Path: README.md
            Kind: update
            Totals: +1 -1
            """,
            kind: .fileChange
        )
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: "Checked README."
        )
        service.handleNotification(
            method: "turn/diff/updated",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "diff": .string(diff),
            ])
        )
        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.noteTurnFinished(threadId: threadID, turnId: turnID)

        let assistantMessage = try? XCTUnwrap(service.messages(for: threadID).last(where: { $0.role == .assistant }))
        XCTAssertNil(assistantMessage.flatMap { service.readyChangeSet(forAssistantMessage: $0) })
    }

    func testLiveFileChangeBootstrapFallbackDoesNotCrossUserBoundary() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let previousTurnID = "turn-\(UUID().uuidString)"
        let newTurnID = "turn-\(UUID().uuidString)"
        let fileChangeText = """
        Status: completed

        Path: Sources/App.swift
        Kind: update
        Totals: +2 -1
        """

        service.appendUserMessage(threadId: threadID, text: "first prompt", turnId: previousTurnID)
        service.appendSystemMessage(
            threadId: threadID,
            text: fileChangeText,
            kind: .fileChange,
            isStreaming: false
        )

        service.appendUserMessage(threadId: threadID, text: "nice")
        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(newTurnID),
            ])
        )
        service.upsertStreamingSystemItemMessage(
            threadId: threadID,
            turnId: newTurnID,
            itemId: "file-new-turn",
            kind: .fileChange,
            text: fileChangeText,
            isStreaming: false
        )

        let fileRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .fileChange
        }
        XCTAssertEqual(fileRows.count, 2)
        XCTAssertNil(fileRows[0].turnId)
        XCTAssertEqual(fileRows[1].turnId, newTurnID)
        XCTAssertEqual(fileRows[1].itemId, "file-new-turn")
    }

    func testLiveFileChangeAppendDoesNotStealNextTurnsTurnlessTable() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let oldTurnID = "turn-\(UUID().uuidString)"
        let newTurnID = "turn-\(UUID().uuidString)"
        let now = Date(timeIntervalSince1970: 1_779_654_720)
        let fileChangeText = """
        Status: completed

        Path: package.json
        Kind: update
        Totals: +1 -1
        """

        service.messagesByThread[threadID] = [
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
                text: fileChangeText,
                createdAt: now.addingTimeInterval(12),
                turnId: nil,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        service.appendSystemMessage(
            threadId: threadID,
            text: fileChangeText,
            turnId: oldTurnID,
            itemId: "file-old",
            kind: .fileChange,
            isStreaming: false
        )

        let fileRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .fileChange
        }
        XCTAssertEqual(fileRows.count, 2)
        XCTAssertNil(service.messages(for: threadID).first(where: { $0.id == "new-turn-table" })?.turnId)
        XCTAssertTrue(fileRows.contains { $0.turnId == oldTurnID && $0.itemId == "file-old" })
    }

}
