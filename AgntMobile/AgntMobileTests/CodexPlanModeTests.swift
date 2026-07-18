// FILE: CodexPlanModeTests.swift
// Purpose: Verifies plan-mode turn payloads and session state.
// Layer: Unit Test
// Exports: CodexPlanModeTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexPlanModeTests: CodexPlanModeTestCase {
    func testSendTurnUsesPlanModeOnceAndThenResets() async {
        let service = makeService()
        service.isConnected = true
        service.supportsTurnCollaborationMode = true
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")

        var capturedTurnStartParams: [JSONValue] = []
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            capturedTurnStartParams.append(params ?? .null)
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-live")]),
                includeJSONRPC: false
            )
        }

        let viewModel = makeViewModel()
        viewModel.input = "Plan this refactor"
        viewModel.setPlanModeArmed(true)
        viewModel.sendTurn(codex: service, threadID: "thread-plan")
        await waitForSendCompletion(viewModel)

        XCTAssertFalse(viewModel.isPlanModeArmed)
        XCTAssertEqual(capturedTurnStartParams.count, 1)
        XCTAssertEqual(
            capturedTurnStartParams[0].objectValue?["collaborationMode"]?.objectValue?["mode"]?.stringValue,
            "plan"
        )
        XCTAssertNil(
            capturedTurnStartParams[0]
                .objectValue?["collaborationMode"]?
                .objectValue?["settings"]?
                .objectValue?["developer_instructions"]?
                .stringValue
        )
        XCTAssertEqual(
            capturedTurnStartParams[0].objectValue?["model"]?.stringValue,
            "gpt-5-codex"
        )
        XCTAssertEqual(
            capturedTurnStartParams[0].objectValue?["effort"]?.stringValue,
            "medium"
        )

        viewModel.input = "Normal follow-up"
        viewModel.sendTurn(codex: service, threadID: "thread-plan")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(capturedTurnStartParams.count, 2)
        XCTAssertEqual(
            capturedTurnStartParams[1].objectValue?["collaborationMode"]?.objectValue?["mode"]?.stringValue,
            CodexCollaborationModeKind.default.rawValue
        )
    }

    func testBuildCollaborationModePayloadUsesBuiltInPlanInstructionsByDefault() throws {
        let service = makeService()
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")

        let payload = try service.buildCollaborationModePayload(
            for: .plan,
            threadId: "thread-plan"
        )

        let instructions = payload?
            .objectValue?["settings"]?
            .objectValue?["developer_instructions"]?
            .stringValue
        XCTAssertEqual(payload?.objectValue?["mode"]?.stringValue, "plan")
        XCTAssertNil(instructions)
    }

    func testBuildCollaborationModePayloadUsesCompatibilityInstructionsAfterFallback() throws {
        let service = makeService()
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")
        service.markCompatibilityPlanFallback(for: "thread-plan")

        let payload = try service.buildCollaborationModePayload(
            for: .plan,
            threadId: "thread-plan"
        )

        let instructions = payload?
            .objectValue?["settings"]?
            .objectValue?["developer_instructions"]?
            .stringValue
        XCTAssertEqual(payload?.objectValue?["mode"]?.stringValue, "plan")
        XCTAssertTrue(instructions?.contains("request_user_input") == true)
        XCTAssertTrue(instructions?.contains("<proposed_plan>") == true)
    }

    func testRequestedPlanSessionStaysNativeFirstWithoutCompatibilityInstructions() throws {
        let service = makeService()
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")
        service.markRequestedPlanSession(for: "thread-plan")

        let payload = try service.buildCollaborationModePayload(
            for: .plan,
            threadId: "thread-plan"
        )

        let instructions = payload?
            .objectValue?["settings"]?
            .objectValue?["developer_instructions"]?
            .stringValue
        XCTAssertNil(instructions)
        XCTAssertTrue(service.allowsInferredPlanQuestionnaireFallback(for: "thread-plan"))
        XCTAssertTrue(service.allowsAssistantPlanFallbackRecovery(for: "thread-plan"))
    }

    func testCompatibilityFallbackCanOverrideNativePlanThread() {
        let service = makeService()

        service.markNativePlanSession(for: "thread-plan")
        XCTAssertTrue(service.currentPlanSessionSource(for: "thread-plan")?.isNative == true)

        service.markCompatibilityPlanFallback(for: "thread-plan")

        XCTAssertEqual(service.currentPlanSessionSource(for: "thread-plan"), .compatibilityFallback)
    }

    func testAssistantFallbackRecoveryRemainsAvailableForNativePlanThread() {
        let service = makeService()

        service.markNativePlanSession(for: "thread-plan")

        XCTAssertFalse(service.allowsInferredPlanQuestionnaireFallback(for: "thread-plan"))
        XCTAssertTrue(service.allowsAssistantPlanFallbackRecovery(for: "thread-plan"))
    }

    func testPlanSessionSourcePersistsAcrossRelaunch() {
        let suiteName = "CodexPlanModeTests.Persistence.PlanSource.\(UUID().uuidString)"
        let firstService = makeService(suiteName: suiteName, reset: true)
        firstService.markCompatibilityPlanFallback(for: "thread-plan")

        let relaunchedService = makeService(suiteName: suiteName, reset: false)

        XCTAssertEqual(
            relaunchedService.currentPlanSessionSource(for: "thread-plan"),
            .compatibilityFallback
        )
    }

    func testCompatibilityFallbackStaysStickyAcrossNewPlanTurnStarts() async throws {
        let service = makeService()
        service.isConnected = true
        service.supportsTurnCollaborationMode = true
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")
        service.markCompatibilityPlanFallback(for: "thread-plan")

        var capturedTurnStartParams: JSONValue?
        service.requestTransportOverride = { method, params in
            if method == "turn/start" {
                capturedTurnStartParams = params
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "turn": .object([
                            "id": .string("turn-live"),
                            "status": .string("inProgress"),
                            "items": .array([]),
                            "error": .null,
                        ]),
                    ]),
                    includeJSONRPC: false
                )
            }

            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([:]),
                includeJSONRPC: false
            )
        }

        try await service.startTurn(
            userInput: "Keep planning",
            threadId: "thread-plan",
            shouldAppendUserMessage: false,
            collaborationMode: .plan
        )

        let instructions = capturedTurnStartParams?
            .objectValue?["collaborationMode"]?
            .objectValue?["settings"]?
            .objectValue?["developer_instructions"]?
            .stringValue

        XCTAssertEqual(service.currentPlanSessionSource(for: "thread-plan"), .compatibilityFallback)
        XCTAssertTrue(instructions?.contains("request_user_input") == true)
    }

    func testSubmittingInferredQuestionnaireDoesNotDowngradeConfirmedNativePlanThread() async throws {
        let service = makeService()
        service.isConnected = true
        service.supportsTurnCollaborationMode = true
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")
        service.markNativePlanSession(for: "thread-plan")

        var capturedTurnSteerParams: JSONValue?
        service.requestTransportOverride = { method, params in
            if method == "turn/steer" {
                capturedTurnSteerParams = params
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object(["turnId": .string("turn-live")]),
                    includeJSONRPC: false
                )
            }

            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([:]),
                includeJSONRPC: false
            )
        }

        service.setActiveTurnID("turn-live", for: "thread-plan")

        try await service.submitInferredPlanQuestionnaireResponse(
            threadId: "thread-plan",
            questions: [
                CodexStructuredUserInputQuestion(
                    id: "scope",
                    header: "Scope",
                    question: "What scope should we use?",
                    isOther: false,
                    isSecret: false,
                    selectionLimit: 1,
                    options: [
                        CodexStructuredUserInputOption(label: "Ship now", description: ""),
                        CodexStructuredUserInputOption(label: "Stage behind a flag", description: ""),
                    ]
                ),
            ],
            answersByQuestionID: [
                "scope": ["Ship now"],
            ]
        )

        XCTAssertTrue(capturedTurnSteerParams != nil)
        XCTAssertTrue(service.currentPlanSessionSource(for: "thread-plan")?.isNative == true)
    }

    func testUnsupportedPlanModeFallsBackToNormalTurnAndStopsRetryingPlanField() async throws {
        let service = makeService()
        service.isConnected = true
        service.supportsTurnCollaborationMode = true
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")

        let threadID = "thread-\(UUID().uuidString)"
        var capturedTurnStartParams: [JSONValue] = []

        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            let requestParams = params ?? .null
            capturedTurnStartParams.append(requestParams)

            if capturedTurnStartParams.count == 1 {
                throw CodexServiceError.rpcError(
                    RPCError(
                        code: -32600,
                        message: "turn/start.collaborationMode requires experimentalApi capability"
                    )
                )
            }

            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-live")]),
                includeJSONRPC: false
            )
        }

        try await service.sendTurnStart("Plan this flow", to: threadID, collaborationMode: .plan)

        XCTAssertEqual(capturedTurnStartParams.count, 2)
        XCTAssertEqual(
            capturedTurnStartParams[0].objectValue?["collaborationMode"]?.objectValue?["mode"]?.stringValue,
            "plan"
        )
        XCTAssertNil(capturedTurnStartParams[1].objectValue?["collaborationMode"])
        XCTAssertFalse(service.supportsTurnCollaborationMode)
        XCTAssertNil(service.currentPlanSessionSource(for: threadID))
        XCTAssertEqual(
            service.messages(for: threadID).last(where: { $0.role == .system })?.text,
            "Plan mode is not supported by this runtime. Sent as a normal turn instead."
        )

        capturedTurnStartParams.removeAll()
        try await service.sendTurnStart("Try plan mode again", to: threadID, collaborationMode: .plan)

        XCTAssertEqual(capturedTurnStartParams.count, 1)
        XCTAssertNil(capturedTurnStartParams[0].objectValue?["collaborationMode"])
        XCTAssertNil(service.currentPlanSessionSource(for: threadID))
    }
}
