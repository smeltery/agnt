// FILE: CodexThreadProvenanceTests.swift
// Purpose: Verifies optional thread provenance used by sidebar grouping survives JSON decoding.
// Layer: Unit Test
// Exports: CodexThreadProvenanceTests

import XCTest
@testable import AgntMobile

final class CodexThreadProvenanceTests: XCTestCase {
    func testDecodesWorktreeOriginPathFromThreadRow() throws {
        let data = Data("""
        {
          "id": "thread-worktree",
          "cwd": "/Users/me/.codex/worktrees/ce15/agnt",
          "worktreeOriginPath": "/Users/me/work/agnt"
        }
        """.utf8)

        let thread = try JSONDecoder().decode(CodexThread.self, from: data)

        XCTAssertEqual(thread.normalizedProjectPath, "/Users/me/.codex/worktrees/ce15/agnt")
        XCTAssertEqual(thread.normalizedWorktreeOriginPath, "/Users/me/work/agnt")
        XCTAssertEqual(thread.projectGroupPath, "/Users/me/work/agnt")
        XCTAssertEqual(thread.gitWorkingDirectory, "/Users/me/.codex/worktrees/ce15/agnt")
    }

    func testDecodesThreadSourceAndForkMetadataFromMetadataPayload() throws {
        let data = Data("""
        {
          "id": "thread-fork",
            "metadata": {
            "forked_from_id": "thread-origin",
            "thread_source": "pull_request_fix_automation",
            "worktree_origin_path": "/Users/me/work/agnt"
          }
        }
        """.utf8)

        let thread = try JSONDecoder().decode(CodexThread.self, from: data)

        XCTAssertEqual(thread.forkedFromThreadId, "thread-origin")
        XCTAssertEqual(thread.threadSource, "pull_request_fix_automation")
        XCTAssertEqual(thread.automationSourceLabel, "Pull Request Fix Automation")
        XCTAssertEqual(thread.normalizedWorktreeOriginPath, "/Users/me/work/agnt")
    }
}
