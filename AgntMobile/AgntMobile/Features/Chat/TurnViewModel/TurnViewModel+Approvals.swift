// FILE: TurnViewModel+Approvals.swift
// Purpose: Turn interruption, structured prompts, and approval actions.
// Layer: View Model

import Foundation

extension TurnViewModel {
    func interruptTurn(_ turnID: String?, codex: CodexService, threadID: String) {
        Task { @MainActor in
            do {
                try await codex.interruptTurn(turnId: turnID, threadId: threadID)
            } catch {
                // Error message already stored in CodexService.
            }
        }
    }

    func dismissStructuredPlanPrompt(_ message: CodexMessage, codex: CodexService, threadID: String) {
        guard let request = message.structuredUserInputRequest else {
            return
        }

        let requestKey = codex.idKey(from: request.requestID)
        guard !dismissedStructuredPlanPromptRequestKeys.contains(requestKey) else {
            return
        }
        guard dismissingStructuredPlanPromptRequestKeys.insert(requestKey).inserted else {
            return
        }

        isPlanModeArmed = false
        clearComposerAutocomplete()

        Task { @MainActor in
            defer {
                dismissingStructuredPlanPromptRequestKeys.remove(requestKey)
            }

            do {
                try await codex.cancelStructuredPlanSession(
                    requestID: request.requestID,
                    turnId: message.turnId,
                    threadId: threadID
                )
                dismissedStructuredPlanPromptRequestKeys.insert(requestKey)
            } catch {
                codex.lastErrorMessage = codex.userFacingTurnErrorMessage(from: error)
            }
        }
    }

    func isStructuredPlanPromptDismissed(_ requestID: JSONValue, codex: CodexService) -> Bool {
        dismissedStructuredPlanPromptRequestKeys.contains(codex.idKey(from: requestID))
    }

    func isStructuredPlanPromptDismissing(_ requestID: JSONValue, codex: CodexService) -> Bool {
        dismissingStructuredPlanPromptRequestKeys.contains(codex.idKey(from: requestID))
    }

    func reconcileDismissedStructuredPlanPrompts(messages: [CodexMessage], codex: CodexService) {
        let activeRequestKeys: Set<String> = Set(messages.compactMap { message in
            guard message.kind == .userInputPrompt,
                  let request = message.structuredUserInputRequest else {
                return nil
            }
            return codex.idKey(from: request.requestID)
        })

        dismissedStructuredPlanPromptRequestKeys = dismissedStructuredPlanPromptRequestKeys.intersection(activeRequestKeys)
        dismissingStructuredPlanPromptRequestKeys = dismissingStructuredPlanPromptRequestKeys.intersection(activeRequestKeys)
    }

    func approve(
        _ request: CodexApprovalRequest,
        codex: CodexService,
        forSession: Bool = false,
        completion: @escaping @MainActor (Bool) -> Void
    ) {
        Task { @MainActor in
            isHandlingApproval = true
            defer { isHandlingApproval = false }

            do {
                try await codex.approvePendingRequest(request, forSession: forSession)
                completion(true)
            } catch {
                // Error message already stored in CodexService.
                if let serviceError = error as? CodexServiceError,
                   case .noPendingApproval = serviceError {
                    completion(true)
                } else {
                    completion(false)
                }
            }
        }
    }

    func decline(
        _ request: CodexApprovalRequest,
        codex: CodexService,
        completion: @escaping @MainActor (Bool) -> Void
    ) {
        Task { @MainActor in
            isHandlingApproval = true
            defer { isHandlingApproval = false }

            do {
                try await codex.declinePendingRequest(request)
                completion(true)
            } catch {
                // Error message already stored in CodexService.
                if let serviceError = error as? CodexServiceError,
                   case .noPendingApproval = serviceError {
                    completion(true)
                } else {
                    completion(false)
                }
            }
        }
    }
}
