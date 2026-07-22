// FILE: CodexThreadStartProjectBindingTests.swift
// Purpose: Verifies thread/start project binding params and cwd fallback behavior.
// Layer: Unit Test
// Exports: CodexThreadStartProjectBindingTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

final class CodexThreadStartProjectBindingTests: XCTestCase {
    func testMakeThreadStartParamsIncludesModelAndCwd() {
        let params = CodexThreadStartProjectBinding.makeThreadStartParams(
            modelIdentifier: "gpt-5",
            preferredProjectPath: "/Users/me/work/project",
            serviceTier: "fast"
        )

        XCTAssertEqual(params["model"]?.stringValue, "gpt-5")
        XCTAssertEqual(params["cwd"]?.stringValue, "/Users/me/work/project")
        XCTAssertEqual(params["serviceTier"]?.stringValue, "fast")
    }

    func testMakeThreadStartParamsSkipsEmptyCwd() {
        let normalized = CodexThreadStartProjectBinding.normalizedProjectPath("   ")
        let params = CodexThreadStartProjectBinding.makeThreadStartParams(
            modelIdentifier: nil,
            preferredProjectPath: normalized,
            serviceTier: nil
        )

        XCTAssertNil(params["cwd"])
        XCTAssertTrue(params.isEmpty)
    }

    func testMakeThreadStartParamsSkipsPseudoProjectBucketCwd() {
        let normalized = CodexThreadStartProjectBinding.normalizedProjectPath("server")
        let params = CodexThreadStartProjectBinding.makeThreadStartParams(
            modelIdentifier: nil,
            preferredProjectPath: normalized,
            serviceTier: nil
        )

        XCTAssertNil(params["cwd"])
        XCTAssertTrue(params.isEmpty)
    }

    func testNormalizedProjectPathPreservesTildeRoot() {
        XCTAssertEqual(CodexThreadStartProjectBinding.normalizedProjectPath("~/"), "~/")
        XCTAssertEqual(CodexThreadStartProjectBinding.normalizedProjectPath("~/repo/"), "~/repo")
    }

    func testNormalizedProjectPathPreservesWindowsDriveRoot() {
        XCTAssertEqual(CodexThreadStartProjectBinding.normalizedProjectPath("C:/"), "C:/")
        XCTAssertEqual(CodexThreadStartProjectBinding.normalizedProjectPath("C:/repo/"), "C:/repo")
    }

    func testApplyFallbackSetsCwdWhenMissingInResponse() {
        let responseThread = CodexThread(id: "thread-1", cwd: nil)
        let patched = CodexThreadStartProjectBinding.applyPreferredProjectFallback(
            to: responseThread,
            preferredProjectPath: "/Users/me/work/project"
        )

        XCTAssertEqual(patched.cwd, "/Users/me/work/project")
    }

    func testApplyFallbackDoesNotOverrideExistingCwd() {
        let responseThread = CodexThread(id: "thread-1", cwd: "/server/path")
        let patched = CodexThreadStartProjectBinding.applyPreferredProjectFallback(
            to: responseThread,
            preferredProjectPath: "/Users/me/work/project"
        )

        XCTAssertEqual(patched.cwd, "/server/path")
    }

    func testApplyFallbackOverridesPseudoProjectBucketCwd() {
        let responseThread = CodexThread(id: "thread-1", cwd: "server")
        let patched = CodexThreadStartProjectBinding.applyPreferredProjectFallback(
            to: responseThread,
            preferredProjectPath: "/Users/me/work/project"
        )

        XCTAssertEqual(patched.cwd, "/Users/me/work/project")
    }

    func testGitWorkingDirectoryReturnsNormalizedThreadPath() {
        let thread = CodexThread(id: "thread-1", cwd: "/Users/me/work/project///")

        XCTAssertEqual(thread.gitWorkingDirectory, "/Users/me/work/project")
    }

    func testGitWorkingDirectoryIsNilForUnboundThread() {
        let thread = CodexThread(id: "thread-1", cwd: "   ")

        XCTAssertNil(thread.gitWorkingDirectory)
    }

    func testPseudoProjectBucketDoesNotBecomeGitWorkingDirectory() {
        let thread = CodexThread(id: "thread-1", cwd: "_default")

        XCTAssertNil(thread.normalizedProjectPath)
        XCTAssertNil(thread.gitWorkingDirectory)
    }

    func testRootThreadsCanShowGitControlsForSharedWorkingDirectory() {
        let older = CodexThread(
            id: "old",
            createdAt: Date(timeIntervalSince1970: 100),
            updatedAt: Date(timeIntervalSince1970: 200),
            cwd: "/repo"
        )
        let newer = CodexThread(
            id: "new",
            createdAt: Date(timeIntervalSince1970: 300),
            updatedAt: Date(timeIntervalSince1970: 400),
            cwd: "/repo"
        )

        XCTAssertTrue(CodexThread.gitControlsVisible(
            for: older,
            workingDirectory: "/repo",
            isConnected: true
        ))
        XCTAssertTrue(CodexThread.gitControlsVisible(
            for: newer,
            workingDirectory: "/repo",
            isConnected: true
        ))
    }

