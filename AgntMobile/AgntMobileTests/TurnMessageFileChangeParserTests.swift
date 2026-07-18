// FILE: TurnMessageFileChangeParserTests.swift
// Purpose: Verifies file-change diff and summary parser cache behavior.
// Layer: Unit Test
// Exports: TurnMessageFileChangeParserTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class TurnMessageFileChangeParserTests: TurnMessageCachesTestCase {
    func testPerFileDiffParserKeepsSameNamedFilesInDifferentDirectoriesSeparate() {
        let bodyText = """
        Path: Sources/FeatureA/TurnMessageComponents.swift
        Kind: update
        Totals: +1 -0

        `@agnt``diff
        @@ -1,3 +1,4 @@
        +let featureA = true
        `@agnt``

        Path: Sources/FeatureB/TurnMessageComponents.swift
        Kind: update
        Totals: +1 -0

        `@agnt``diff
        @@ -1,3 +1,4 @@
        +let featureB = true
        `@agnt``
        """
        let entries = [
            TurnFileChangeSummaryEntry(
                path: "Sources/FeatureA/TurnMessageComponents.swift",
                additions: 1,
                deletions: 0,
                action: .edited
            ),
            TurnFileChangeSummaryEntry(
                path: "Sources/FeatureB/TurnMessageComponents.swift",
                additions: 1,
                deletions: 0,
                action: .edited
            ),
        ]

        let chunks = PerFileDiffParser.parse(bodyText: bodyText, entries: entries)

        XCTAssertEqual(chunks.count, 2)
        XCTAssertEqual(chunks.map(\.path), entries.map(\.path))
    }

    func testPerFileDiffParserDoesNotMergeBareFilenameWithDirectoryScopedPath() {
        let bodyText = """
        Path: TurnMessageComponents.swift
        Kind: update
        Totals: +1 -0

        `@agnt``diff
        @@ -1,3 +1,4 @@
        +let filenameOnly = true
        `@agnt``

        Path: Sources/FeatureA/TurnMessageComponents.swift
        Kind: update
        Totals: +1 -0

        `@agnt``diff
        @@ -1,3 +1,4 @@
        +let directoryScoped = true
        `@agnt``
        """
        let entries = [
            TurnFileChangeSummaryEntry(
                path: "TurnMessageComponents.swift",
                additions: 1,
                deletions: 0,
                action: .edited
            ),
            TurnFileChangeSummaryEntry(
                path: "Sources/FeatureA/TurnMessageComponents.swift",
                additions: 1,
                deletions: 0,
                action: .edited
            ),
        ]

        let chunks = PerFileDiffParser.parse(bodyText: bodyText, entries: entries)

        XCTAssertEqual(chunks.count, 2)
        XCTAssertEqual(chunks.map(\.path), entries.map(\.path))
    }

    func testPerFileDiffParserMergesMultipleSnapshotsForSameFile() {
        let bodyText = """
        Path: /Users/dev/agnt/AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift
        Kind: update
        Totals: +1 -0

        `@agnt``diff
        @@ -1,3 +1,4 @@
        +let firstChange = true
        `@agnt``

        Path: AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift
        Kind: update
        Totals: +1 -0

        `@agnt``diff
        @@ -10,3 +10,4 @@
        +let secondChange = true
        `@agnt``
        """
        let entries = [
            TurnFileChangeSummaryEntry(
                path: "/Users/dev/agnt/AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift",
                additions: 1,
                deletions: 0,
                action: .edited
            ),
            TurnFileChangeSummaryEntry(
                path: "AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift",
                additions: 1,
                deletions: 0,
                action: .edited
            ),
        ]

        let chunks = PerFileDiffParser.parse(bodyText: bodyText, entries: entries)

        XCTAssertEqual(chunks.count, 1)
        XCTAssertEqual(chunks.first?.path, "AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift")
        XCTAssertEqual(chunks.first?.additions, 2)
        XCTAssertTrue(chunks.first?.diffCode.contains("firstChange") == true)
        XCTAssertTrue(chunks.first?.diffCode.contains("secondChange") == true)
    }

    func testPerFileDiffParserDeduplicatesIdenticalSnapshotsForSameFile() {
        let bodyText = """
        Path: /Users/dev/agnt/AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift
        Kind: update
        Totals: +1 -0

        `@agnt``diff
        @@ -1,3 +1,4 @@
        +let duplicateChange = true
        `@agnt``

        Path: AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift
        Kind: update
        Totals: +1 -0

        `@agnt``diff
        @@ -1,3 +1,4 @@
        +let duplicateChange = true
        `@agnt``
        """
        let entries = [
            TurnFileChangeSummaryEntry(
                path: "/Users/dev/agnt/AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift",
                additions: 1,
                deletions: 0,
                action: .edited
            ),
            TurnFileChangeSummaryEntry(
                path: "AgntMobile/AgntMobile/Views/Turn/TurnMessageComponents.swift",
                additions: 1,
                deletions: 0,
                action: .edited
            ),
        ]

        let chunks = PerFileDiffParser.parse(bodyText: bodyText, entries: entries)

        XCTAssertEqual(chunks.count, 1)
        XCTAssertEqual(chunks.first?.additions, 1)
        XCTAssertEqual(chunks.first?.deletions, 0)
    }
}
