// FILE: CodexPlanModeResetTests.swift
// Purpose: Verifies plan-mode reset, runtime support, and send failure behavior.
// Layer: Unit Test
// Exports: CodexPlanModeResetTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexPlanModeResetTests: CodexPlanModeTestCase {
    func testPlanSessionStateMigratesToContinuationThread() async throws {
        let service = makeService()
        service.supportsTurnCollaborationMode = true
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")

        let archivedThreadID = "thread-archived"
        let continuationThreadID = "thread-continuation"

        service.requestTransportOverride = { method, params in
            switch method {
            case "thread/resume":
                let threadId = params?.objectValue?["threadId"]?.stringValue
                if threadId == archivedThreadID {
                    throw CodexServiceError.rpcError(
                        RPCError(code: -32000, message: "thread not found")
                    )
                }
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "id": .string(threadId ?? continuationThreadID),
                        ]),
                    ]),
                    includeJSONRPC: false
                )

            case "thread/start":
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "id": .string(continuationThreadID),
                        ]),
                    ]),
                    includeJSONRPC: false
                )

            case "turn/start":
                XCTAssertEqual(params?.objectValue?["threadId"]?.stringValue, continuationThreadID)
                XCTAssertEqual(
                    params?.objectValue?["collaborationMode"]?.objectValue?["mode"]?.stringValue,
                    "plan"
                )
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object(["turnId": .string("turn-live")]),
                    includeJSONRPC: false
                )

            default:
                XCTFail("Unexpected method \(method)")
                return RPCMessage(id: .string(UUID().uuidString), result: .null, includeJSONRPC: false)
            }
        }

        try await service.startTurn(
            userInput: "Plan this continuation",
            threadId: archivedThreadID,
            collaborationMode: .plan
        )

        XCTAssertNil(service.currentPlanSessionSource(for: archivedThreadID))
        XCTAssertEqual(service.currentPlanSessionSource(for: continuationThreadID), .requested)
    }

    func testNonPlanSteerClearsStalePlanSessionState() async throws {
        let service = makeService()
        let threadID = "thread-plan"
        let turnID = "turn-live"

        service.supportsTurnCollaborationMode = true
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")
        service.markCompatibilityPlanFallback(for: threadID)
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/steer")
            XCTAssertEqual(params?.objectValue?["threadId"]?.stringValue, threadID)
            XCTAssertEqual(
                params?.objectValue?["collaborationMode"]?.objectValue?["mode"]?.stringValue,
                CodexCollaborationModeKind.default.rawValue
            )
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string(turnID)]),
                includeJSONRPC: false
            )
        }

        try await service.steerTurn(
            userInput: "Normal follow-up",
            threadId: threadID,
            expectedTurnId: turnID,
            collaborationMode: nil
        )

        XCTAssertNil(service.currentPlanSessionSource(for: threadID))
    }

    func testNonPlanStartClearsStalePlanSessionStateBySendingDefaultMode() async throws {
        let service = makeService()
        service.supportsTurnCollaborationMode = true
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")

        let threadID = "thread-plan"
        service.threads = [CodexThread(id: threadID, title: "Plan thread")]
        service.markNativePlanSession(for: threadID)

        var capturedTurnStartParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            capturedTurnStartParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-normal")]),
                includeJSONRPC: false
            )
        }

        try await service.startTurn(
            userInput: "Normal follow-up",
            threadId: threadID,
            collaborationMode: nil
        )

        XCTAssertEqual(
            capturedTurnStartParams?
                .objectValue?["collaborationMode"]?
                .objectValue?["mode"]?
                .stringValue,
            CodexCollaborationModeKind.default.rawValue
        )
        XCTAssertNil(service.currentPlanSessionSource(for: threadID))
    }

    func testImplementProposedPlanSteerExplicitlyReturnsToDefaultMode() async throws {
        let service = makeService()
        service.supportsTurnCollaborationMode = true
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")

        let threadID = "thread-plan"
        let turnID = "turn-live"
        service.markNativePlanSession(for: threadID)
        service.setActiveTurnID(turnID, for: threadID)

        var capturedTurnSteerParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/steer")
            capturedTurnSteerParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string(turnID)]),
                includeJSONRPC: false
            )
        }

        try await service.implementProposedPlan(
            threadId: threadID,
            proposedPlan: CodexProposedPlan(body: "1. Ship it")
        )

        XCTAssertEqual(
            capturedTurnSteerParams?
                .objectValue?["collaborationMode"]?
                .objectValue?["mode"]?
                .stringValue,
            CodexCollaborationModeKind.default.rawValue
        )
        XCTAssertNil(service.currentPlanSessionSource(for: threadID))
    }

    func testImplementProposedPlanStartExplicitlyReturnsToDefaultMode() async throws {
        let service = makeService()
        service.supportsTurnCollaborationMode = true
        service.availableModels = [makeModel()]
        service.setSelectedModelId("gpt-5-codex")

        let threadID = "thread-plan"
        service.markNativePlanSession(for: threadID)

        var capturedTurnStartParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            capturedTurnStartParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-implement")]),
                includeJSONRPC: false
            )
        }

        try await service.implementProposedPlan(
            threadId: threadID,
            proposedPlan: CodexProposedPlan(body: "1. Ship it")
        )

        XCTAssertEqual(
            capturedTurnStartParams?
                .objectValue?["collaborationMode"]?
                .objectValue?["mode"]?
                .stringValue,
            CodexCollaborationModeKind.default.rawValue
        )
        XCTAssertNil(service.currentPlanSessionSource(for: threadID))
    }

    func testRuntimeSupportsPlanCollaborationModeUsesOfficialCollaborationModeListShape() async {
        let service = makeService()

        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "collaborationMode/list")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "data": .array([
                        .object(["mode": .string("default")]),
                        .object(["mode": .string("plan")]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        }

        let isSupported = await service.runtimeSupportsPlanCollaborationMode()
        XCTAssertTrue(isSupported)
    }

    func testRuntimeSupportsPlanCollaborationModeReturnsFalseWhenPlanMissingFromOfficialShape() async {
        let service = makeService()

        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "collaborationMode/list")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "data": .array([
                        .object(["mode": .string("default")]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        }

        let isSupported = await service.runtimeSupportsPlanCollaborationMode()
        XCTAssertFalse(isSupported)
    }

    func testRuntimeSupportsPlanCollaborationModeStillAcceptsLegacyModesShape() async {
        let service = makeService()

        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "collaborationMode/list")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "modes": .array([
                        .object(["mode": .string("default")]),
                        .object(["mode": .string("plan")]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        }

        let isSupported = await service.runtimeSupportsPlanCollaborationMode()
        XCTAssertTrue(isSupported)
    }

    func testPlanModeSendFailureRearmsToggleAndSkipsFallbackRequest() async {
        let service = makeService()
        service.isConnected = true

        var attemptedRequestCount = 0
        service.requestTransportOverride = { _, _ in
            attemptedRequestCount += 1
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([:]),
                includeJSONRPC: false
            )
        }

        let viewModel = makeViewModel()
        viewModel.input = "Plan this flow"
        viewModel.setPlanModeArmed(true)
        viewModel.sendTurn(codex: service, threadID: "thread-plan-failure")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(attemptedRequestCount, 0)
        XCTAssertTrue(viewModel.isPlanModeArmed)
        XCTAssertEqual(viewModel.input, "Plan this flow")
        XCTAssertEqual(
            service.lastErrorMessage,
            "Plan mode requires an available model before starting a plan turn."
        )
    }
}
