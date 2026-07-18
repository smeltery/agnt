// FILE: CodexPlanModeQuestionnaireTests.swift
// Purpose: Verifies plan-mode fallback questionnaire and proposed-plan parsing behavior.
// Layer: Unit Test
// Exports: CodexPlanModeQuestionnaireTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexPlanModeQuestionnaireTests: CodexPlanModeTestCase {
    func testAssistantFallbackQuestionnaireWithoutCueStillParses() {
        let text = """
        1. Which rollout path should we take?
        - Ship it now
        - Stage it behind a flag

        2. Which validation level do you want?
        - Smoke test only
        - Add focused regression coverage
        """

        let questionnaire = InferredPlanQuestionnaireParser.parseAssistantMessage(text)

        XCTAssertEqual(questionnaire?.questions.count, 2)
        XCTAssertEqual(
            questionnaire?.questions.first?.options.map(\.label),
            ["Ship it now", "Stage it behind a flag"]
        )
    }

    func testAssistantFallbackQuestionnaireWithMarkdownNumberingParses() {
        let text = """
        A few quick questions before I finalize the plan:

        **1. Which rollout path should we take?**
        - Ship it now
        - Stage it behind a flag
        """

        let questionnaire = InferredPlanQuestionnaireParser.parseAssistantMessage(text)

        XCTAssertEqual(questionnaire?.questions.count, 1)
        XCTAssertEqual(questionnaire?.questions.first?.question, "Which rollout path should we take?")
        XCTAssertEqual(
            questionnaire?.questions.first?.options.map(\.label),
            ["Ship it now", "Stage it behind a flag"]
        )
    }

    func testAssistantFallbackChoiceListParsesIntoSingleQuestion() {
        let text = """
        My strongest recommendation is to focus on trust first.

        If you want, next I can turn this into one of these:

        1. a prioritized roadmap for the next 2-4 weeks
        2. a feature matrix with quick wins vs bigger bets
        3. a concrete implementation plan mapped to the current codebase
        """

        let questionnaire = InferredPlanQuestionnaireParser.parseAssistantMessage(text)

        XCTAssertEqual(questionnaire?.questions.count, 1)
        XCTAssertEqual(questionnaire?.questions.first?.header, "Next step")
        XCTAssertEqual(questionnaire?.questions.first?.question, "What should Codex produce next?")
        XCTAssertEqual(
            questionnaire?.questions.first?.options.map(\.label),
            [
                "a prioritized roadmap for the next 2-4 weeks",
                "a feature matrix with quick wins vs bigger bets",
                "a concrete implementation plan mapped to the current codebase",
            ]
        )
    }

    func testResolvedFallbackChoiceListStillAppearsAfterNativeThreadDegradesToPlainText() {
        let assistantMessage = CodexMessage(
            threadId: "thread-plan",
            role: .assistant,
            text: """
            Suggested Roadmap If we wanted a practical sequence, I'd do:

            1. Polish onboarding and first-run UX
            2. Improve status clarity and calibration experience
            3. Expand actions beyond open app

            If you want, next I can turn this into one of these:

            1. a concrete 2-week roadmap
            2. a feature-priority matrix
            3. a "v1 vs v2" product strategy doc
            """,
            turnId: "turn-plan",
            orderIndex: 3
        )

        let questionnaire = resolvedInferredPlanQuestionnaire(
            bodyText: assistantMessage.text,
            message: assistantMessage,
            threadMessages: [assistantMessage],
            parse: InferredPlanQuestionnaireParser.parseAssistantMessage
        )

        XCTAssertEqual(questionnaire?.questions.count, 1)
        XCTAssertEqual(questionnaire?.questions.first?.header, "Next step")
        XCTAssertEqual(
            questionnaire?.questions.first?.options.map(\CodexStructuredUserInputOption.label),
            [
                "a concrete 2-week roadmap",
                "a feature-priority matrix",
                "a \"v1 vs v2\" product strategy doc",
            ]
        )
    }

    func testResolvedFallbackChoiceListDoesNotAppearOutsidePlanModeSession() {
        let assistantMessage = CodexMessage(
            threadId: "thread-default",
            role: .assistant,
            text: """
            If you want, next I can turn this into one of these:

            1. a concrete 2-week roadmap
            2. a feature-priority matrix
            3. a "v1 vs v2" product strategy doc
            """,
            turnId: "turn-default",
            orderIndex: 3
        )

        let questionnaire = resolvedInferredPlanQuestionnaire(
            bodyText: assistantMessage.text,
            message: assistantMessage,
            threadMessages: [assistantMessage],
            shouldRecoverFallback: false,
            parse: InferredPlanQuestionnaireParser.parseAssistantMessage
        )

        XCTAssertNil(questionnaire)
    }

    func testResolvedFallbackChoiceListDoesNotAppearAfterNativePlanSessionIsConfirmed() {
        let service = makeService()
        service.markNativePlanSession(for: "thread-native")

        let assistantMessage = CodexMessage(
            threadId: "thread-native",
            role: .assistant,
            text: """
            If you want, next I can turn this into one of these:

            1. a concrete 2-week roadmap
            2. a feature-priority matrix
            3. a "v1 vs v2" product strategy doc
            """,
            turnId: "turn-native",
            orderIndex: 3
        )

        let questionnaire = resolvedInferredPlanQuestionnaire(
            bodyText: assistantMessage.text,
            message: assistantMessage,
            threadMessages: [assistantMessage],
            shouldRecoverFallback: service.allowsAssistantPlanFallbackRecovery(for: "thread-native"),
            parse: InferredPlanQuestionnaireParser.parseAssistantMessage
        )

        XCTAssertNil(questionnaire)
    }

    func testProposedPlanParserExtractsBodyAndRemovesEnvelope() {
        let rawText = """
        I explored the current flow and here is the final plan.

        <proposed_plan>
        ## Summary
        - Make native structured questions the primary path.
        - Render final plan blocks with an implementation action.
        </proposed_plan>
        """

        let proposedPlan = CodexProposedPlanParser.parse(from: rawText)

        XCTAssertEqual(
            proposedPlan?.body,
            """
            ## Summary
            - Make native structured questions the primary path.
            - Render final plan blocks with an implementation action.
            """
        )
        XCTAssertEqual(
            CodexProposedPlanParser.removingEnvelope(from: rawText),
            "I explored the current flow and here is the final plan."
        )
        XCTAssertEqual(
            proposedPlan?.summary,
            "Summary"
        )
    }

    func testImplementProposedPlanUsesMinimalThreadReferencePrompt() async throws {
        let service = makeService()
        service.isConnected = true
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")

        var capturedParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            capturedParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-live")]),
                includeJSONRPC: false
            )
        }

        try await service.implementProposedPlan(
            threadId: "thread-plan",
            proposedPlan: CodexProposedPlan(
                body: """
                ## Summary
                - Make Plan Mode native-first.
                """
            )
        )

        XCTAssertEqual(
            textInput(from: capturedParams),
            "Implement the latest approved plan from the most recent <proposed_plan> in this thread."
        )
    }
}
