// FILE: WorkspaceFileLinkResolverTests.swift
// Purpose: Verifies assistant markdown links only intercept local workspace file paths.
// Layer: Unit Test
// Exports: WorkspaceFileLinkResolverTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

final class WorkspaceFileLinkResolverTests: XCTestCase {
    func testResolvesAbsoluteFileUrl() {
        let url = URL(fileURLWithPath: "/Users/dev/project/Sources/App.swift")

        XCTAssertEqual(
            WorkspaceFileLinkResolver.localPath(from: url),
            "/Users/dev/project/Sources/App.swift"
        )
    }

    func testResolvesRelativeMarkdownPathAndStripsLineSuffix() throws {
        let url = try XCTUnwrap(URL(string: "Sources/App.swift:12"))

        XCTAssertEqual(
            WorkspaceFileLinkResolver.localPath(from: url),
            "Sources/App.swift"
        )
    }

    func testRejectsWebUrls() throws {
        let url = try XCTUnwrap(URL(string: "https://github.com/dotbrains/agnt"))

        XCTAssertNil(WorkspaceFileLinkResolver.localPath(from: url))
    }

    func testRejectsSchemeLessWebUrls() throws {
        let url = try XCTUnwrap(URL(string: "github.com/dotbrains/agnt"))

        XCTAssertNil(WorkspaceFileLinkResolver.localPath(from: url))
    }

    func testResolvesRelativeSVGPath() throws {
        let url = try XCTUnwrap(URL(string: "docs/diagram.svg"))

        XCTAssertEqual(
            WorkspaceFileLinkResolver.localPath(from: url),
            "docs/diagram.svg"
        )
    }
}