    func testSubagentThreadsDoNotShowRootThreadGitControls() {
        let root = CodexThread(
            id: "root",
            createdAt: Date(timeIntervalSince1970: 100),
            updatedAt: Date(timeIntervalSince1970: 200),
            cwd: "/repo"
        )
        let subagent = CodexThread(
            id: "subagent",
            createdAt: Date(timeIntervalSince1970: 300),
            updatedAt: Date(timeIntervalSince1970: 400),
            cwd: "/repo",
            parentThreadId: "root"
        )

        XCTAssertTrue(CodexThread.gitControlsVisible(
            for: root,
            workingDirectory: "/repo",
            isConnected: true
        ))
        XCTAssertFalse(CodexThread.gitControlsVisible(
            for: subagent,
            workingDirectory: "/repo",
            isConnected: true
        ))
    }

    func testGitControlsRequireConnectedLiveRootThreadWithWorkingDirectory() {
        let thread = CodexThread(
            id: "thread",
            createdAt: Date(timeIntervalSince1970: 100),
            updatedAt: Date(timeIntervalSince1970: 200),
            cwd: "/repo"
        )
        let archivedThread = CodexThread(
            id: "archived",
            cwd: "/repo",
            syncState: .archivedLocal
        )

        XCTAssertTrue(CodexThread.gitControlsVisible(
            for: thread,
            workingDirectory: "/repo",
            isConnected: true
        ))
        XCTAssertFalse(CodexThread.gitControlsVisible(
            for: thread,
            workingDirectory: "/repo",
            isConnected: false
        ))
        XCTAssertFalse(CodexThread.gitControlsVisible(
            for: thread,
            workingDirectory: nil,
            isConnected: true
        ))
        XCTAssertFalse(CodexThread.gitControlsVisible(
            for: archivedThread,
            workingDirectory: "/repo",
            isConnected: true
        ))
    }

    func testProjectlessThreadUsesNoProjectPresentation() {
        let thread = CodexThread(id: "thread-1", cwd: nil)

        XCTAssertEqual(thread.projectDisplayName, "No Project")
        XCTAssertEqual(CodexThread.projectDisplayLabel(for: nil), "No Project")
        XCTAssertEqual(CodexThread.projectIconSystemName(for: nil), "bubble.left.and.bubble.right")
        XCTAssertNil(thread.normalizedProjectPath)
        XCTAssertNil(thread.gitWorkingDirectory)
    }

    func testAgentDisplayLabelCombinesNicknameAndRole() {
        let thread = CodexThread(
            id: "thread-agent",
            agentNickname: "Locke",
            agentRole: "explorer"
        )

        XCTAssertEqual(thread.agentDisplayLabel, "Locke [explorer]")
    }

    func testDisplayTitlePrefersAgentLabelOverGenericConversation() {
        let thread = CodexThread(
            id: "thread-agent",
            title: "Conversation",
            parentThreadId: "parent-thread",
            agentNickname: "Locke",
            agentRole: "explorer"
        )

        XCTAssertEqual(thread.displayTitle, "Locke [explorer]")
    }

    func testLegacyConversationTitleDisplaysAsNewThread() {
        let thread = CodexThread(
            id: "thread-legacy",
            title: "Conversation"
        )

        XCTAssertEqual(thread.displayTitle, "New Thread")
    }

    func testModelDisplayLabelPrefersProviderName() {
        let thread = CodexThread(
            id: "thread-agent",
            model: "gpt-5.4",
            modelProvider: "gpt-5.4-mini"
        )

        XCTAssertEqual(thread.modelDisplayLabel, "gpt-5.4-mini")
    }

    func testAgentDisplayLabelIgnoresCollabToolItemTypeNoise() throws {
        let payload = """
        {
          "id": "thread-agent",
          "metadata": {
            "agentNickname": "Locke",
            "type": "collabAgentToolCall",
            "agentRole": "explorer"
          }
        }
        """.data(using: .utf8)!

        let thread = try JSONDecoder().decode(CodexThread.self, from: payload)

        XCTAssertEqual(thread.agentDisplayLabel, "Locke [explorer]")
    }

    func testDecodesEphemeralThreadFlag() throws {
        let payload = """
        {
          "id": "thread-ephemeral",
          "title": "Temporary side conversation",
          "ephemeral": true
        }
        """.data(using: .utf8)!

        let thread = try JSONDecoder().decode(CodexThread.self, from: payload)

        XCTAssertTrue(thread.ephemeral)
    }
}
