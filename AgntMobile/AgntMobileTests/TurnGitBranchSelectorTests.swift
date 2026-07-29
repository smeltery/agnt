// FILE: TurnGitBranchSelectorTests.swift
// Purpose: Verifies new branch creation names normalize toward the agnt/ prefix without double-prefixing.
// Layer: Unit Test
// Exports: TurnGitBranchSelectorTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

final class TurnGitBranchSelectorTests: XCTestCase {
    func testNormalizesCreatedBranchNamesTowardAgntPrefix() {
        XCTAssertEqual(agntNormalizedCreatedBranchName("foo"), "agnt/foo")
        XCTAssertEqual(agntNormalizedCreatedBranchName("agnt/foo"), "agnt/foo")
        XCTAssertEqual(agntNormalizedCreatedBranchName("  foo  "), "agnt/foo")
    }

    func testNormalizesEmptyBranchNamesToEmptyString() {
        XCTAssertEqual(agntNormalizedCreatedBranchName("   "), "")
    }

    func testCreatedBranchNameValidationRejectsEmptyAndBarePrefix() {
        XCTAssertFalse(agntCreatedBranchNameIsValid(""))
        XCTAssertFalse(agntCreatedBranchNameIsValid("   "))
        XCTAssertFalse(agntCreatedBranchNameIsValid("agnt/"))
        XCTAssertTrue(agntCreatedBranchNameIsValid("agnt/feature-a"))
        XCTAssertTrue(agntCreatedBranchNameIsValid("feature-a"))
    }

    func testVisibleBranchLabelFallsBackToDefaultThenPlaceholder() {
        XCTAssertEqual(
            agntVisibleBranchLabel(currentBranch: " agnt/topic ", defaultBranch: "main"),
            "agnt/topic"
        )
        XCTAssertEqual(
            agntVisibleBranchLabel(currentBranch: " ", defaultBranch: " main "),
            "main"
        )
        XCTAssertEqual(
            agntVisibleBranchLabel(currentBranch: " ", defaultBranch: " "),
            "Branch"
        )
    }

    func testCurrentBranchSelectionDisablesCheckedOutElsewhereRowsWhenWorktreePathIsMissing() {
        XCTAssertTrue(
            agntCurrentBranchSelectionIsDisabled(
                branch: "agnt/feature-a",
                currentBranch: "main",
                gitBranchesCheckedOutElsewhere: ["agnt/feature-a"],
                gitWorktreePathsByBranch: [:],
                allowsSelectingCurrentBranch: true
            )
        )
    }

    func testCurrentBranchSelectionKeepsCheckedOutElsewhereRowsEnabledWhenWorktreePathExists() {
        XCTAssertFalse(
            agntCurrentBranchSelectionIsDisabled(
                branch: "agnt/feature-a",
                currentBranch: "main",
                gitBranchesCheckedOutElsewhere: ["agnt/feature-a"],
                gitWorktreePathsByBranch: ["agnt/feature-a": "/tmp/agnt-feature-a"],
                allowsSelectingCurrentBranch: true
            )
        )
    }

    func testSelectableDefaultBranchReturnsNilWhenDefaultIsNotLocal() {
        XCTAssertNil(
            agntSelectableDefaultBranch(
                defaultBranch: "main",
                availableGitBranchTargets: ["agnt/feature-a"]
            )
        )
    }

    func testSelectableDefaultBranchReturnsDefaultWhenItIsLocal() {
        XCTAssertEqual(
            agntSelectableDefaultBranch(
                defaultBranch: "main",
                availableGitBranchTargets: ["main", "agnt/feature-a"]
            ),
            "main"
        )
    }
}
