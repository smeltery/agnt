// FILE: AIChangeSetTests.swift
// Purpose: Verifies patch parsing and turn-scoped AI change-set finalization.
// Layer: Unit Test
// Exports: AIChangeSetTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class AIChangeSetTests: AIChangeSetTestCase {
    func testUnifiedPatchParserExtractsSingleFileUpdate() {
        let patch = """
        diff --git a/Sources/App.swift b/Sources/App.swift
        index 1111111..2222222 100644
        --- a/Sources/App.swift
        +++ b/Sources/App.swift
        @@ -1,2 +1,3 @@
         struct App {}
        +let enabled = true
        -let disabled = false
        """

        let analysis = AIUnifiedPatchParser.analyze(patch)

        XCTAssertEqual(analysis.fileChanges.count, 1)
        XCTAssertEqual(analysis.fileChanges.first?.path, "Sources/App.swift")
        XCTAssertEqual(analysis.fileChanges.first?.kind, .update)
        XCTAssertEqual(analysis.fileChanges.first?.additions, 1)
        XCTAssertEqual(analysis.fileChanges.first?.deletions, 1)
        XCTAssertTrue(analysis.unsupportedReasons.isEmpty)
    }

    func testUnifiedPatchParserMarksRenameAsUnsupported() {
        let patch = """
        diff --git a/Old.swift b/New.swift
        similarity index 100%
        rename from Old.swift
        rename to New.swift
        """

        let analysis = AIUnifiedPatchParser.analyze(patch)

        XCTAssertTrue(analysis.fileChanges.isEmpty)
        XCTAssertTrue(
            analysis.unsupportedReasons.contains("Rename, mode-only, or symlink changes are not auto-revertable in v1.")
        )
    }

    func testTurnDiffFinalizesReadyChangeSetForAssistantMessage() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.threads = [
            CodexThread(id: threadID, title: "Revert", cwd: "/tmp/repo")
        ]

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: "Implemented the change."
        )
        service.recordTurnDiffChangeSet(
            threadId: threadID,
            turnId: turnID,
            diff: """
            diff --git a/Sources/App.swift b/Sources/App.swift
            index 1111111..2222222 100644
            --- a/Sources/App.swift
            +++ b/Sources/App.swift
            @@ -1 +1,2 @@
             struct App {}
            +let enabled = true
            """
        )
        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.noteTurnFinished(threadId: threadID, turnId: turnID)

        let assistantMessage = try XCTUnwrap(service.messages(for: threadID).last(where: { $0.role == .assistant }))
        let changeSet = try XCTUnwrap(service.readyChangeSet(forAssistantMessage: assistantMessage))

        XCTAssertEqual(changeSet.threadId, threadID)
        XCTAssertEqual(changeSet.turnId, turnID)
        XCTAssertEqual(changeSet.assistantMessageId, assistantMessage.id)
        XCTAssertEqual(changeSet.status, .ready)
        XCTAssertEqual(changeSet.repoRoot, "/tmp/repo")
    }

    func testProjectedTurnChangeSetsStaySeparateAcrossThreads() throws {
        let service = makeService()
        let firstThreadID = "thread-first"
        let secondThreadID = "thread-second"
        let projectedTurnID = "ipc-turn-0"
        service.threads = [
            CodexThread(id: firstThreadID, title: "First", cwd: "/tmp/first-repo"),
            CodexThread(id: secondThreadID, title: "Second", cwd: "/tmp/second-repo"),
        ]

        service.completeAssistantMessage(
            threadId: firstThreadID,
            turnId: projectedTurnID,
            itemId: nil,
            text: "Changed the first repository."
        )
        service.recordTurnDiffChangeSet(
            threadId: firstThreadID,
            turnId: projectedTurnID,
            diff: """
            diff --git a/Sources/First.swift b/Sources/First.swift
            index 1111111..2222222 100644
            --- a/Sources/First.swift
            +++ b/Sources/First.swift
            @@ -1 +1,2 @@
             struct First {}
            +let firstOnly = true
            """
        )

        service.completeAssistantMessage(
            threadId: secondThreadID,
            turnId: projectedTurnID,
            itemId: nil,
            text: "Changed the second repository."
        )
        service.recordTurnDiffChangeSet(
            threadId: secondThreadID,
            turnId: projectedTurnID,
            diff: """
            diff --git a/Sources/Second.swift b/Sources/Second.swift
            index 3333333..4444444 100644
            --- a/Sources/Second.swift
            +++ b/Sources/Second.swift
            @@ -1 +1,2 @@
             struct Second {}
            +let secondOnly = true
            """
        )

        service.recordTurnTerminalState(threadId: firstThreadID, turnId: projectedTurnID, state: .completed)
        service.noteTurnFinished(threadId: firstThreadID, turnId: projectedTurnID)
        service.recordTurnTerminalState(threadId: secondThreadID, turnId: projectedTurnID, state: .completed)
        service.noteTurnFinished(threadId: secondThreadID, turnId: projectedTurnID)

        let firstAssistant = try XCTUnwrap(
            service.messages(for: firstThreadID).last(where: { $0.role == .assistant })
        )
        let secondAssistant = try XCTUnwrap(
            service.messages(for: secondThreadID).last(where: { $0.role == .assistant })
        )
        service.aiChangeSetIDByAssistantMessageID.removeAll()
        let firstChangeSet = try XCTUnwrap(service.readyChangeSet(forAssistantMessage: firstAssistant))
        let secondChangeSet = try XCTUnwrap(service.readyChangeSet(forAssistantMessage: secondAssistant))

        XCTAssertNotEqual(firstChangeSet.id, secondChangeSet.id)
        XCTAssertEqual(firstChangeSet.threadId, firstThreadID)
        XCTAssertEqual(secondChangeSet.threadId, secondThreadID)
        XCTAssertEqual(firstChangeSet.repoRoot, "/tmp/first-repo")
        XCTAssertEqual(secondChangeSet.repoRoot, "/tmp/second-repo")
        XCTAssertTrue(firstChangeSet.forwardUnifiedPatch.contains("firstOnly"))
        XCTAssertFalse(firstChangeSet.forwardUnifiedPatch.contains("secondOnly"))
        XCTAssertTrue(secondChangeSet.forwardUnifiedPatch.contains("secondOnly"))
        XCTAssertFalse(secondChangeSet.forwardUnifiedPatch.contains("firstOnly"))
        XCTAssertEqual(service.aiChangeSetIDByTurnKey.count, 2)
    }
}
