// FILE: StreamingUIInteractionMonitorTests.swift
// Purpose: Guards the interaction backoff signals used by streaming timeline flushes.
// Layer: Unit Test
// Exports: StreamingUIInteractionMonitorTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class StreamingUIInteractionMonitorTests: XCTestCase {
    override func tearDown() {
        StreamingUIInteractionMonitor.setScrollInteractionActive(false)
        StreamingUIInteractionMonitor.noteComposerKeystroke(now: Date(timeIntervalSince1970: 0))
        super.tearDown()
    }

    func testScrollInteractionKeepsMonitorActiveUntilCleared() {
        StreamingUIInteractionMonitor.noteComposerKeystroke(now: Date(timeIntervalSince1970: 0))

        StreamingUIInteractionMonitor.setScrollInteractionActive(true)
        XCTAssertTrue(StreamingUIInteractionMonitor.isInteractionActive(now: Date(timeIntervalSince1970: 10)))

        StreamingUIInteractionMonitor.setScrollInteractionActive(false)
        XCTAssertFalse(StreamingUIInteractionMonitor.isInteractionActive(now: Date(timeIntervalSince1970: 10)))
    }

    func testComposerKeystrokeStaysActiveForShortWindow() {
        let start = Date(timeIntervalSince1970: 100)
        StreamingUIInteractionMonitor.setScrollInteractionActive(false)
        StreamingUIInteractionMonitor.noteComposerKeystroke(now: start)

        XCTAssertTrue(StreamingUIInteractionMonitor.isInteractionActive(now: start.addingTimeInterval(0.25)))
        XCTAssertFalse(StreamingUIInteractionMonitor.isInteractionActive(now: start.addingTimeInterval(1.0)))
    }
}
