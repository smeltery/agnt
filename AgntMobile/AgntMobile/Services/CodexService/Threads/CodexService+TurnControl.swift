// FILE: CodexService+TurnControl.swift
// Purpose: Turn interruption and structured user-input response APIs.
// Layer: Service
// Exports: CodexService turn-control APIs
// Depends on: CodexService, JSONValue, CodexStructuredUserInputQuestion

import Foundation

extension CodexService {
    // Requests interruption for the active turn.
    func interruptTurn(turnId: String?, threadId: String? = nil) async throws {
        let normalizedThreadID = normalizedInterruptIdentifier(threadId)
            ?? normalizedInterruptIdentifier(activeThreadId)

        var normalizedTurnID = normalizedInterruptIdentifier(turnId)
        if normalizedTurnID == nil,
           let normalizedThreadID {
            normalizedTurnID = normalizedInterruptIdentifier(activeTurnIdByThread[normalizedThreadID])
        }
        if normalizedTurnID == nil {
            normalizedTurnID = normalizedInterruptIdentifier(activeTurnId)
        }
        if normalizedTurnID == nil,
           let normalizedThreadID {
            do {
                normalizedTurnID = try await resolveInFlightTurnID(threadId: normalizedThreadID)
            } catch {
                if let serviceError = error as? CodexServiceError,
                   case .invalidInput(_) = serviceError,
                   protectedRunningFallbackThreadIDs.contains(normalizedThreadID),
                   activeTurnID(for: normalizedThreadID) == nil {
                    demoteVisibleRunningStateToProtectedFallback(for: normalizedThreadID)
                }
                lastErrorMessage = userFacingTurnErrorMessageForFooter(from: error)
                throw error
            }
        }

        guard let normalizedTurnID else {
            throw CodexServiceError.invalidInput("turn/interrupt requires a non-empty turnId")
        }

        let resolvedThreadID = normalizedThreadID
            ?? threadIdByTurnID[normalizedTurnID]
            ?? normalizedInterruptIdentifier(activeThreadId)
        if let resolvedThreadID {
            threadIdByTurnID[normalizedTurnID] = resolvedThreadID
        }

        do {
            try await sendInterruptRequest(
                turnId: normalizedTurnID,
                threadId: resolvedThreadID,
                useSnakeCaseParams: false
            )
            lastErrorMessage = nil
            return
        } catch {
            var finalError: Error = error

            if shouldRetryInterruptWithSnakeCaseParams(error) {
                do {
                    try await sendInterruptRequest(
                        turnId: normalizedTurnID,
                        threadId: resolvedThreadID,
                        useSnakeCaseParams: true
                    )
                    lastErrorMessage = nil
                    return
                } catch {
                    finalError = error
                }
            }

            if let resolvedThreadID,
               shouldRetryInterruptWithRefreshedTurnID(finalError),
               let refreshedTurnID = try await resolveInFlightTurnID(threadId: resolvedThreadID),
               refreshedTurnID != normalizedTurnID {
                do {
                    try await sendInterruptRequest(
                        turnId: refreshedTurnID,
                        threadId: resolvedThreadID,
                        useSnakeCaseParams: false
                    )
                    setActiveTurnID(refreshedTurnID, for: resolvedThreadID)
                    threadIdByTurnID[refreshedTurnID] = resolvedThreadID
                    lastErrorMessage = nil
                    return
                } catch {
                    finalError = error
                    if shouldRetryInterruptWithSnakeCaseParams(error) {
                        do {
                            try await sendInterruptRequest(
                                turnId: refreshedTurnID,
                                threadId: resolvedThreadID,
                                useSnakeCaseParams: true
                            )
                            setActiveTurnID(refreshedTurnID, for: resolvedThreadID)
                            threadIdByTurnID[refreshedTurnID] = resolvedThreadID
                            lastErrorMessage = nil
                            return
                        } catch {
                            finalError = error
                        }
                    }
                }
            }

            lastErrorMessage = userFacingTurnErrorMessageForFooter(from: finalError)
            throw finalError
        }
    }

