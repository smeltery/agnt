// FILE: CodexPlanModeTimelineTests.swift
// Purpose: Verifies plan-mode timeline notification state.
// Layer: Unit Test
// Exports: CodexPlanModeTimelineTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexPlanModeTimelineTests: CodexPlanModeTestCase {
    func testTurnPlanNotificationsKeepStructuredStateAndFinalText() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/plan/updated",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "explanation": .string("We should break the work into safe slices."),
                "plan": .array([
                    .object([
                        "step": .string("Audit the current flow"),
                        "status": .string("completed"),
                    ]),
                    .object([
                        "step": .string("Implement the UI toggle"),
                        "status": .string("inProgress"),
                    ]),
                ]),
            ])
        )

        service.handleNotification(
            method: "item/plan/delta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string("1. Audit the current flow\n2. Implement the UI toggle"),
            ])
        )

        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("plan"),
                    "content": .array([
                        .object([
                            "type": .string("text"),
                            "text": .string("1. Audit the current flow\n2. Implement the UI toggle\n3. Add tests"),
                        ]),
                    ]),
                ]),
            ])
        )

        let planMessages = service.messages(for: threadID).filter { $0.kind == .plan }
        XCTAssertEqual(planMessages.count, 1)
        XCTAssertEqual(planMessages[0].text, "1. Audit the current flow\n2. Implement the UI toggle\n3. Add tests")
        XCTAssertEqual(planMessages[0].planState?.explanation, "We should break the work into safe slices.")
        XCTAssertEqual(planMessages[0].planState?.steps.count, 2)
        XCTAssertEqual(planMessages[0].planState?.steps[0].status, .completed)
        XCTAssertEqual(planMessages[0].planState?.steps[1].status, .inProgress)
    }

    func testEmptyPlanUpdatesDoNotCreateOrClearPlanMessages() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/plan/updated",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "plan": .array([]),
            ])
        )

        XCTAssertTrue(service.messages(for: threadID).filter { $0.kind == .plan }.isEmpty)

        service.handleNotification(
            method: "turn/plan/updated",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "explanation": .string("Keep the meaningful plan visible."),
                "plan": .array([]),
            ])
        )

        service.handleNotification(
            method: "turn/plan/updated",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "plan": .array([]),
            ])
        )

        let planMessages = service.messages(for: threadID).filter { $0.kind == .plan }
        XCTAssertEqual(planMessages.count, 1)
        XCTAssertEqual(planMessages[0].planState?.explanation, "Keep the meaningful plan visible.")
    }

    func testEmptyCompletedPlanItemFinalizesExistingStreamWithoutPlaceholder() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/plan/delta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(itemID),
                "delta": .string("1. Keep the streamed plan text"),
            ])
        )

        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(itemID),
                    "type": .string("plan"),
                    "content": .array([]),
                ]),
            ])
        )

        let planMessages = service.messages(for: threadID).filter { $0.kind == .plan }
        XCTAssertEqual(planMessages.count, 1)
        XCTAssertEqual(planMessages[0].text, "1. Keep the streamed plan text")
        XCTAssertFalse(planMessages[0].isStreaming)
    }

    func testTurnPlanUpdatedWithoutThreadIDUsesTurnMapping() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )

        service.handleNotification(
            method: "turn/plan/updated",
            params: .object([
                "turnId": .string(turnID),
                "explanation": .string("Use the stored turn mapping when threadId is omitted."),
                "plan": .array([
                    .object([
                        "step": .string("Keep the clarification UI native"),
                        "status": .string("inProgress"),
                    ]),
                ]),
            ])
        )

        let planMessages = service.messages(for: threadID).filter { $0.kind == .plan }
        XCTAssertEqual(planMessages.count, 1)
        XCTAssertEqual(planMessages[0].planState?.steps.first?.status, .inProgress)
    }
}
