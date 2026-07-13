// FILE: CodexPlanStructuredInputTests.swift
// Purpose: Verifies structured plan input prompt lifecycle and responses.
// Layer: Unit Test
// Exports: CodexPlanStructuredInputTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexPlanStructuredInputTests: XCTestCase {
    private static var retainedServices: [CodexService] = []
    private static var retainedViewModels: [TurnViewModel] = []

    func testStructuredUserInputRequestCreatesAndResolvedRemovesPromptCard() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"
        let requestID: JSONValue = .string("request-\(UUID().uuidString)")

        service.handleIncomingRPCMessage(
            RPCMessage(
                id: requestID,
                method: "item/tool/requestUserInput",
                params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(turnID),
                    "itemId": .string(itemID),
                    "questions": .array([
                        .object([
                            "id": .string("mode"),
                            "header": .string("Direction"),
                            "question": .string("Which path should we take?"),
                            "isOther": .bool(false),
                            "isSecret": .bool(false),
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

        let promptMessages = service.messages(for: threadID).filter { $0.kind == .userInputPrompt }
        XCTAssertEqual(promptMessages.count, 1)
        XCTAssertEqual(promptMessages[0].structuredUserInputRequest?.questions.first?.header, "Direction")

        service.handleNotification(
            method: "serverRequest/resolved",
            params: .object([
                "threadId": .string(threadID),
                "requestId": requestID,
            ])
        )

        XCTAssertTrue(service.messages(for: threadID).filter { $0.kind == .userInputPrompt }.isEmpty)
    }

    func testToolRequestUserInputMethodCreatesPromptCard() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let requestID: JSONValue = .string("request-\(UUID().uuidString)")

        service.handleIncomingRPCMessage(
            RPCMessage(
                id: requestID,
                method: "tool/requestUserInput",
                params: .object([
                    "threadId": .string(threadID),
                    "questions": .array([
                        .object([
                            "id": .string("path"),
                            "header": .string("Direction"),
                            "question": .string("Which path should we take?"),
                            "isOther": .bool(true),
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

        let promptMessages = service.messages(for: threadID).filter { $0.kind == .userInputPrompt }
        XCTAssertEqual(promptMessages.count, 1)
        XCTAssertEqual(promptMessages[0].structuredUserInputRequest?.questions.first?.id, "path")
        XCTAssertEqual(promptMessages[0].structuredUserInputRequest?.questions.first?.isOther, true)
    }

    func testToolRequestUserInputWithoutThreadIDUsesTurnMapping() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let requestID: JSONValue = .string("request-\(UUID().uuidString)")

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )

        service.handleIncomingRPCMessage(
            RPCMessage(
                id: requestID,
                method: "tool/requestUserInput",
                params: .object([
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

        let promptMessages = service.messages(for: threadID).filter { $0.kind == .userInputPrompt }
        XCTAssertEqual(promptMessages.count, 1)
        XCTAssertEqual(promptMessages[0].turnId, turnID)
    }

    func testStructuredUserInputPromptPersistsAcrossRelaunchUntilResolved() {
        let suiteName = "CodexPlanModeTests.Persistence.\(UUID().uuidString)"
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"
        let requestID: JSONValue = .string("request-\(UUID().uuidString)")

        let firstService = makeService(suiteName: suiteName)
        firstService.handleIncomingRPCMessage(
            RPCMessage(
                id: requestID,
                method: "item/tool/requestUserInput",
                params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(turnID),
                    "itemId": .string(itemID),
                    "questions": .array([
                        .object([
                            "id": .string("path"),
                            "header": .string("Direction"),
                            "question": .string("Which path should we take?"),
                            "isOther": .bool(false),
                            "isSecret": .bool(false),
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

        let relaunchedService = makeService(suiteName: suiteName, reset: false)
        let promptMessages = relaunchedService.messages(for: threadID).filter { $0.kind == .userInputPrompt }
        XCTAssertEqual(promptMessages.count, 1)
        XCTAssertEqual(promptMessages[0].structuredUserInputRequest?.questions.first?.id, "path")
    }

    func testStructuredUserInputPromptWithoutTurnIDStillCreatesPromptCard() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let requestID: JSONValue = .string("request-\(UUID().uuidString)")

        service.handleIncomingRPCMessage(
            RPCMessage(
                id: requestID,
                method: "item/tool/requestUserInput",
                params: .object([
                    "threadId": .string(threadID),
                    "questions": .array([
                        .object([
                            "id": .string("path"),
                            "header": .string("Direction"),
                            "question": .string("Which path should we take?"),
                            "isOther": .bool(false),
                            "isSecret": .bool(false),
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

        let promptMessages = service.messages(for: threadID).filter { $0.kind == .userInputPrompt }
        XCTAssertEqual(promptMessages.count, 1)
        XCTAssertNil(promptMessages[0].turnId)
    }

    func testTurnStartedDoesNotClearPendingStructuredUserInputPromptBeforeResolution() {
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
                            "id": .string("path"),
                            "header": .string("Direction"),
                            "question": .string("Which path should we take?"),
                            "isOther": .bool(false),
                            "isSecret": .bool(false),
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

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string("turn-\(UUID().uuidString)"),
            ])
        )

        let promptMessages = service.messages(for: threadID).filter { $0.kind == .userInputPrompt }
        XCTAssertEqual(promptMessages.count, 1)
        XCTAssertEqual(promptMessages[0].structuredUserInputRequest?.requestID, requestID)
    }

    func testTurnCompletionDoesNotClearPendingStructuredUserInputPromptBeforeResolution() {
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
                            "id": .string("path"),
                            "header": .string("Direction"),
                            "question": .string("Which path should we take?"),
                            "isOther": .bool(false),
                            "isSecret": .bool(false),
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

        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )

        let promptMessages = service.messages(for: threadID).filter { $0.kind == .userInputPrompt }
        XCTAssertEqual(promptMessages.count, 1)
        XCTAssertEqual(promptMessages[0].structuredUserInputRequest?.requestID, requestID)

        service.handleNotification(
            method: "serverRequest/resolved",
            params: .object([
                "threadId": .string(threadID),
                "requestId": requestID,
            ])
        )

        XCTAssertTrue(service.messages(for: threadID).filter { $0.kind == .userInputPrompt }.isEmpty)
    }

    func testBuildStructuredUserInputResponseMatchesServerShape() {
        let service = makeService()

        let response = service.buildStructuredUserInputResponse(
            answersByQuestionID: [
                "path": ["Ship it"],
                "notes": ["Keep the old composer styling"],
            ]
        )

        let answers = response.objectValue?["answers"]?.objectValue
        XCTAssertEqual(
            answers?["path"]?.objectValue?["answers"]?.arrayValue?.compactMap(\.stringValue),
            ["Ship it"]
        )
        XCTAssertEqual(
            answers?["notes"]?.objectValue?["answers"]?.arrayValue?.compactMap(\.stringValue),
            ["Keep the old composer styling"]
        )
    }

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

    func testResolvedInferredPlanQuestionnairePrefersMatchingNativePrompt() {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let assistantMessage = CodexMessage(
            threadId: threadID,
            role: .assistant,
            text: """
            I have one question for you before I finalize the plan:

            1. Which path should we take?
            - Ship it
            - Stage it
            """,
            turnId: turnID
        )
        let nativePrompt = CodexMessage(
            threadId: threadID,
            role: .system,
            kind: .userInputPrompt,
            text: "Direction\nWhich path should we take?",
            turnId: turnID,
            structuredUserInputRequest: CodexStructuredUserInputRequest(
                requestID: .string("request-\(UUID().uuidString)"),
                questions: [
                    CodexStructuredUserInputQuestion(
                        id: "direction",
                        header: "Direction",
                        question: "Which path should we take?",
                        isOther: false,
                        isSecret: false,
                        options: [
                            CodexStructuredUserInputOption(label: "Ship it", description: "Build the fastest version"),
                            CodexStructuredUserInputOption(label: "Stage it", description: "Ship in smaller slices"),
                        ]
                    ),
                ]
            )
        )

        let questionnaire = resolvedInferredPlanQuestionnaire(
            bodyText: assistantMessage.text,
            message: assistantMessage,
            threadMessages: [assistantMessage, nativePrompt],
            parse: InferredPlanQuestionnaireParser.parseAssistantMessage
        )

        XCTAssertNil(questionnaire)
    }


    private func makeService(
        suiteName: String = "CodexPlanStructuredInputTests.\(UUID().uuidString)",
        reset: Bool = true
    ) -> CodexService {
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        if reset {
            defaults.removePersistentDomain(forName: suiteName)
        }
        let service = CodexService(defaults: defaults)
        if reset {
            service.messagesByThread = [:]
        }
        Self.retainedServices.append(service)
        return service
    }

    private func makeViewModel() -> TurnViewModel {
        let viewModel = TurnViewModel()
        Self.retainedViewModels.append(viewModel)
        return viewModel
    }

    private func waitForStructuredPromptDismissCompletion(
        _ viewModel: TurnViewModel,
        requestID: JSONValue,
        codex: CodexService
    ) async {
        for _ in 0..<120 {
            if !viewModel.isStructuredPlanPromptDismissing(requestID, codex: codex) {
                return
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Expected structured prompt dismiss to complete")
    }
}
