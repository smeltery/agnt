// FILE: StreamingInlineMarkupAutoCloserTests.swift
// Purpose: Verifies render-only virtual closers for streaming inline markdown.
// Layer: Unit Test
// Exports: StreamingInlineMarkupAutoCloserTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

final class StreamingInlineMarkupAutoCloserTests: XCTestCase {
    func testUnclosedInlineSpanDoesNotLeakAcrossParagraphs() {
        let text = "- An unmatched **marker\n\n- A different item"
        XCTAssertEqual(StreamingInlineMarkupAutoCloser.autoClosed(text), text)
        XCTAssertEqual(
            StreamingInlineMarkupAutoCloser.autoClosed(text + " with `code"),
            text + " with `code`"
        )
    }

    func testShorterFenceAndDifferentMarkerKeepInlineMarkersLiteral() {
        let text = "````markdown\n```\n~~~\n\n**literal `marker\n````"
        XCTAssertEqual(StreamingInlineMarkupAutoCloser.autoClosed(text), text)
        XCTAssertEqual(
            StreamingInlineMarkupAutoCloser.autoClosed(text + "\n\nthen `inline"),
            text + "\n\nthen `inline`"
        )
    }

    func testPlainAndBalancedTextPassThrough() {
        XCTAssertEqual(StreamingInlineMarkupAutoCloser.autoClosed("plain text"), "plain text")
        XCTAssertEqual(
            StreamingInlineMarkupAutoCloser.autoClosed("Use `code` and **bold**."),
            "Use `code` and **bold**."
        )
    }

    func testOpenCodeWithContentReceivesVirtualCloser() {
        XCTAssertEqual(
            StreamingInlineMarkupAutoCloser.autoClosed("Use `git status"),
            "Use `git status`"
        )
    }

    func testOpenBoldWithContentReceivesVirtualCloser() {
        XCTAssertEqual(
            StreamingInlineMarkupAutoCloser.autoClosed("This is **important"),
            "This is **important**"
        )
    }

    func testNestedOpenBoldAndCodeCloseInParserFriendlyOrder() {
        XCTAssertEqual(
            StreamingInlineMarkupAutoCloser.autoClosed("**Review `file"),
            "**Review `file`**"
        )
    }

    func testBareTrailingOpenersAreHeldBack() {
        XCTAssertEqual(StreamingInlineMarkupAutoCloser.autoClosed("Use `"), "Use ")
        XCTAssertEqual(StreamingInlineMarkupAutoCloser.autoClosed("This is **"), "This is ")
    }

    func testBareCodeInsideOpenBoldKeepsBoldStable() {
        XCTAssertEqual(
            StreamingInlineMarkupAutoCloser.autoClosed("**Review `"),
            "**Review**"
        )
    }

    func testTrailingWhitespaceIsTrimmedBeforeBoldCloser() {
        XCTAssertEqual(
            StreamingInlineMarkupAutoCloser.autoClosed("**Review "),
            "**Review**"
        )
    }

    func testFencedCodeBlocksAreNotRewritten() {
        let openFence = "intro\n```swift\nlet value = `raw` ** text"
        XCTAssertEqual(StreamingInlineMarkupAutoCloser.autoClosed(openFence), openFence)

        XCTAssertEqual(
            StreamingInlineMarkupAutoCloser.autoClosed("```\n`raw` ** text\n```\nthen `code"),
            "```\n`raw` ** text\n```\nthen `code`"
        )
    }

    func testOperatorsAndEscapesStayLiteral() {
        XCTAssertEqual(
            StreamingInlineMarkupAutoCloser.autoClosed("2 ** 3 == 8"),
            "2 ** 3 == 8"
        )
        XCTAssertEqual(
            StreamingInlineMarkupAutoCloser.autoClosed("literal \\` and \\*\\* markers"),
            "literal \\` and \\*\\* markers"
        )
    }

    func testCodeSpanMayContinueAcrossLineBreak() {
        XCTAssertEqual(
            StreamingInlineMarkupAutoCloser.autoClosed("wrap `first\nsecond"),
            "wrap `first\nsecond`"
        )
    }
}
