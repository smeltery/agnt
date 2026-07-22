// FILE: CodexAccessModeTests.swift
// Purpose: Guards the runtime access-mode strings used by fork/send fallbacks.
// Layer: Unit Test
// Exports: CodexAccessModeTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

final class CodexAccessModeTests: XCTestCase {
    func testSandboxLegacyValuesMatchRuntimeEnums() {
        XCTAssertEqual(CodexAccessMode.onRequest.sandboxLegacyValue, "workspace-write")
        XCTAssertEqual(CodexAccessMode.autoReview.sandboxLegacyValue, "workspace-write")
        XCTAssertEqual(CodexAccessMode.fullAccess.sandboxLegacyValue, "danger-full-access")
    }

    func testAutoReviewUsesGuardianReviewerFallbacks() {
        XCTAssertEqual(CodexAccessMode.autoReview.approvalPolicyCandidates, ["on-request", "onRequest"])
        XCTAssertEqual(CodexAccessMode.autoReview.approvalsReviewerCandidates, ["auto_review", "guardian_subagent"])
    }

    func testEveryAccessModeHasComposerPresentation() {
        for mode in CodexAccessMode.allCases {
            XCTAssertFalse(mode.pickerTitle.isEmpty)
            XCTAssertFalse(mode.pickerSubtitle.isEmpty)
        }

        XCTAssertEqual(CodexAccessMode.autoReview.pickerTitle, "Approve for Me")
        XCTAssertEqual(CodexAccessMode.autoReview.pickerSubtitle, "Let the local reviewer approve low-risk actions.")
    }
}
