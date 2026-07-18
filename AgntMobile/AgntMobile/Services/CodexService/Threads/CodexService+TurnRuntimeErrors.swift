// FILE: CodexService+TurnRuntimeErrors.swift
// Purpose: User-facing turn runtime error mapping and suppression helpers.
// Layer: Service
// Exports: CodexService turn runtime error helpers
// Depends on: CodexServiceError

import Foundation

extension CodexService {
    func userFacingTurnErrorMessage(from error: Error) -> String {
        if isCancellationLikeError(error) {
            return ""
        }

        if shouldTreatSendFailureAsDisconnect(error)
            || isRetryableSavedSessionConnectError(error)
            || isRecoverableTransientConnectionError(error)
            || isBenignBackgroundDisconnect(error) {
            return userFacingConnectFailureMessage(error)
        }

        if let serviceError = error as? CodexServiceError {
            switch serviceError {
            case .rpcError(let rpcError):
                if let mappedMessage = userFacingRuntimeMessage(for: rpcError.message) {
                    return mappedMessage
                }
                let trimmed = rpcError.message.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? serviceError.localizedDescription : trimmed
            default:
                let trimmed = serviceError.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? "Error while sending message" : trimmed
            }
        }

        let trimmed = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Error while sending message" : trimmed
    }

    // Returns nil for internal/transient runtime noise that should not occupy the red footer.
    func userFacingTurnErrorMessageForFooter(from error: Error) -> String? {
        if isCancellationLikeError(error) || shouldSuppressRuntimeErrorInChat(error) {
            return nil
        }

        let message = userFacingTurnErrorMessage(from: error)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? nil : message
    }

    // Converts raw app-server/runtime text into short user-facing copy.
    func userFacingRuntimeMessage(for rawMessage: String) -> String? {
        let normalizedMessage = rawMessage
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !normalizedMessage.isEmpty else {
            return nil
        }

        if isRuntimeMaterializationMessage(normalizedMessage) {
            return "The run is still starting. Try again in a moment."
        }

        if isStaleTurnRuntimeMessage(normalizedMessage) {
            return "That run already finished."
        }

        if isInternalRuntimeCompatibilityMessage(normalizedMessage) {
            return "The paired runtime rejected this request. Reconnect and try again."
        }

        return nil
    }

    // Hides compatibility/materialization internals from chat history and footer surfaces.
    func shouldSuppressRuntimeErrorInChat(_ error: Error) -> Bool {
        if isCancellationLikeError(error) {
            return true
        }

        guard let rawMessage = rawRPCMessage(from: error) else {
            return false
        }

        return shouldSuppressRuntimeMessageInChat(rawMessage)
    }

    func shouldSuppressRuntimeMessageInChat(_ rawMessage: String) -> Bool {
        let normalizedMessage = rawMessage.lowercased()
        return isRuntimeMaterializationMessage(normalizedMessage)
            || isInternalRuntimeCompatibilityMessage(normalizedMessage)
    }

    func rawRPCMessage(from error: Error) -> String? {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return nil
        }

        let trimmedMessage = rpcError.message.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedMessage.isEmpty ? nil : trimmedMessage
    }

    func isCancellationLikeError(_ error: Error) -> Bool {
        if error is CancellationError {
            return true
        }

        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }

    func isRuntimeMaterializationMessage(_ normalizedMessage: String) -> Bool {
        normalizedMessage.contains("not materialized")
            || normalizedMessage.contains("not yet materialized")
    }

    func isStaleTurnRuntimeMessage(_ normalizedMessage: String) -> Bool {
        normalizedMessage.contains("turn already completed")
            || normalizedMessage.contains("already completed")
            || normalizedMessage.contains("already finished")
            || normalizedMessage.contains("turn not found")
            || normalizedMessage.contains("no active turn")
            || normalizedMessage.contains("not in progress")
            || normalizedMessage.contains("not running")
            || normalizedMessage.contains("not active")
    }

    func isInternalRuntimeCompatibilityMessage(_ normalizedMessage: String) -> Bool {
        if normalizedMessage.contains("method not found")
            || normalizedMessage.contains("unknown method")
            || normalizedMessage.contains("unknown field")
            || normalizedMessage.contains("unrecognized field") {
            return true
        }

        return normalizedMessage.contains("thread/turns/list")
            && (
                normalizedMessage.contains("unavailable")
                    || normalizedMessage.contains("unsupported")
                    || normalizedMessage.contains("not found")
            )
    }
}
