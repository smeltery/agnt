// FILE: AIChangeSetRevertPresentationTests.swift
// Purpose: Verifies assistant revert risk presentation across sibling threads.
// Layer: Unit Test
// Exports: AIChangeSetRevertPresentationTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class AIChangeSetRevertPresentationTests: AIChangeSetTestCase {
    func testAssistantRevertPresentationIsSafeForDistinctFilesInSameRepo() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let siblingThreadID = "thread-\(UUID().uuidString)"

        service.threads = [
            CodexThread(id: threadID, title: "Revert", cwd: "/tmp/repo"),
            CodexThread(id: siblingThreadID, title: "Sibling", cwd: "/tmp/repo")
        ]

        let assistantMessage = recordReadyChangeSet(
            service: service,
            threadID: threadID,
            filePath: "Sources/App.swift"
        )
        _ = recordReadyChangeSet(
            service: service,
            threadID: siblingThreadID,
            filePath: "README.md"
        )

        let presentation = try XCTUnwrap(
            service.assistantRevertPresentation(for: assistantMessage, workingDirectory: "/tmp/repo")
        )

        XCTAssertEqual(presentation.riskLevel, .safe)
        XCTAssertTrue(presentation.isEnabled)
        XCTAssertTrue(presentation.overlappingFiles.isEmpty)
    }

    func testAssistantRevertPresentationWarnsWhenSiblingTouchesSameFile() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let siblingThreadID = "thread-\(UUID().uuidString)"

        service.threads = [
            CodexThread(id: threadID, title: "Revert", cwd: "/tmp/repo"),
            CodexThread(id: siblingThreadID, title: "Sibling", cwd: "/tmp/repo")
        ]

        let assistantMessage = recordReadyChangeSet(
            service: service,
            threadID: threadID,
            filePath: "Sources/App.swift"
        )
        _ = recordReadyChangeSet(
            service: service,
            threadID: siblingThreadID,
            filePath: "Sources/App.swift"
        )

        let presentation = try XCTUnwrap(
            service.assistantRevertPresentation(for: assistantMessage, workingDirectory: "/tmp/repo")
        )

        XCTAssertEqual(presentation.riskLevel, .warning)
        XCTAssertTrue(presentation.isEnabled)
        XCTAssertEqual(presentation.overlappingFiles, ["Sources/App.swift"])
    }

    func testAssistantRevertPresentationBlocksWhileSiblingRunIsStillActive() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let siblingThreadID = "thread-\(UUID().uuidString)"

        service.threads = [
            CodexThread(id: threadID, title: "Revert", cwd: "/tmp/repo"),
            CodexThread(id: siblingThreadID, title: "Sibling", cwd: "/tmp/repo")
        ]

        let assistantMessage = recordReadyChangeSet(
            service: service,
            threadID: threadID,
            filePath: "Sources/App.swift"
        )

        service.markThreadAsRunning(siblingThreadID)

        let presentation = try XCTUnwrap(
            service.assistantRevertPresentation(for: assistantMessage, workingDirectory: "/tmp/repo")
        )

        XCTAssertEqual(presentation.riskLevel, .blocked)
        XCTAssertFalse(presentation.isEnabled)
        XCTAssertEqual(
            presentation.helperText,
            "Finish the active run in this repo before undoing this response."
        )
    }

    func testTimelineSnapshotInvalidatesWarningWhenSiblingChangeSetBecomesReverted() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let siblingThreadID = "thread-\(UUID().uuidString)"

        service.threads = [
            CodexThread(id: threadID, title: "Revert", cwd: "/tmp/repo"),
            CodexThread(id: siblingThreadID, title: "Sibling", cwd: "/tmp/repo")
        ]

        let assistantMessage = recordReadyChangeSet(
            service: service,
            threadID: threadID,
            filePath: "Sources/App.swift"
        )
        let siblingMessage = recordReadyChangeSet(
            service: service,
            threadID: siblingThreadID,
            filePath: "Sources/App.swift"
        )

        XCTAssertEqual(
            service.timelineState(for: threadID).renderSnapshot.assistantRevertStatesByMessageID[assistantMessage.id]?.riskLevel,
            .warning
        )

        let siblingChangeSet = try XCTUnwrap(service.readyChangeSet(forAssistantMessage: siblingMessage))
        var revertedChangeSet = siblingChangeSet
        revertedChangeSet.status = .reverted
        service.aiChangeSetsByID[siblingChangeSet.id] = revertedChangeSet
        service.invalidateAssistantRevertStates()

        XCTAssertEqual(
            service.timelineState(for: threadID).renderSnapshot.assistantRevertStatesByMessageID[assistantMessage.id]?.riskLevel,
            .safe
        )
    }

    func testRememberRepoRootRefreshesOverlapAcrossSiblingSubdirectories() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let siblingThreadID = "thread-\(UUID().uuidString)"

        service.threads = [
            CodexThread(id: threadID, title: "App", cwd: "/tmp/repo/app"),
            CodexThread(id: siblingThreadID, title: "Docs", cwd: "/tmp/repo/docs")
        ]

        service.rememberRepoRoot("/tmp/repo", forWorkingDirectory: "/tmp/repo/docs")
        let assistantMessage = recordReadyChangeSet(
            service: service,
            threadID: threadID,
            filePath: "README.md"
        )
        _ = recordReadyChangeSet(
            service: service,
            threadID: siblingThreadID,
            filePath: "README.md"
        )

        XCTAssertEqual(
            service.timelineState(for: threadID).renderSnapshot.assistantRevertStatesByMessageID[assistantMessage.id]?.riskLevel,
            .safe
        )

        service.rememberRepoRoot("/tmp/repo", forWorkingDirectory: "/tmp/repo/app")

        XCTAssertEqual(
            service.timelineState(for: threadID).renderSnapshot.assistantRevertStatesByMessageID[assistantMessage.id]?.riskLevel,
            .warning
        )
    }

    func testAssistantRevertPresentationBlocksWhenWorkingDirectoryIsMissing() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let assistantMessage = recordReadyChangeSet(
            service: service,
            threadID: threadID,
            filePath: "Sources/App.swift"
        )

        let presentation = try XCTUnwrap(
            service.assistantRevertPresentation(for: assistantMessage, workingDirectory: nil)
        )

        XCTAssertEqual(presentation.riskLevel, .blocked)
        XCTAssertFalse(presentation.isEnabled)
    }

    func testAssistantRevertPresentationBlocksLegacyFallbackWithoutBatches() throws {
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
        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.aiChangeSetsByID[changeSetID] = AIChangeSet(
            id: changeSetID,
            repoRoot: "/tmp/repo",
            threadId: threadID,
            turnId: turnID,
            assistantMessageId: assistantMessage.id,
            status: .notRevertable,
            source: .fileChangeFallback,
            forwardUnifiedPatch: "legacy patch body",
            fileChanges: [
                AIFileChange(
                    path: "Sources/A.swift",
                    kind: .update,
                    additions: 1,
                    deletions: 0,
                    isBinary: false,
                    isRenameOrModeOnly: false,
                    beforeContentHash: nil,
                    afterContentHash: nil
                )
            ],
            fallbackPatchCount: 2
        )
        service.aiChangeSetIDByTurnKey[AIChangeSetTurnKey(threadId: threadID, turnId: turnID)!] = changeSetID
        service.aiChangeSetIDByAssistantMessageID[assistantMessage.id] = changeSetID
        service.noteTurnFinished(threadId: threadID, turnId: turnID)
        let presentation = try XCTUnwrap(
            service.assistantRevertPresentation(for: assistantMessage, workingDirectory: "/tmp/repo")
        )

        XCTAssertEqual(presentation.riskLevel, .blocked)
        XCTAssertFalse(presentation.isEnabled)
    }

    func testArchiveThreadPrunesCachedTimelineState() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        service.threads = [
            CodexThread(id: threadID, title: "Archive Me", cwd: "/tmp/repo")
        ]

        service.appendSystemMessage(
            threadId: threadID,
            text: "Status: completed\n\nPath: Sources/App.swift\nKind: update\nTotals: +1 -0",
            kind: .fileChange
        )
        _ = service.timelineState(for: threadID)

        XCTAssertNotNil(service.threadTimelineStateByThread[threadID])

        service.archiveThread(threadID)
        service.refreshAllThreadTimelineStates()

        XCTAssertNil(service.threadTimelineStateByThread[threadID])
        XCTAssertNil(service.latestRepoAffectingMessageSignalByThread[threadID])
        XCTAssertNil(service.stoppedTurnIDsByThread[threadID])
    }

    // Creates a finalized, undoable response fixture with one changed file.
}
