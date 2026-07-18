import Foundation

enum VoiceRecoveryAction: Equatable {
    case reconnect
    case showSetupHelp
    case openSystemSettings
    case none
}

struct VoiceRecoveryPresentation: Equatable {
    let snapshot: ConnectionRecoverySnapshot
    let action: VoiceRecoveryAction
}

enum TurnVoiceRecoveryPresentationBuilder {
    static func makePresentation(for reason: CodexVoiceFailureReason) -> VoiceRecoveryPresentation {
        switch reason {
        case .reconnectRequired:
            return VoiceRecoveryPresentation(
                snapshot: ConnectionRecoverySnapshot(
                    title: "Voice Mode",
                    summary: "Reconnect to your computer to use voice mode.",
                    detail: "Keep the agnt bridge running on your paired computer, then try the microphone again.",
                    status: .interrupted,
                    trailingStyle: .action("Reconnect")
                ),
                action: .reconnect
            )
        case .bridgeSessionUnsupported:
            return VoiceRecoveryPresentation(
                snapshot: ConnectionRecoverySnapshot(
                    title: "Voice Mode",
                    summary: "This bridge session does not support voice mode yet.",
                    detail: "Restart agnt on your computer, then reconnect this iPhone. If it still happens, update agnt on your computer and pair again.",
                    status: .actionRequired,
                    trailingStyle: .action("Reconnect")
                ),
                action: .reconnect
            )
        case .macLoginRequired:
            return VoiceRecoveryPresentation(
                snapshot: ConnectionRecoverySnapshot(
                    title: "Voice Mode",
                    summary: "Sign in to ChatGPT on your computer to use voice mode.",
                    detail: "Open ChatGPT on the paired computer, sign in there, then come back here and try again.",
                    status: .actionRequired,
                    trailingStyle: .action("How To Fix")
                ),
                action: .showSetupHelp
            )
        case .macReauthenticationRequired:
            return VoiceRecoveryPresentation(
                snapshot: ConnectionRecoverySnapshot(
                    title: "Voice Mode",
                    summary: "ChatGPT voice needs a fresh sign-in on your computer.",
                    detail: "Open ChatGPT on the paired computer, sign in again there, then retry voice mode here.",
                    status: .actionRequired,
                    trailingStyle: .action("How To Fix")
                ),
                action: .showSetupHelp
            )
        case .voiceSyncInProgress:
            return VoiceRecoveryPresentation(
                snapshot: ConnectionRecoverySnapshot(
                    title: "Voice Mode",
                    summary: "Voice mode is still syncing from your computer.",
                    detail: "Keep the bridge connected for a moment, then try again.",
                    status: .syncing,
                    trailingStyle: .progress
                ),
                action: .none
            )
        case .chatGPTRequired:
            return VoiceRecoveryPresentation(
                snapshot: ConnectionRecoverySnapshot(
                    title: "Voice Mode",
                    summary: "Voice mode needs a ChatGPT session on your computer.",
                    detail: "API-key-only auth is not enough here. Sign in to ChatGPT on the paired computer, then try again.",
                    status: .actionRequired,
                    trailingStyle: .action("How To Fix")
                ),
                action: .showSetupHelp
            )
        case .microphonePermissionRequired:
            return VoiceRecoveryPresentation(
                snapshot: ConnectionRecoverySnapshot(
                    title: "Voice Mode",
                    summary: "Microphone access is off for agnt.",
                    detail: "Open iPhone Settings, allow Microphone for agnt, then try recording again.",
                    status: .actionRequired,
                    trailingStyle: .action("Open Settings")
                ),
                action: .openSystemSettings
            )
        case .microphoneUnavailable:
            return VoiceRecoveryPresentation(
                snapshot: ConnectionRecoverySnapshot(
                    title: "Voice Mode",
                    summary: "No microphone input is available right now.",
                    detail: "Check that another app is not holding the microphone, then try again.",
                    status: .actionRequired,
                    trailingStyle: .none
                ),
                action: .none
            )
        case .recorderUnavailable:
            return VoiceRecoveryPresentation(
                snapshot: ConnectionRecoverySnapshot(
                    title: "Voice Mode",
                    summary: "agnt could not start the recorder.",
                    detail: "Close other audio-heavy apps, then try voice mode again.",
                    status: .actionRequired,
                    trailingStyle: .none
                ),
                action: .none
            )
        case .generic(let message):
            return VoiceRecoveryPresentation(
                snapshot: ConnectionRecoverySnapshot(
                    title: "Voice Mode",
                    summary: message,
                    status: .actionRequired,
                    trailingStyle: .none
                ),
                action: .none
            )
        }
    }
}
