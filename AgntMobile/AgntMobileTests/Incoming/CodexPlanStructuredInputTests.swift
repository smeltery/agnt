// FILE: CodexPlanStructuredInputTests.swift
// Purpose: Verifies structured plan input prompt lifecycle and responses.
// Layer: Unit Test
// Exports: CodexPlanStructuredInputTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexPlanStructuredInputTests: CodexPlanStructuredInputTestCase {
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
}
