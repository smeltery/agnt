import Foundation

extension TurnViewModel {
    // Keep the composer draft intact and use its existing send gate.
    func continueAfterStreamFailure(_ failure: CodexStreamFailure, codex: CodexService, threadID: String) {
        guard !isSending, codex.recoverableStreamFailure(for: threadID)?.id == failure.id else { return }
        isSending = true
        Task { @MainActor in
            defer { isSending = false }
            do {
                try await codex.continueAfterStreamFailure(threadId: threadID, failureID: failure.id)
            } catch {
                guard codex.streamRecovery.failures[threadID]?.id == failure.id else { return }
                codex.dismissStreamFailure(threadId: threadID, failureID: failure.id)
                codex.lastErrorMessage = codex.userFacingTurnErrorMessageForFooter(from: error)
            }
        }
    }
}
