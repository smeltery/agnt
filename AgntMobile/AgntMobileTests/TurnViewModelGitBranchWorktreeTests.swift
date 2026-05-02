// FILE: TurnViewModelGitBranchWorktreeTests.swift
// Purpose: Verifies worktree-backed branches are exposed to the UI only when Git reports them as checked out elsewhere.
// Layer: Unit Test
// Exports: TurnViewModelGitBranchWorktreeTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class TurnViewModelGitBranchWorktreeTests: XCTestCase {
    func testWorktreePathResolvesOnlyForBranchesCheckedOutElsewhere() {
        let viewModel = TurnViewModel()
        viewModel.gitBranchesCheckedOutElsewhere = ["agnt/feature-a"]
        viewModel.gitWorktreePathsByBranch = [
            "agnt/feature-a": "/tmp/agnt-feature-a",
            "main": "/tmp/agnt-main"
        ]

        XCTAssertEqual(
            viewModel.worktreePathForCheckedOutElsewhereBranch("agnt/feature-a"),
            "/tmp/agnt-feature-a"
        )
        XCTAssertNil(viewModel.worktreePathForCheckedOutElsewhereBranch("main"))
        XCTAssertNil(viewModel.worktreePathForCheckedOutElsewhereBranch("agnt/missing"))
    }

    func testApplyGitBranchTargetsStoresTrueLocalCheckoutPath() {
        let viewModel = TurnViewModel()
        let result = GitBranchesWithStatusResult(
            from: [
                "branches": .array([.string("main")]),
                "branchesCheckedOutElsewhere": .array([]),
                "worktreePathByBranch": .object([:]),
                "localCheckoutPath": .string("/tmp/agnt-local/agnt-bridge"),
                "current": .string("main"),
                "default": .string("main"),
            ]
        )

        viewModel.applyGitBranchTargets(result)

        XCTAssertEqual(viewModel.gitLocalCheckoutPath, "/tmp/agnt-local/agnt-bridge")
    }

    func testApplyGitBranchTargetsKeepsSelectedBaseBranchEmptyWhenDefaultIsRemoteOnly() {
        let viewModel = TurnViewModel()
        let result = GitBranchesWithStatusResult(
            from: [
                "branches": .array([.string("agnt/topic")]),
                "branchesCheckedOutElsewhere": .array([]),
                "worktreePathByBranch": .object([:]),
                "localCheckoutPath": .string("/tmp/agnt-local/agnt-bridge"),
                "current": .string("agnt/topic"),
                "default": .string("main"),
            ]
        )

        viewModel.applyGitBranchTargets(result)

        XCTAssertEqual(viewModel.gitDefaultBranch, "main")
        XCTAssertEqual(viewModel.selectedGitBaseBranch, "")
    }

    func testApplyGitBranchTargetsPreservesValidLocalBaseBranchSelection() {
        let viewModel = TurnViewModel()
        viewModel.selectedGitBaseBranch = "release/1.0"
        let result = GitBranchesWithStatusResult(
            from: [
                "branches": .array([.string("main"), .string("release/1.0"), .string("agnt/topic")]),
                "branchesCheckedOutElsewhere": .array([]),
                "worktreePathByBranch": .object([:]),
                "localCheckoutPath": .string("/tmp/agnt-local/agnt-bridge"),
                "current": .string("agnt/topic"),
                "default": .string("main"),
            ]
        )

        viewModel.applyGitBranchTargets(result)

        XCTAssertEqual(viewModel.selectedGitBaseBranch, "release/1.0")
    }
}
