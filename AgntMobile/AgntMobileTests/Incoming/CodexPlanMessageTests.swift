// FILE: CodexPlanMessageTests.swift
// Purpose: Verifies plan history decoding and plan message display state.
// Layer: Unit Test
// Exports: CodexPlanMessageTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexPlanMessageTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testHistoryPlanItemsRestoreStructuredState() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"

        let messages = service.decodeMessagesFromThreadRead(
            threadId: threadID,
            threadObject: [
                "createdAt": .double(1_700_000_000),
                "turns": .array([
                    .object([
                        "id": .string(turnID),
                        "items": .array([
                            .object([
                                "id": .string(itemID),
                                "type": .string("plan"),
                                "content": .array([
                                    .object([
                                        "type": .string("text"),
                                        "text": .string("1. Audit\n2. Implement\n3. Verify"),
                                    ]),
                                ]),
                                "explanation": .string("Break the work into safe slices."),
                                "plan": .array([
                                    .object([
                                        "step": .string("Audit"),
                                        "status": .string("completed"),
                                    ]),
                                    .object([
                                        "step": .string("Implement"),
                                        "status": .string("inProgress"),
                                    ]),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
            ]
        )

        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].kind, .plan)
        XCTAssertEqual(messages[0].text, "1. Audit\n2. Implement\n3. Verify")
        XCTAssertEqual(messages[0].planState?.explanation, "Break the work into safe slices.")
        XCTAssertEqual(messages[0].planState?.steps.count, 2)
        XCTAssertEqual(messages[0].planState?.steps.last?.status, .inProgress)
    }

    func testCompletedHistoryTurnFinalizesPlanSteps() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"

        let messages = service.decodeMessagesFromThreadRead(
            threadId: threadID,
            threadObject: [
                "createdAt": .double(1_700_000_000),
                "turns": .array([
                    .object([
                        "id": .string(turnID),
                        "status": .string("completed"),
                        "items": .array([
                            .object([
                                "id": .string(itemID),
                                "type": .string("plan"),
                                "content": .array([
                                    .object([
                                        "type": .string("text"),
                                        "text": .string("1. Audit\n2. Implement\n3. Verify"),
                                    ]),
                                ]),
                                "explanation": .string("Break the work into safe slices."),
                                "plan": .array([
                                    .object([
                                        "step": .string("Audit"),
                                        "status": .string("completed"),
                                    ]),
                                    .object([
                                        "step": .string("Implement"),
                                        "status": .string("in_progress"),
                                    ]),
                                    .object([
                                        "step": .string("Verify"),
                                        "status": .string("pending"),
                                    ]),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
            ]
        )

        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].planState?.steps.map(\.status), [.completed, .completed, .completed])
        XCTAssertFalse(messages[0].shouldDisplayPinnedPlanAccessory)
    }

    func testCompletedPlanDoesNotStayPinnedInConversationAccessory() {
        let completedPlan = CodexMessage(
            threadId: "thread-\(UUID().uuidString)",
            role: .system,
            kind: .plan,
            text: "All steps are done.",
            isStreaming: false,
            planState: CodexPlanState(
                explanation: "The plan finished successfully.",
                steps: [
                    CodexPlanStep(step: "Inspect the current behavior", status: .completed),
                    CodexPlanStep(step: "Implement the fix", status: .completed),
                    CodexPlanStep(step: "Verify the result", status: .completed),
                ]
            )
        )

        XCTAssertTrue(completedPlan.isPlanSystemMessage)
        XCTAssertFalse(completedPlan.shouldDisplayPinnedPlanAccessory)
        XCTAssertFalse(completedPlan.shouldDisplayInlinePlanResult)
    }

    func testIncompletePlanRemainsPinnedInConversationAccessory() {
        let activePlan = CodexMessage(
            threadId: "thread-\(UUID().uuidString)",
            role: .system,
            kind: .plan,
            text: "Working through the plan.",
            isStreaming: false,
            planState: CodexPlanState(
                explanation: "The plan is still active.",
                steps: [
                    CodexPlanStep(step: "Inspect the current behavior", status: .completed),
                    CodexPlanStep(step: "Implement the fix", status: .inProgress),
                    CodexPlanStep(step: "Verify the result", status: .pending),
                ]
            )
        )

        XCTAssertTrue(activePlan.shouldDisplayPinnedPlanAccessory)
    }

    func testCompletedSystemPlanWithEmbeddedProposedPlanDoesNotMasqueradeAsFinalPlan() {
        let completedPlan = CodexMessage(
            threadId: "thread-\(UUID().uuidString)",
            role: .system,
            kind: .plan,
            text: """
            <proposed_plan>
            ## Ship
            - Tighten native Plan Mode first.
            </proposed_plan>
            """,
            isStreaming: false,
            planState: CodexPlanState(
                explanation: "The plan is finalized.",
                steps: [
                    CodexPlanStep(step: "Inspect the current behavior", status: .completed),
                    CodexPlanStep(step: "Implement the fix", status: .completed),
                ]
            )
        )

        XCTAssertFalse(completedPlan.shouldDisplayInlinePlanResult)
        XCTAssertNil(completedPlan.proposedPlan)
    }

    func testAssistantProposedPlanStaysSeparateFromSystemStepPlan() {
        let finalAssistantPlan = CodexMessage(
            threadId: "thread-\(UUID().uuidString)",
            role: .assistant,
            text: """
            <proposed_plan>
            ## Ship
            - Tighten native Plan Mode first.
            </proposed_plan>
            """,
            isStreaming: false
        )

        XCTAssertEqual(finalAssistantPlan.proposedPlan?.summary, "Ship")
    }

    private func makeService() -> CodexService {
        let suiteName = "CodexPlanMessageTests.(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        // CodexService currently crashes while deallocating in unit-test environment.
        // Keep instances alive for the process lifetime so assertions can run deterministically.
        Self.retainedServices.append(service)
        return service
    }
}
