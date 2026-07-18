// FILE: TurnComposerSendAvailabilityTests.swift
// Purpose: Locks send-button enable/disable truth table after composer refactor.
// Layer: Unit Test
// Exports: TurnComposerSendAvailabilityTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class TurnComposerSendAvailabilityTests: TurnComposerSendTestCase {
    func testSendDisabledWhenDisconnected() {
        let state = makeState(isConnected: false)
        XCTAssertTrue(state.isSendDisabled)
    }

    func testSendDisabledWhenSendingInFlight() {
        let state = makeState(isSending: true)
        XCTAssertTrue(state.isSendDisabled)
    }

    func testSendEnabledWhenActiveTurnExistsAndPayloadIsValid() {
        let state = makeState(trimmedInput: "queue this")
        XCTAssertFalse(state.isSendDisabled)
    }

    func testSendDisabledWhenInputAndImagesAreEmpty() {
        let state = makeState(trimmedInput: "", hasReadyImages: false)
        XCTAssertTrue(state.isSendDisabled)
    }

    func testSendDisabledWhenAttachmentStateIsBlocking() {
        let state = makeState(hasBlockingAttachmentState: true)
        XCTAssertTrue(state.isSendDisabled)
    }

    func testSendEnabledWhenConnectedAndPayloadIsValid() {
        let textState = makeState(trimmedInput: "Ship it", hasReadyImages: false)
        XCTAssertFalse(textState.isSendDisabled)

        let imageState = makeState(trimmedInput: "", hasReadyImages: true)
        XCTAssertFalse(imageState.isSendDisabled)
    }

    func testSendEnabledWhenReviewSelectionIsPresentWithoutText() {
        let reviewState = makeState(trimmedInput: "", hasReadyImages: false, hasReviewSelection: true)
        XCTAssertFalse(reviewState.isSendDisabled)
    }

    func testSendEnabledWhenSubagentsSelectionIsPresentWithoutText() {
        let subagentsState = makeState(trimmedInput: "", hasReadyImages: false, hasSubagentsSelection: true)
        XCTAssertFalse(subagentsState.isSendDisabled)
    }

    func testSendEnabledWhenOnlyStructuredMentionIsSelected() {
        let skillState = makeState(trimmedInput: "", hasReadyImages: false, hasSkillSelection: true)
        XCTAssertFalse(skillState.isSendDisabled)

        let pluginState = makeState(trimmedInput: "", hasReadyImages: false, hasPluginSelection: true)
        XCTAssertFalse(pluginState.isSendDisabled)
    }

    func testSendDisabledWhileReviewSelectionIsWaitingForTarget() {
        let reviewState = makeState(
            trimmedInput: "follow up",
            hasReadyImages: false,
            hasReviewSelection: false,
            hasPendingReviewSelection: true
        )
        XCTAssertTrue(reviewState.isSendDisabled)
    }

    func testRunningComposerSendButtonContentPredicate() {
        XCTAssertFalse(makeAccessoryState().hasSendableContent(input: ""))
        XCTAssertFalse(makeAccessoryState().hasSendableContent(input: "   "))

        XCTAssertTrue(makeAccessoryState().hasSendableContent(input: "follow up"))
        XCTAssertTrue(makeAccessoryState(hasAttachment: true).hasSendableContent(input: ""))
        XCTAssertTrue(makeAccessoryState(hasSkillSelection: true).hasSendableContent(input: ""))
    }
}
