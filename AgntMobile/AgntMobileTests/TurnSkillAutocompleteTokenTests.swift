// FILE: TurnSkillAutocompleteTokenTests.swift
// Purpose: Verifies trailing `$` token parsing and replacement for skill autocomplete.
// Layer: Unit Test
// Exports: TurnSkillAutocompleteTokenTests
// Depends on: XCTest, AgntMobile

import XCTest
import UIKit
@testable import AgntMobile

@MainActor
final class TurnSkillAutocompleteTokenTests: XCTestCase {
    func testTrailingTokenParsesOnlyWhenItIsFinalToken() {
        let token = TurnViewModel.trailingSkillAutocompleteToken(in: "run $rev")
        XCTAssertEqual(token?.query, "rev")
    }

    func testTrailingTokenDoesNotParseWhenDollarTokenIsNotFinal() {
        XCTAssertNil(TurnViewModel.trailingSkillAutocompleteToken(in: "run $rev now"))
    }

    func testReplacingTrailingTokenUpdatesOnlyFinalDollarToken() {
        let updated = TurnViewModel.replacingTrailingSkillAutocompleteToken(
            in: "compare $first and $rev",
            with: "review"
        )

        XCTAssertEqual(updated, "compare $first and $review ")
    }

    func testInlineSkillTokenPreservesCanonicalText() {
        let attributed = TurnComposerInlineSkillToken.displayAttributedString(
            canonicalText: "run $check-code before $review",
            mentionNames: ["check-code"],
            font: .systemFont(ofSize: 15),
            textColor: .label,
            tintColor: .systemIndigo
        )

        XCTAssertEqual(TurnComposerInlineSkillToken.canonicalText(from: attributed), "run $check-code before $review")
        XCTAssertTrue(attributed.string.contains("Check Code"))
        XCTAssertFalse(attributed.string.contains("$check-code"))
    }

    func testInlineSkillTokenSnapsSelectionOutOfToken() {
        let attributed = TurnComposerInlineSkillToken.displayAttributedString(
            canonicalText: "$check-code now",
            mentionNames: ["check-code"],
            font: .systemFont(ofSize: 15),
            textColor: .label,
            tintColor: .systemIndigo
        )

        let snapped = TurnComposerInlineSkillToken.snappedSelection(NSRange(location: 2, length: 0), in: attributed)
        XCTAssertEqual(snapped.length, 0)
        XCTAssertTrue(snapped.location == 0 || snapped.location == ("$ Check Code" as NSString).length)
    }
}
