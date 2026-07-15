// FILE: AIChangeSetCheckpointTests.swift
// Purpose: Verifies checkpoint precedence and fallback patch batches.
// Layer: Unit Test
// Exports: AIChangeSetCheckpointTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class AIChangeSetCheckpointTests: AIChangeSetTestCase {
    func testWorkspaceCheckpointDoesNotReplaceTurnDiffWhenFileScopeMatches() throws {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

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
            diff --git a/Sources/Runtime.swift b/Sources/Runtime.swift
            index 1111111..2222222 100644
            --- a/Sources/Runtime.swift
            +++ b/Sources/Runtime.swift
            @@ -1 +1,2 @@
             struct Runtime {}
            +let fromRuntime = true
            """
        )
        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.noteTurnFinished(threadId: threadID, turnId: turnID)
        service.recordWorkspaceCheckpointChangeSet(
            threadId: threadID,
            turnId: turnID,
            diff: """
            diff --git a/Sources/Runtime.swift b/Sources/Runtime.swift
            index 3333333..4444444 100644
            --- a/Sources/Runtime.swift
            +++ b/Sources/Runtime.swift
            @@ -1 +1,2 @@
             struct Runtime {}
            +let fromCheckpoint = true
            """
        )

        let assistantMessage = try XCTUnwrap(service.messages(for: threadID).last(where: { $0.role == .assistant }))
        let changeSet = try XCTUnwrap(service.readyChangeSet(forAssistantMessage: assistantMessage))

        XCTAssertEqual(changeSet.source, .turnDiff)
        XCTAssertEqual(changeSet.fileChanges.map(\.path), ["Sources/Runtime.swift"])
        XCTAssertTrue(changeSet.forwardUnifiedPatch.contains("fromRuntime"))
        XCTAssertFalse(changeSet.forwardUnifiedPatch.contains("fromCheckpoint"))
    }

    func testWorkspaceCheckpointDoesNotReplaceTurnDiffWhenFileScopeWidens() throws {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

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
            diff --git a/Sources/A.swift b/Sources/A.swift
            index 1111111..2222222 100644
            --- a/Sources/A.swift
            +++ b/Sources/A.swift
            @@ -1 +1,2 @@
             struct A {}
            +let fromRuntime = true
            """
        )
        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.noteTurnFinished(threadId: threadID, turnId: turnID)
        service.recordWorkspaceCheckpointChangeSet(
            threadId: threadID,
            turnId: turnID,
            diff: """
            diff --git a/Sources/A.swift b/Sources/A.swift
            index 1111111..2222222 100644
            --- a/Sources/A.swift
            +++ b/Sources/A.swift
            @@ -1 +1,2 @@
             struct A {}
            +let fromRuntime = true
            diff --git a/Sources/B.swift b/Sources/B.swift
            index 3333333..4444444 100644
            --- a/Sources/B.swift
            +++ b/Sources/B.swift
            @@ -1 +1,2 @@
             struct B {}
            +let userOrBridgeChange = true
            """
        )

        let assistantMessage = try XCTUnwrap(service.messages(for: threadID).last(where: { $0.role == .assistant }))
        let changeSet = try XCTUnwrap(service.readyChangeSet(forAssistantMessage: assistantMessage))

        XCTAssertEqual(changeSet.source, .turnDiff)
        XCTAssertEqual(changeSet.fileChanges.map(\.path), ["Sources/A.swift"])
        XCTAssertFalse(changeSet.forwardUnifiedPatch.contains("Sources/B.swift"))
    }

    func testTurnDiffReplacesWorkspaceCheckpointWhenItArrivesLater() throws {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: "Implemented the change."
        )
        service.recordWorkspaceCheckpointChangeSet(
            threadId: threadID,
            turnId: turnID,
            diff: """
            diff --git a/Sources/A.swift b/Sources/A.swift
            index 1111111..2222222 100644
            --- a/Sources/A.swift
            +++ b/Sources/A.swift
            @@ -1 +1,2 @@
             struct A {}
            +let checkpointChange = true
            diff --git a/Sources/B.swift b/Sources/B.swift
            index 3333333..4444444 100644
            --- a/Sources/B.swift
            +++ b/Sources/B.swift
            @@ -1 +1,2 @@
             struct B {}
            +let userOrBridgeChange = true
            """
        )
        service.recordTurnDiffChangeSet(
            threadId: threadID,
            turnId: turnID,
            diff: """
            diff --git a/Sources/A.swift b/Sources/A.swift
            index 1111111..2222222 100644
            --- a/Sources/A.swift
            +++ b/Sources/A.swift
            @@ -1 +1,2 @@
             struct A {}
            +let runtimeChange = true
            """
        )
        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.noteTurnFinished(threadId: threadID, turnId: turnID)

        let assistantMessage = try XCTUnwrap(service.messages(for: threadID).last(where: { $0.role == .assistant }))
        let changeSet = try XCTUnwrap(service.readyChangeSet(forAssistantMessage: assistantMessage))

        XCTAssertEqual(changeSet.source, .turnDiff)
        XCTAssertEqual(changeSet.fileChanges.map(\.path), ["Sources/A.swift"])
        XCTAssertTrue(changeSet.forwardUnifiedPatch.contains("runtimeChange"))
        XCTAssertFalse(changeSet.forwardUnifiedPatch.contains("Sources/B.swift"))
    }

    func testMultipleFallbackPatchesStayRevertableAsOrderedBatches() throws {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: "Made several edits."
        )
        service.recordFallbackFileChangePatch(
            threadId: threadID,
            turnId: turnID,
            patch: """
            diff --git a/Sources/A.swift b/Sources/A.swift
            index 1111111..2222222 100644
            --- a/Sources/A.swift
            +++ b/Sources/A.swift
            @@ -1 +1,2 @@
             let a = 1
            +let b = 2
            """
        )
        service.recordFallbackFileChangePatch(
            threadId: threadID,
            turnId: turnID,
            patch: """
            diff --git a/Sources/B.swift b/Sources/B.swift
            index 3333333..4444444 100644
            --- a/Sources/B.swift
            +++ b/Sources/B.swift
            @@ -1 +1,2 @@
             let c = 3
            +let d = 4
            """
        )
        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.noteTurnFinished(threadId: threadID, turnId: turnID)

        let assistantMessage = try XCTUnwrap(service.messages(for: threadID).last(where: { $0.role == .assistant }))
        let changeSet = try XCTUnwrap(service.readyChangeSet(forAssistantMessage: assistantMessage))

        XCTAssertEqual(changeSet.status, .ready)
        XCTAssertEqual(changeSet.fallbackPatchCount, 2)
        XCTAssertEqual(changeSet.fallbackPatchBatches.map { $0.fileChanges.first?.path }, ["Sources/A.swift", "Sources/B.swift"])
        XCTAssertTrue(changeSet.unsupportedReasons.isEmpty)
    }

    func testLegacyFallbackChangeSetRehydratesBatchesFromPersistedFileChanges() throws {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let changeSetID = "change-set-\(UUID().uuidString)"

        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: "Made several edits."
        )
        let assistantMessage = try XCTUnwrap(service.messages(for: threadID).last(where: { $0.role == .assistant }))

        service.messagesByThread[threadID, default: []].append(
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .fileChange,
                text: """
                Applied patch:

                ```diff
                diff --git a/Sources/A.swift b/Sources/A.swift
                index 1111111..2222222 100644
                --- a/Sources/A.swift
                +++ b/Sources/A.swift
                @@ -1 +1,2 @@
                 let a = 1
                +let b = 2
                ```
                """,
                turnId: turnID,
                orderIndex: 10
            )
        )
        service.messagesByThread[threadID, default: []].append(
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .fileChange,
                text: """
                Applied patch:

                ```patch
                diff --git a/Sources/B.swift b/Sources/B.swift
                index 3333333..4444444 100644
                --- a/Sources/B.swift
                +++ b/Sources/B.swift
                @@ -1 +1,2 @@
                 let c = 3
                +let d = 4
                ```
                """,
                turnId: turnID,
                orderIndex: 11
            )
        )
        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.aiChangeSetsByID[changeSetID] = AIChangeSet(
            id: changeSetID,
            repoRoot: "/tmp/repo",
            threadId: threadID,
            turnId: turnID,
            assistantMessageId: assistantMessage.id,
            status: .notRevertable,
            source: .fileChangeFallback,
            fallbackPatchCount: 2
        )
        service.aiChangeSetIDByTurnKey[AIChangeSetTurnKey(threadId: threadID, turnId: turnID)!] = changeSetID
        service.aiChangeSetIDByAssistantMessageID[assistantMessage.id] = changeSetID

        service.rehydrateLegacyFallbackChangeSetsFromPersistedMessages()

        let changeSet = try XCTUnwrap(service.readyChangeSet(forAssistantMessage: assistantMessage))
        XCTAssertEqual(changeSet.status, .ready)
        XCTAssertEqual(changeSet.fallbackPatchCount, 2)
        XCTAssertEqual(changeSet.fallbackPatchBatches.map { $0.fileChanges.first?.path }, ["Sources/A.swift", "Sources/B.swift"])
        XCTAssertTrue(changeSet.forwardUnifiedPatch.contains("Sources/A.swift"))
        XCTAssertTrue(changeSet.forwardUnifiedPatch.contains("Sources/B.swift"))
    }
}
