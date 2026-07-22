import SwiftUI

extension TurnView {
    var composerRecoveryAccessory: AnyView? {
        if let voiceRecoveryPresentation {
            return AnyView(
                ConnectionRecoveryCard(
                    snapshot: voiceRecoveryPresentation.snapshot,
                    onTap: {
                        handleVoiceRecoveryAction(voiceRecoveryPresentation.action)
                    },
                    onDismiss: {
                        clearVoiceRecovery()
                    }
                )
            )
        }

        guard let snapshot = connectionRecoverySnapshot else {
            return nil
        }

        return AnyView(
            ConnectionRecoveryCard(snapshot: snapshot) {
                handleConnectionRecoveryAction()
            }
        )
    }

    // Keeps reconnect prompts out of the red footer error slot; recovery UI owns that state.
    var timelineFooterErrorMessage: String? {
        guard let message = codex.lastErrorMessage?.trimmingCharacters(in: .whitespacesAndNewlines),
              !message.isEmpty else {
            return nil
        }

        if isConnectionRecoveryFooterNoise(message)
            || isUnmaterializedThreadFooterNoise(message)
            || isCancellationFooterNoise(message) {
            return nil
        }

        return message
    }

    func isConnectionRecoveryFooterNoise(_ message: String) -> Bool {
        let normalizedMessage = message.lowercased()
        return normalizedMessage.contains("tap reconnect")
            || normalizedMessage.hasPrefix("connection was interrupted")
            || normalizedMessage.hasPrefix("connection timed out")
            || normalizedMessage.hasPrefix("trying to reconnect")
    }

    func isUnmaterializedThreadFooterNoise(_ message: String) -> Bool {
        let normalizedMessage = message.lowercased()
        return normalizedMessage.contains("not materialized")
            || normalizedMessage.contains("not yet materialized")
            || (
                normalizedMessage.contains("thread/turns/list")
                    && normalizedMessage.contains("unavailable")
            )
    }

    func isCancellationFooterNoise(_ message: String) -> Bool {
        let normalizedMessage = message.lowercased()
        return normalizedMessage.contains("cancellationerror")
            || normalizedMessage.contains("cancelled")
            || normalizedMessage.contains("canceled")
    }

    var connectionRecoverySnapshot: ConnectionRecoverySnapshot? {
        TurnConnectionRecoverySnapshotBuilder.makeSnapshot(
            hasReconnectCandidate: codex.hasReconnectCandidate,
            isConnected: codex.isConnected,
            secureConnectionState: codex.secureConnectionState,
            showsWakeSavedMacDisplayAction: shouldOfferWakeSavedMacDisplayAction,
            isWakingMacDisplayRecovery: isWakingMacDisplayRecovery,
            isConnecting: codex.isConnecting,
            shouldAutoReconnectOnForeground: codex.shouldAutoReconnectOnForeground,
            isRetryingConnectionRecovery: isRetryingConnectionRecovery,
            lastErrorMessage: codex.lastErrorMessage
        )
    }

    var canWakeSavedMacDisplay: Bool {
        codex.canWakePreferredMacDisplay
    }

    // Matches the root fallback gate so the turn card only offers wake after the silent attempt already ran.
    var shouldOfferWakeSavedMacDisplayAction: Bool {
        canWakeSavedMacDisplay && wakeMacDisplayAction != nil
    }

    var isRetryingConnectionRecovery: Bool {
        if case .retrying = codex.connectionRecoveryState {
            return true
        }
        return false
    }
    func handleConnectionRecoveryAction() {
        if shouldOfferWakeSavedMacDisplayAction {
            wakeMacDisplayAction?()
            return
        }

        reconnectAction?()
    }
}
