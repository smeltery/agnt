// FILE: CodexService+Voice.swift
// Purpose: Transcribes local voice clips through the bridge, with the legacy phone upload as a reliability fallback.
// Layer: Service
// Exports: CodexVoiceTranscriptionPreflight, CodexService voice helpers
// Depends on: Foundation, RPCMessage, JSONValue

import Foundation

struct CodexVoiceTranscriptionPreflight: Equatable, Sendable {
    static let maxDurationSeconds: TimeInterval = 120
    static let maxByteCount: Int = 10 * 1024 * 1024
    static let requestTimeoutNanoseconds: UInt64 = 180_000_000_000

    let byteCount: Int
    let durationSeconds: TimeInterval

    var failureMessage: String? {
        if !durationSeconds.isFinite || durationSeconds <= 0 {
            return "Voice clips must include recorded audio."
        }

        if durationSeconds > Self.maxDurationSeconds {
            return "Voice clips must be 120 seconds or less."
        }

        if byteCount > Self.maxByteCount {
            return "Voice clips must be smaller than 10 MB."
        }

        return nil
    }

    func validate() throws {
        if let failureMessage {
            throw CodexServiceError.invalidInput(failureMessage)
        }
    }
}

extension CodexService {
    // Prefers bridge-owned transcription, then falls back to the prior phone-upload flow if the bridge/provider rejects it.
    func transcribeVoiceAudioFile(at url: URL, durationSeconds: TimeInterval) async throws -> String {
        guard isConnected else {
            throw CodexServiceError.disconnected
        }

        let audioData = try Data(contentsOf: url)
        let preflight = CodexVoiceTranscriptionPreflight(
            byteCount: audioData.count,
            durationSeconds: durationSeconds
        )
        try preflight.validate()

        do {
            return try await transcribeVoiceViaBridge(audioData: audioData, durationSeconds: durationSeconds)
        } catch {
            let bridgeMethodUnsupported = consumeUnsupportedVoiceBridgeAuth(error)
            if bridgeMethodUnsupported || shouldAttemptLegacyVoiceUploadFallback(after: error) {
                do {
                    return try await transcribeVoiceDirectlyFromPhone(audioData: audioData)
                } catch {
                    handleVoiceTranscriptionTerminalFailure(error)
                    throw error
                }
            }

            handleVoiceTranscriptionTerminalFailure(error)
            throw error
        }
    }

    private func transcribeVoiceViaBridge(audioData: Data, durationSeconds: TimeInterval) async throws -> String {
        let response = try await sendRequest(
            method: "voice/transcribe",
            params: .object([
                "mimeType": .string("audio/wav"),
                "audioBase64": .string(audioData.base64EncodedString()),
                "sampleRateHz": .integer(24_000),
                "durationMs": .integer(Int((durationSeconds * 1_000).rounded())),
            ]),
            timeoutNanoseconds: CodexVoiceTranscriptionPreflight.requestTimeoutNanoseconds,
            timeoutMessage: "Voice transcription timed out. Try a shorter clip or retry when the connection is stable."
        )

        guard let text = response.result?.objectValue?["text"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else {
            throw CodexServiceError.invalidResponse("voice/transcribe did not return transcript text")
        }

        return text
    }

    private func shouldAttemptLegacyVoiceUploadFallback(after error: Error) -> Bool {
        switch classifyVoiceFailure(error) {
        case .macReauthenticationRequired, .bridgeSessionUnsupported:
            return true
        default:
            return false
        }
    }

    private func transcribeVoiceDirectlyFromPhone(audioData: Data) async throws -> String {
        let token: String
        do {
            token = try await resolveVoiceAuthToken()
        } catch {
            Task { await refreshGPTAccountState() }
            throw error
        }

        do {
            return try await GPTVoiceTranscriptionManager.transcribe(wavData: audioData, token: token)
        } catch GPTVoiceTranscriptionError.authExpired {
            Task { await refreshGPTAccountState() }
            let freshToken = try await resolveVoiceAuthToken()
            do {
                return try await GPTVoiceTranscriptionManager.transcribe(wavData: audioData, token: freshToken)
            } catch GPTVoiceTranscriptionError.authExpired {
                markGPTVoiceReauthenticationRequired()
                throw GPTVoiceTranscriptionError.authExpired
            }
        } catch {
            Task { await refreshGPTAccountState() }
            throw error
        }
    }

    private func handleVoiceTranscriptionTerminalFailure(_ error: Error) {
        switch classifyVoiceFailure(error) {
        case .macReauthenticationRequired:
            markGPTVoiceReauthenticationRequired()
        default:
            Task { await refreshGPTAccountState() }
        }
    }

    // Asks the bridge for an ephemeral ChatGPT token over the E2E encrypted channel.
    private func resolveVoiceAuthToken() async throws -> String {
        let response: RPCMessage
        do {
            response = try await sendRequest(method: "voice/resolveAuth", params: nil)
        } catch {
            _ = consumeUnsupportedVoiceBridgeAuth(error)
            throw error
        }

        guard let payload = response.result?.objectValue,
              let rawToken = payload["token"]?.stringValue else {
            throw CodexServiceError.invalidResponse("voice/resolveAuth did not return a valid token")
        }

        let token = rawToken
            .replacingOccurrences(of: #"(?i)^bearer\s+"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            throw CodexServiceError.invalidResponse("voice/resolveAuth did not return a valid token")
        }

        return token
    }
}
