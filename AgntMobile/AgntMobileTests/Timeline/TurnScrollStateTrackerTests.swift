// FILE: TurnScrollStateTrackerTests.swift
// Purpose: Verifies timeline scroll state tracking.
// Layer: Unit Test
// Exports: TurnScrollStateTrackerTests
// Depends on: XCTest, SwiftUI, AgntMobile

import XCTest
import SwiftUI
@testable import AgntMobile

final class TurnScrollStateTrackerTests: XCTestCase {
func testScrollTrackerPausesAutomaticScrollingDuringUserDrag() {
    XCTAssertTrue(
        TurnScrollStateTracker.isAutomaticScrollingPaused(
            isUserDragging: true,
            cooldownUntil: nil,
            now: Date()
        )
    )
}

func testScrollTrackerPausesAutomaticScrollingDuringCooldown() {
    let now = Date()

    XCTAssertTrue(
        TurnScrollStateTracker.isAutomaticScrollingPaused(
            isUserDragging: false,
            cooldownUntil: now.addingTimeInterval(0.1),
            now: now
        )
    )
    XCTAssertFalse(
        TurnScrollStateTracker.isAutomaticScrollingPaused(
            isUserDragging: false,
            cooldownUntil: now.addingTimeInterval(-0.1),
            now: now
        )
    )
}

func testScrollTrackerBuildsCooldownDeadlineInFuture() {
    let now = Date()
    let deadline = TurnScrollStateTracker.cooldownDeadline(after: now)

    XCTAssertGreaterThan(deadline.timeIntervalSince(now), 0)
}

func testUserDragImmediatelySwitchesFollowBottomToManual() {
    XCTAssertEqual(
        TurnScrollStateTracker.modeAfterUserDragBegan(currentMode: .followBottom),
        .manual
    )
}

func testUserDragKeepsAssistantAnchorModeUntilAnchorCompletes() {
    XCTAssertEqual(
        TurnScrollStateTracker.modeAfterUserDragBegan(currentMode: .anchorAssistantResponse),
        .anchorAssistantResponse
    )
}

func testUserDragEndingAtBottomRestoresFollowBottom() {
    XCTAssertEqual(
        TurnScrollStateTracker.modeAfterUserDragEnded(
            currentMode: .manual,
            isScrolledToBottom: true
        ),
        .followBottom
    )
}

func testUserDragEndingAwayFromBottomKeepsManualMode() {
    XCTAssertEqual(
        TurnScrollStateTracker.modeAfterUserDragEnded(
            currentMode: .manual,
            isScrolledToBottom: false
        ),
        .manual
    )
}

func testCorrectsBottomForMeaningfulContentGrowthWhenPinned() {
    XCTAssertTrue(
        TurnScrollStateTracker.shouldCorrectBottomAfterContentHeightChange(
            previousHeight: 320,
            newHeight: 356,
            isPinnedToBottom: true
        )
    )
}

func testCorrectsBottomForMeaningfulContentShrinkWhenPinned() {
    XCTAssertTrue(
        TurnScrollStateTracker.shouldCorrectBottomAfterContentHeightChange(
            previousHeight: 356,
            newHeight: 320,
            isPinnedToBottom: true
        )
    )
}

func testIgnoresTinyHeightDriftAndManualMode() {
    XCTAssertFalse(
        TurnScrollStateTracker.shouldCorrectBottomAfterContentHeightChange(
            previousHeight: 320,
            newHeight: 320.5,
            isPinnedToBottom: true
        )
    )

    XCTAssertFalse(
        TurnScrollStateTracker.shouldCorrectBottomAfterContentHeightChange(
            previousHeight: 356,
            newHeight: 320,
            isPinnedToBottom: false
        )
    )
}

func testFollowBottomKeepsPinnedAcrossTransientGeometryDrift() {
    XCTAssertTrue(
        TurnScrollStateTracker.shouldPinDuringGeometryChange(
            currentMode: .followBottom,
            isAutomaticScrollingPaused: false
        )
    )
}

func testIgnoresTransientNotBottomOnlyWhileFollowSnapIsPending() {
    XCTAssertTrue(
        TurnScrollStateTracker.shouldIgnoreTransientNotBottomGeometry(
            currentMode: .followBottom,
            hasPendingFollowBottomScroll: true,
            isAutomaticScrollingPaused: false
        )
    )

    XCTAssertFalse(
        TurnScrollStateTracker.shouldIgnoreTransientNotBottomGeometry(
            currentMode: .followBottom,
            hasPendingFollowBottomScroll: false,
            isAutomaticScrollingPaused: false
        )
    )

    XCTAssertFalse(
        TurnScrollStateTracker.shouldIgnoreTransientNotBottomGeometry(
            currentMode: .followBottom,
            hasPendingFollowBottomScroll: true,
            isAutomaticScrollingPaused: true
        )
    )
}

func testAcceptedNotBottomGeometrySwitchesFollowBottomToManual() {
    XCTAssertEqual(
        TurnScrollStateTracker.modeAfterAcceptedNotBottomGeometry(currentMode: .followBottom),
        .manual
    )

    XCTAssertEqual(
        TurnScrollStateTracker.modeAfterAcceptedNotBottomGeometry(currentMode: .manual),
        .manual
    )

    XCTAssertEqual(
        TurnScrollStateTracker.modeAfterAcceptedNotBottomGeometry(currentMode: .anchorAssistantResponse),
        .anchorAssistantResponse
    )
}

func testManualAndPausedModesDoNotPinDuringGeometryChange() {
    XCTAssertFalse(
        TurnScrollStateTracker.shouldPinDuringGeometryChange(
            currentMode: .manual,
            isAutomaticScrollingPaused: false
        )
    )

    XCTAssertFalse(
        TurnScrollStateTracker.shouldPinDuringGeometryChange(
            currentMode: .followBottom,
            isAutomaticScrollingPaused: true
        )
    )
}

func testAssistantAnchorDoesNotBottomPinWhileWaitingForAssistantTarget() {
    XCTAssertFalse(
        TurnScrollStateTracker.shouldPinDuringGeometryChange(
            currentMode: .anchorAssistantResponse,
            isAutomaticScrollingPaused: false
        )
    )

    XCTAssertFalse(
        TurnScrollStateTracker.shouldPinDuringGeometryChange(
            currentMode: .anchorAssistantResponse,
            isAutomaticScrollingPaused: true
        )
    )
}
}
