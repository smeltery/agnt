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

    func testResolvesAbsolutePathURLString() throws {
        let url = try XCTUnwrap(URL(string: "/Users/dev/project/Sources/App.swift"))

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

    func testStripsLineColumnFragmentAndQuerySuffixes() throws {
        let lineColumnURL = try XCTUnwrap(URL(string: "Sources/App.swift:42:7"))
        let fragmentURL = try XCTUnwrap(URL(string: "Sources/App.swift#L42"))
        let queryURL = try XCTUnwrap(URL(string: "Sources/App.swift?plain=1"))

        XCTAssertEqual(WorkspaceFileLinkResolver.localPath(from: lineColumnURL), "Sources/App.swift")
        XCTAssertEqual(WorkspaceFileLinkResolver.localPath(from: fragmentURL), "Sources/App.swift")
        XCTAssertEqual(WorkspaceFileLinkResolver.localPath(from: queryURL), "Sources/App.swift")
    }

    func testResolvesExtensionlessKnownFileName() throws {
        let url = try XCTUnwrap(URL(string: "Dockerfile"))

        XCTAssertEqual(
            WorkspaceFileLinkResolver.localPath(from: url),
            "Dockerfile"
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
