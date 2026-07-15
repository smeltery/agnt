// FILE: TurnMessageCachesTestSupport.swift
// Purpose: Shared fixtures for turn message cache tests.
// Layer: Unit Test Support
// Exports: TurnMessageCachesTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
class TurnMessageCachesTestCase: XCTestCase {
    override func tearDown() {
        TurnCacheManager.resetAll()
        super.tearDown()
    }

    func fileChangeText(path: String) -> String {
        """
        Status: completed

        Path: \(path)
        Kind: update
        Totals: +1 -0
        """
    }

    func makeFileChangeEntries(count: Int) -> [TurnFileChangeSummaryEntry] {
        (1...count).map { index in
            TurnFileChangeSummaryEntry(
                path: "Sources/File\(index).swift",
                additions: index,
                deletions: 0,
                action: .edited
            )
        }
    }
}
