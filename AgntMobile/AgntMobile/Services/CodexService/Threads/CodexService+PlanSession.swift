import Foundation

extension CodexService {
    // Encodes collaborationMode while allowing the selected mode to supply built-in instructions.
    func buildCollaborationModePayload(
        for mode: CodexCollaborationModeKind?,
        threadId: String?
    ) throws -> JSONValue? {
        guard let mode else {
            return nil
        }

        let resolvedModel = runtimeModelIdentifierForTurn(threadId: threadId)
            ?? selectedModelOption(threadId: threadId)?.model
            ?? availableModels.first?.model
            ?? selectedModelId
        guard let resolvedModel,
              !resolvedModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CodexServiceError.invalidResponse(
                "Plan mode requires an available model before starting a plan turn."
            )
        }
        let developerInstructionsValue: JSONValue = {
            guard mode == .plan,
                  let threadId,
                  currentPlanSessionSource(for: threadId) == .compatibilityFallback,
                  let instructions = developerInstructions(for: mode)?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                  !instructions.isEmpty else {
                return .null
            }
            return .string(instructions)
        }()

        return .object([
            "mode": .string(mode.rawValue),
            "settings": .object([
                "model": .string(resolvedModel),
                "reasoning_effort": selectedReasoningEffortForSelectedModel(
                    threadId: threadId
                ).map(JSONValue.string) ?? .null,
                // Stay native-first by default, but allow a compatibility override after fallback.
                "developer_instructions": developerInstructionsValue,
            ]),
        ])
    }

    func implementProposedPlan(
        threadId: String,
        proposedPlan: CodexProposedPlan
    ) async throws {
        let normalizedThreadID = normalizedInterruptIdentifier(threadId) ?? threadId
        let planBody = proposedPlan.body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !planBody.isEmpty else {
            throw CodexServiceError.invalidInput("Proposed plan cannot be empty")
        }

        // The approved plan is already part of the thread history, so keep the
        // handoff prompt minimal instead of replaying the full plan body.
        let userInput = "Implement plan."

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
                // Exiting plan mode needs to be explicit for runtimes that keep the
                // current collaboration mode when turn/steer omits the field.
                collaborationMode: .default
            )
            return
        }

        try await startTurn(
            userInput: userInput,
            threadId: normalizedThreadID,
            shouldAppendUserMessage: true,
            collaborationMode: .default
        )
    }

    func currentPlanSessionSource(for threadId: String) -> CodexPlanSessionSource? {
        planSessionSourceByThread[threadId]
    }

    func allowsInferredPlanQuestionnaireFallback(for threadId: String) -> Bool {
        currentPlanSessionSource(for: threadId) == .compatibilityFallback
    }

    // Plain-text questionnaire recovery belongs only to explicit compatibility mode.
    func allowsAssistantPlanFallbackRecovery(for threadId: String) -> Bool {
        currentPlanSessionSource(for: threadId) == .compatibilityFallback
    }

    // Native/requested plan threads should rely on official requestUserInput events,
    // not on heuristics over assistant prose.
    func allowsAssistantPlanFallbackRecovery(for threadId: String, turnId: String?) -> Bool {
        let _ = turnId
        return currentPlanSessionSource(for: threadId) == .compatibilityFallback
    }

    func markRequestedPlanSession(for threadId: String) {
        planSessionSourceByThread[threadId] = .requested
    }

    func migratePlanSessionState(from sourceThreadId: String, to destinationThreadId: String) {
        guard sourceThreadId != destinationThreadId,
              let source = planSessionSourceByThread.removeValue(forKey: sourceThreadId) else {
            return
        }
        planSessionSourceByThread[destinationThreadId] = source
    }

    func markNativePlanSession(for threadId: String) {
        planSessionSourceByThread[threadId] = preferredNativePlanSessionSource()
    }

    func markCompatibilityPlanFallback(for threadId: String) {
        planSessionSourceByThread[threadId] = .compatibilityFallback
    }

    func resetPlanSessionState(for threadId: String) {
        planSessionSourceByThread.removeValue(forKey: threadId)
    }

    func reconcileNativePlanSessionSources(
        previousTransportMode: CodexRuntimeTransportMode,
        nextTransportMode: CodexRuntimeTransportMode
    ) {
        guard previousTransportMode != nextTransportMode else {
            return
        }

        let preferredSource = preferredNativePlanSessionSource()
        for (threadId, source) in planSessionSourceByThread where source.isNative {
            planSessionSourceByThread[threadId] = preferredSource
        }
    }

    private func preferredNativePlanSessionSource() -> CodexPlanSessionSource {
        switch codexTransportMode {
        case .websocket:
            return .nativeDesktopEndpoint
        case .spawn, .unknown:
            return .nativeAppServer
        }
    }

    func shouldCommitInferredPlanQuestionnaireFallback(for threadId: String) -> Bool {
        currentPlanSessionSource(for: threadId) == .compatibilityFallback
    }

    // App-server keeps collaboration mode sticky when the field is omitted, so
    // a normal send from an active plan thread must explicitly restore default.
    func collaborationModeForOutgoingTurn(
        threadId: String,
        requestedMode: CodexCollaborationModeKind?,
        preserveExisting: Bool = false
    ) -> CodexCollaborationModeKind? {
        if let requestedMode {
            return requestedMode
        }

        guard !preserveExisting,
              supportsTurnCollaborationMode,
              currentPlanSessionSource(for: threadId) != nil else {
            return nil
        }

        return .default
    }

    func developerInstructions(for mode: CodexCollaborationModeKind) -> String? {
        switch mode {
        case .plan:
            Self.compatibilityPlanModeDeveloperInstructions
        case .default:
            nil
        }
    }

    private static let compatibilityPlanModeDeveloperInstructions = """
    You are in plan mode.

    Strongly prefer the native structured question flow when you need clarification:
    - use request_user_input instead of writing a numbered questionnaire in plain text
    - keep the conversation in a one-question-at-a-time flow when possible
    - ask one material question at a time when possible
    - keep each tool prompt short and decision-oriented
    - Never write multiple-choice questions as plain assistant text.

    When you reach a final implementation proposal, wrap it in exactly one <proposed_plan> block with Markdown inside.
    """

    func preparePlanSessionForStart(
        threadId: String,
        collaborationMode: CodexCollaborationModeKind?,
        preserveExisting: Bool
    ) {
        guard !preserveExisting else {
            return
        }

        if collaborationMode == .plan,
           currentPlanSessionSource(for: threadId) != nil {
            return
        }

        if shouldTrackRequestedPlanSession(for: collaborationMode) {
            resetPlanSessionState(for: threadId)
            markRequestedPlanSession(for: threadId)
        } else {
            resetPlanSessionState(for: threadId)
        }
    }

    func preparePlanSessionForSteer(
        threadId: String,
        collaborationMode: CodexCollaborationModeKind?
    ) {
        if shouldTrackRequestedPlanSession(for: collaborationMode) {
            if currentPlanSessionSource(for: threadId) == nil {
                markRequestedPlanSession(for: threadId)
            }
        } else {
            resetPlanSessionState(for: threadId)
        }
    }

    func clearPlanSessionIfRuntimeDowngraded(
        threadId: String,
        collaborationMode: CodexCollaborationModeKind?
    ) {
        guard collaborationMode == .plan else {
            return
        }

        resetPlanSessionState(for: threadId)
    }

    private func shouldTrackRequestedPlanSession(
        for collaborationMode: CodexCollaborationModeKind?
    ) -> Bool {
        collaborationMode == .plan && supportsTurnCollaborationMode
    }
}
