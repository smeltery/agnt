// FILE: TerminalSelectableTextNormalizerTests.swift
// Purpose: Verifies selectable terminal text cleanup preserves visible grid content.
// Layer: Unit Test
// Exports: TerminalSelectableTextNormalizerTests
// Depends on: XCTest, AgntMobile

import XCTest
import UIKit
@testable import AgntMobile

final class TerminalSelectableTextNormalizerTests: XCTestCase {
    func testPreservesLeadingIndentationOnFirstContentLine() {
        let normalized = TerminalSelectableTextNormalizer.normalizedText(
            fromLines: ["", "    indented command   ", ""]
        )

        XCTAssertEqual(normalized, "    indented command")
    }

    func testDropsOnlyEmptyEdgeRows() {
        let normalized = TerminalSelectableTextNormalizer.normalizedText(
            fromLines: ["", "first", "", "third", ""]
        )

        XCTAssertEqual(normalized, "first\n\nthird")
    }

    func testKeepsVisualRowBreaksFromWrappedTerminalRows() {
        let normalized = TerminalSelectableTextNormalizer.normalizedText(
            fromLines: ["long output part one", "part two   "]
        )

        XCTAssertEqual(normalized, "long output part one\npart two")
    }

    func testGhosttyDrawableViewportRejectsOnlySubCellSizes() {
        XCTAssertFalse(GhosttyTerminalView.isDrawableViewportSize(CGSize(width: 12, height: 390)))
        XCTAssertFalse(GhosttyTerminalView.isDrawableViewportSize(CGSize(width: 390, height: 12)))
        XCTAssertTrue(GhosttyTerminalView.isDrawableViewportSize(CGSize(width: 390, height: 120)))
        XCTAssertTrue(GhosttyTerminalView.isDrawableViewportSize(CGSize(width: 240, height: 44)))
    }
}
