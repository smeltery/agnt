// FILE: TurnMessageCachesTests.swift
// Purpose: Guards cache keys against equal-length collisions so scrolling optimizations stay correct.
// Layer: Unit Test
// Exports: TurnMessageCachesTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class TurnMessageCachesTests: TurnMessageCachesTestCase {
    override func tearDown() {
        TurnCacheManager.resetAll()
        super.tearDown()
    }

    func testMarkdownRenderableTextCacheSeparatesEqualLengthTexts() {
        var buildCount = 0

        let first = MarkdownRenderableTextCache.rendered(raw: "alpha", profile: .assistantProse) {
            buildCount += 1
            return "first"
        }
        let second = MarkdownRenderableTextCache.rendered(raw: "omega", profile: .assistantProse) {
            buildCount += 1
            return "second"
        }
        let firstAgain = MarkdownRenderableTextCache.rendered(raw: "alpha", profile: .assistantProse) {
            buildCount += 1
            return "unexpected"
        }

        XCTAssertEqual(first, "first")
        XCTAssertEqual(second, "second")
        XCTAssertEqual(firstAgain, "first")
        XCTAssertEqual(buildCount, 2)
    }

    func testMarkdownFormatterKeepsFencedCodeVerbatim() {
        let raw = """
        # Steps

        ```bash
        # install deps
        npm install
        ```
        """

        let rendered = MarkdownTextFormatter.renderableText(
            from: raw,
            profile: .assistantProse,
            usesCache: false
        )

        XCTAssertTrue(rendered.hasPrefix("**Steps**"))
        XCTAssertTrue(rendered.contains("# install deps"))
        XCTAssertFalse(rendered.contains("**install deps**"))
    }

    func testMarkdownFormatterKeepsTildeFencedCodeVerbatim() {
        let raw = """
        # Steps

        ~~~bash
        # install deps
        npm install
        ~~~
        """

        let rendered = MarkdownTextFormatter.renderableText(
            from: raw,
            profile: .userProse,
            usesCache: false
        )

        XCTAssertTrue(rendered.hasPrefix("**Steps**"))
        XCTAssertTrue(rendered.contains("# install deps"))
        XCTAssertFalse(rendered.contains("**install deps**"))
    }

    func testFileChangeSummaryPreviewCapsLargeLists() {
        let entries = makeFileChangeEntries(count: 5)

        let visibleEntries = FileChangeSummaryPreview.visibleEntries(
            from: entries,
            showsAllEntries: false
        )

        XCTAssertEqual(visibleEntries.map(\.path), [
            "Sources/File1.swift",
            "Sources/File2.swift",
            "Sources/File3.swift",
        ])
        XCTAssertEqual(
            FileChangeSummaryPreview.hiddenEntryCount(
                totalEntryCount: entries.count,
                showsAllEntries: false
            ),
            2
        )
    }

    func testFileChangeSummaryPreviewShowsAllEntriesWhenExpanded() {
        let entries = makeFileChangeEntries(count: 5)

        let visibleEntries = FileChangeSummaryPreview.visibleEntries(
            from: entries,
            showsAllEntries: true
        )

        XCTAssertEqual(visibleEntries.map(\.path), entries.map(\.path))
        XCTAssertEqual(
            FileChangeSummaryPreview.hiddenEntryCount(
                totalEntryCount: entries.count,
                showsAllEntries: true
            ),
            0
        )
    }

    func testMarkdownFormatterUserProseSkipsFilePathLinkification() {
        let rendered = MarkdownTextFormatter.renderableText(
            from: "please check `agnt-bridge/test/secure-transport.test.js` again",
            profile: .userProse,
            usesCache: false
        )

        XCTAssertEqual(rendered, "please check `agnt-bridge/test/secure-transport.test.js` again")
    }

    func testStableTextFingerprintChangesForUnsampledTextEdits() {
        let prefix = String(repeating: "a", count: 48)
        let suffix = String(repeating: "z", count: 48)
        let first = "\(prefix)middle-one\(suffix)"
        let second = "\(prefix)middle-two\(suffix)"

        XCTAssertNotEqual(
            TurnTextCacheKey.stableFingerprint(for: first),
            TurnTextCacheKey.stableFingerprint(for: second)
        )
    }

    func testMessageRowRenderModelCacheSeparatesEqualLengthCommandTexts() {
        let runningMessage = CodexMessage(
            id: "message-row-cache",
            threadId: "thread-1",
            role: .system,
            kind: .commandExecution,
            text: ""
        )
        let stoppedMessage = CodexMessage(
            id: "message-row-cache",
            threadId: "thread-1",
            role: .system,
            kind: .commandExecution,
            text: ""
        )

        let running = MessageRowRenderModelCache.model(for: runningMessage, displayText: "Running npm")
        let stopped = MessageRowRenderModelCache.model(for: stoppedMessage, displayText: "Stopped npm")

        XCTAssertEqual(running.commandStatus?.statusLabel, "running")
        XCTAssertEqual(stopped.commandStatus?.statusLabel, "stopped")
    }

    func testCommandExecutionStatusCacheSeparatesEqualLengthTexts() {
        let running = CommandExecutionStatusCache.status(messageID: "command-cache", text: "Running npm")
        let stopped = CommandExecutionStatusCache.status(messageID: "command-cache", text: "Stopped npm")

        XCTAssertEqual(running?.statusLabel, "running")
        XCTAssertEqual(stopped?.statusLabel, "stopped")
    }

    func testFileChangeRenderCacheSeparatesEqualLengthTexts() {
        let first = FileChangeSystemRenderCache.renderState(
            messageID: "file-change-cache",
            sourceText: fileChangeText(path: "A.swift")
        )
        let second = FileChangeSystemRenderCache.renderState(
            messageID: "file-change-cache",
            sourceText: fileChangeText(path: "B.swift")
        )

        XCTAssertEqual(first.summary?.entries.first?.path, "A.swift")
        XCTAssertEqual(second.summary?.entries.first?.path, "B.swift")
    }

    func testFileChangeSummaryParserPrefersInlineTotalsWhenTheyFollowDiffBlock() {
        let text = """
        Status: completed

        Path: Sources/App.swift
        Kind: update

        `@agnt``diff
        @@ -1,3 +1,4 @@
        +let diffBackedFile = true
        `@agnt``

        Totals: +3 -1
        """

        let summary = TurnFileChangeSummaryParser.parse(from: text)

        XCTAssertEqual(summary?.entries.count, 1)
        XCTAssertEqual(summary?.entries.first?.path, "Sources/App.swift")
        XCTAssertEqual(summary?.entries.first?.additions, 3)
        XCTAssertEqual(summary?.entries.first?.deletions, 1)
    }

    func testFileChangeSummaryParserDoesNotDuplicateRepeatedPathWithoutNewEvidence() {
        let text = """
        Status: completed

        Path: Sources/App.swift
        Kind: update

        Path: Sources/App.swift
        Totals: +10 -3
        """

        let summary = TurnFileChangeSummaryParser.parse(from: text)

        XCTAssertEqual(summary?.entries.count, 1)
        XCTAssertEqual(summary?.entries.first?.path, "Sources/App.swift")
        XCTAssertEqual(summary?.entries.first?.additions, 10)
        XCTAssertEqual(summary?.entries.first?.deletions, 3)
    }

}
