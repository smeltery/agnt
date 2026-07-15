// FILE: CodexPlanStructuredInputDismissTests.swift
// Purpose: Verifies structured plan input cancel and dismiss flows.
// Layer: Unit Test
// Exports: CodexPlanStructuredInputDismissTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexPlanStructuredInputDismissTests: CodexPlanStructuredInputTestCase {
    func testCancelStructuredPlanSessionInterruptsTurnAndClearsPromptState() async throws {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let requestID: JSONValue = .string("request-\(UUID().uuidString)")
        let secondRequestID: JSONValue = .string("request-\(UUID().uuidString)")

        service.handleIncomingRPCMessage(
            RPCMessage(
                id: requestID,
                method: "item/tool/requestUserInput",
                params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(turnID),
                    "questions": .array([
                        .object([
                            "id": .string("path"),
                            "header": .string("Direction"),
                            "question": .string("Which path should we take?"),
                            "options": .array([
                                .object([
                                    "label": .string("Ship it"),
                                    "description": .string("Build the fastest version"),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        )
        service.handleIncomingRPCMessage(
            RPCMessage(
                id: secondRequestID,
                method: "item/tool/requestUserInput",
                params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(turnID),
                    "questions": .array([
                        .object([
                            "id": .string("scope"),
                            "header": .string("Scope"),
                            "question": .string("Do we keep the old flow too?"),
                            "options": .array([
                                .object([
                                    "label": .string("Yes"),
                                    "description": .string("Keep both for now"),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        )
        service.markNativePlanSession(for: threadID)

        var interruptParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/interrupt")
            interruptParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([:]),
                includeJSONRPC: false
            )
        }

        try await service.cancelStructuredPlanSession(
            requestID: requestID,
            turnId: turnID,
            threadId: threadID
        )

        XCTAssertEqual(interruptParams?.objectValue?["turnId"]?.stringValue, turnID)
        XCTAssertEqual(interruptParams?.objectValue?["threadId"]?.stringValue, threadID)
        XCTAssertTrue(service.messages(for: threadID).filter { $0.kind == .userInputPrompt }.isEmpty)
        XCTAssertNil(service.currentPlanSessionSource(for: threadID))
    }

    func testCancelStructuredPlanSessionFailurePreservesPromptState() async {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let requestID: JSONValue = .string("request-\(UUID().uuidString)")

        service.handleIncomingRPCMessage(
            RPCMessage(
                id: requestID,
                method: "item/tool/requestUserInput",
                params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(turnID),
                    "questions": .array([
                        .object([
                            "id": .string("scope"),
                            "header": .string("Scope"),
                            "question": .string("Do we keep the old flow too?"),
                            "options": .array([
                                .object([
                                    "label": .string("Yes"),
                                    "description": .string("Keep both for now"),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        )
        service.markNativePlanSession(for: threadID)

        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "turn/interrupt")
            throw CodexServiceError.disconnected
        }

        do {
            try await service.cancelStructuredPlanSession(
                requestID: requestID,
                turnId: turnID,
                threadId: threadID
            )
            XCTFail("Expected cancelStructuredPlanSession to throw")
        } catch let error as CodexServiceError {
            guard case .disconnected = error else {
                XCTFail("Unexpected CodexServiceError: \(error)")
                return
            }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }

        XCTAssertEqual(service.messages(for: threadID).filter { $0.kind == .userInputPrompt }.count, 1)
        XCTAssertTrue(service.currentPlanSessionSource(for: threadID)?.isNative == true)
    }

    func testDismissStructuredPlanPromptFailureKeepsPromptVisible() async {
        let service = makeService()
        let viewModel = makeViewModel()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let requestID: JSONValue = .string("request-\(UUID().uuidString)")

        service.handleIncomingRPCMessage(
            RPCMessage(
                id: requestID,
                method: "item/tool/requestUserInput",
                params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(turnID),
                    "questions": .array([
                        .object([
                            "id": .string("scope"),
                            "header": .string("Scope"),
                            "question": .string("Do we keep the old flow too?"),
                            "options": .array([
                                .object([
                                    "label": .string("Yes"),
                                    "description": .string("Keep both for now"),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        )
        service.markNativePlanSession(for: threadID)

        guard let promptMessage = service.messages(for: threadID).last(where: { $0.kind == .userInputPrompt }) else {
            XCTFail("Expected a structured prompt message")
            return
        }

        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "turn/interrupt")
            throw CodexServiceError.disconnected
        }

        viewModel.dismissStructuredPlanPrompt(promptMessage, codex: service, threadID: threadID)
        await waitForStructuredPromptDismissCompletion(
            viewModel,
            requestID: requestID,
            codex: service
        )

        XCTAssertFalse(viewModel.isStructuredPlanPromptDismissed(requestID, codex: service))
        XCTAssertFalse(viewModel.isStructuredPlanPromptDismissing(requestID, codex: service))
        XCTAssertEqual(service.messages(for: threadID).filter { $0.kind == .userInputPrompt }.count, 1)
        XCTAssertTrue(service.currentPlanSessionSource(for: threadID)?.isNative == true)
        XCTAssertEqual(service.lastErrorMessage, service.userFacingTurnErrorMessage(from: CodexServiceError.disconnected))
    }
}