    // Interrupts every active or protected run before switching to a different Mac context.
    func interruptAllRunningTurnsBeforeMacSwitch() async throws {
        let candidateThreadIDs = runningThreadIDs
            .union(protectedRunningFallbackThreadIDs)
            .union(activeTurnIdByThread.keys)
            .sorted()

        for threadID in candidateThreadIDs {
            try await interruptTurn(turnId: nil, threadId: threadID)
        }
    }

    // Responds to item/tool/requestUserInput using the exact app-server answer envelope.
    func respondToStructuredUserInput(
        requestID: JSONValue,
        answersByQuestionID: [String: [String]]
    ) async throws {
        try await sendResponse(
            id: requestID,
            result: buildStructuredUserInputResponse(answersByQuestionID: answersByQuestionID)
        )
    }

    func buildStructuredUserInputResponse(
        answersByQuestionID: [String: [String]]
    ) -> JSONValue {
        let answersObject = answersByQuestionID.reduce(into: RPCObject()) { result, entry in
            let filteredAnswers = entry.value
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            result[entry.key] = .object([
                "answers": .array(filteredAnswers.map(JSONValue.string)),
            ])
        }

        return .object([
            "answers": .object(answersObject),
        ])
    }

    // Interrupts the active plan turn, only tearing down local prompt/session state once it is safe.
    func cancelStructuredPlanSession(
        requestID _: JSONValue,
        turnId: String?,
        threadId: String
    ) async throws {
        do {
            try await interruptTurn(turnId: turnId, threadId: threadId)
            removeAllStructuredUserInputPrompts(threadId: threadId)
            resetPlanSessionState(for: threadId)
        } catch let error as CodexServiceError {
            if case .invalidInput = error {
                removeAllStructuredUserInputPrompts(threadId: threadId)
                resetPlanSessionState(for: threadId)
                return
            }
            throw error
        }
    }

    // Falls back to a normal plan-mode user reply when the runtime asked clarifying
    // questions in plain text instead of emitting `item/tool/requestUserInput`.
    func submitInferredPlanQuestionnaireResponse(
        threadId: String,
        questions: [CodexStructuredUserInputQuestion],
        answersByQuestionID: [String: [String]]
    ) async throws {
        let userInput = inferredPlanQuestionnaireResponseText(
            questions: questions,
            answersByQuestionID: answersByQuestionID
        )
        guard !userInput.isEmpty else {
            throw CodexServiceError.invalidInput("Questionnaire answers cannot be empty")
        }

        let normalizedThreadID = normalizedInterruptIdentifier(threadId) ?? threadId
        if shouldCommitInferredPlanQuestionnaireFallback(for: normalizedThreadID) {
            markCompatibilityPlanFallback(for: normalizedThreadID)
        }

        var expectedTurnID = activeTurnID(for: normalizedThreadID)
        if expectedTurnID == nil {
            do {
                expectedTurnID = try await resolveInFlightTurnID(threadId: normalizedThreadID)
            } catch {
                if let serviceError = error as? CodexServiceError,
                   case .invalidInput(_) = serviceError {
                    expectedTurnID = nil
                } else {
                    throw error
                }
            }
        }

        if let expectedTurnID {
            try await steerTurn(
                userInput: userInput,
                threadId: normalizedThreadID,
                expectedTurnId: expectedTurnID,
                shouldAppendUserMessage: true,
                collaborationMode: .plan
            )
            return
        }

        try await startTurn(
            userInput: userInput,
            threadId: normalizedThreadID,
            shouldAppendUserMessage: true,
            collaborationMode: .plan,
            preservePlanSessionState: true
        )
    }

    func inferredPlanQuestionnaireResponseText(
        questions: [CodexStructuredUserInputQuestion],
        answersByQuestionID: [String: [String]]
    ) -> String {
        let sections = questions.enumerated().compactMap { index, question -> String? in
            let answers = (answersByQuestionID[question.id] ?? [])
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            guard !answers.isEmpty else {
                return nil
            }

            let prompt = question.trimmedPrompt
            if answers.count == 1 {
                return "\(index + 1). \(prompt)\n\(answers[0])"
            }

            let answerLines = answers.map { "- \($0)" }.joined(separator: "\n")
            return "\(index + 1). \(prompt)\n\(answerLines)"
        }

        guard !sections.isEmpty else {
            return ""
        }

        return """
        Answers:

        \(sections.joined(separator: "\n\n"))
        """
    }
}
