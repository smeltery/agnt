// FILE: SidebarThreadGroupingTestSupport.swift
// Purpose: Shared fixtures for sidebar thread grouping tests.
// Layer: Unit Test Support
// Exports: SidebarThreadGroupingTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

class SidebarThreadGroupingTestCase: XCTestCase {
    func makeThread(
        id: String,
        updatedAt: Date,
        cwd: String?,
        worktreeOriginPath: String? = nil,
        syncState: CodexThreadSyncState = .live,
        parentThreadId: String? = nil,
        forkedFromThreadId: String? = nil,
        ephemeral: Bool = false
    ) -> CodexThread {
        CodexThread(
            id: id,
            title: id,
            updatedAt: updatedAt,
            cwd: cwd,
            worktreeOriginPath: worktreeOriginPath,
            forkedFromThreadId: forkedFromThreadId,
            parentThreadId: parentThreadId,
            ephemeral: ephemeral,
            syncState: syncState
        )
    }

    func makeProjectGroup(id: String) -> SidebarThreadGroup {
        SidebarThreadGroup(
            id: id,
            label: id,
            kind: .project,
            sortDate: .distantPast,
            projectPath: id.replacingOccurrences(of: "project:", with: ""),
            threads: []
        )
    }
}
