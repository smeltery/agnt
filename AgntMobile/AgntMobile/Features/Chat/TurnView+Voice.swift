// FILE: TurnView+Voice.swift
// Purpose: Handles turn composer voice recording, transcription, and recovery UI state.
// Layer: View Extension
// Exports: TurnView voice helpers
// Depends on: SwiftUI, UIKit, CodexService voice APIs

import SwiftUI
import UIKit

extension TurnView {
    var voiceRecoveryPresentation: VoiceRecoveryPresentation? {
        guard let voiceRecoveryReason else {
            return nil
        }

        guard let resolvedReason = codex.resolveVoiceRecoveryReason(voiceRecoveryReason) else {
            return nil
        }

        return buildVoiceRecoveryPresentation(for: resolvedReason)
    }

    // Mirrors the mic CTA state so the composer can swap between ready, record, and stop.
    var voiceButtonPresentation: TurnComposerVoiceButtonPresentation {
        if isVoiceTranscribing {
            return TurnComposerVoiceButtonPresentation(
                systemImageName: "waveform",
                foregroundColor: Color(.secondaryLabel),
                backgroundColor: Color(.systemGray5),
                accessibilityLabel: "Transcribing voice note",
                isDisabled: true,
                showsProgress: true,
                hasCircleBackground: true
            )
        }

        if isVoicePreflighting {
            return TurnComposerVoiceButtonPresentation(
                systemImageName: "hourglass",
                foregroundColor: Color(.secondaryLabel),
                backgroundColor: Color(.systemGray5),
                accessibilityLabel: "Preparing microphone",
                isDisabled: true,
                showsProgress: true,
                hasCircleBackground: true
            )
        }

        if isVoiceRecording {
            return TurnComposerVoiceButtonPresentation(
                systemImageName: "stop.fill",
                foregroundColor: Color(.systemBackground),
                backgroundColor: Color(.systemRed),
                accessibilityLabel: "Stop voice recording",
                isDisabled: false,
                showsProgress: false,
                hasCircleBackground: true
            )
        }

        return TurnComposerVoiceButtonPresentation(
            systemImageName: "mic",
            foregroundColor: Color(.secondaryLabel),
            backgroundColor: .clear,
            accessibilityLabel: "Start voice transcription",
            isDisabled: !codex.isConnected,
            showsProgress: false,
            hasCircleBackground: false
        )
    }

    // Switches the mic button between login, recording, and transcription states.
    func handleVoiceButtonTap() {
        if isVoiceTranscribing {
            return
        }

        if isVoiceRecording {
            Task { @MainActor in
                await stopVoiceTranscription()
            }
            return
        }

        Task { @MainActor in
            await startVoiceRecordingIfReady()
        }
    }

    // Stops the recorder, transcribes through the bridge, and appends the final text into the draft.
    func stopVoiceTranscription() async {
        hasTriggeredVoiceAutoStop = false
        isVoiceTranscribing = true
        defer { isVoiceTranscribing = false }

        do {
            guard let clip = try voiceTranscriptionManager.stopRecording() else {
                isVoiceRecording = false
                voiceTranscriptionManager.resetMeteringState()
                return
            }

            defer {
                try? FileManager.default.removeItem(at: clip.url)
            }

            isVoiceRecording = false
            voiceTranscriptionManager.resetMeteringState()
            let transcript = try await codex.transcribeVoiceAudioFile(
                at: clip.url,
                durationSeconds: clip.durationSeconds
            )
            clearVoiceRecovery()
            viewModel.appendVoiceTranscript(transcript)
            // Keep voice flows keyboard-free; users can tap into the draft afterward if they want to edit.
            isInputFocused = false
        } catch {
            isVoiceRecording = false
            voiceTranscriptionManager.resetMeteringState()
            presentVoiceRecovery(for: error)
        }
    }

    // Starts microphone capture directly; auth is resolved when the user stops recording, matching Litter's flow.
    @MainActor
    func startVoiceRecordingIfReady() async {
        guard !isVoicePreflighting else {
            return
        }

        guard codex.supportsBridgeVoiceAuth else {
            presentVoiceRecovery(for: .bridgeSessionUnsupported)
            return
        }

        guard codex.isConnected else {
            presentVoiceRecovery(for: .reconnectRequired)
            return
        }

        clearVoiceRecovery()
        codex.lastErrorMessage = nil
        hasTriggeredVoiceAutoStop = false
        // Dismiss any active text focus before recording so the keyboard does not
        // compete with the waveform UI or waste vertical space during capture.
        isInputFocused = false
        let preflightGeneration = voicePreflightGeneration + 1
        voicePreflightGeneration = preflightGeneration
        isVoicePreflighting = true
        defer {
            if isVoicePreflightCurrent(preflightGeneration) {
                isVoicePreflighting = false
            }
        }

        do {
            guard isVoicePreflightCurrent(preflightGeneration), codex.isConnected else {
                return
            }
            try await voiceTranscriptionManager.startRecording()
            guard isVoicePreflightCurrent(preflightGeneration), codex.isConnected else {
                voiceTranscriptionManager.cancelRecording()
                return
            }
            isVoiceRecording = true
            isInputFocused = false
        } catch {
            presentVoiceRecovery(for: error)
        }
    }

    // Clears any partial microphone capture when the screen leaves the active voice flow.
    func cancelVoiceRecordingIfNeeded() {
        guard isVoiceRecording else {
            return
        }

        voiceTranscriptionManager.cancelRecording()
        isVoiceRecording = false
        hasTriggeredVoiceAutoStop = false
    }

    // Trigger a hair before the hard validation limit so the saved WAV never misses by timer drift.
    var voiceAutoStopThreshold: TimeInterval {
        max(0, CodexVoiceTranscriptionPreflight.maxDurationSeconds - 0.25)
    }

    func clearVoiceRecovery() {
        voiceRecoveryReason = nil
    }

    // Keeps voice failures out of the transcript by routing them into a dedicated recovery accessory.
    func presentVoiceRecovery(for error: Error) {
        presentVoiceRecovery(for: codex.classifyVoiceFailure(error))
    }

    func presentVoiceRecovery(for reason: CodexVoiceFailureReason) {
        voiceRecoveryReason = reason
        codex.lastErrorMessage = nil
    }

    func buildVoiceRecoveryPresentation(for reason: CodexVoiceFailureReason) -> VoiceRecoveryPresentation {
        TurnVoiceRecoveryPresentationBuilder.makePresentation(for: reason)
    }

    func handleVoiceRecoveryAction(_ action: VoiceRecoveryAction) {
        switch action {
        case .reconnect:
            reconnectAction?()
        case .showSetupHelp:
            isShowingVoiceSetupSheet = true
        case .openSystemSettings:
            guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else {
                return
            }
            openURL(settingsURL)
        case .none:
            break
        }
    }

    // Invalidates any in-flight async mic startup so it cannot reopen the recorder after leaving the screen.
    func invalidatePendingVoicePreflight() {
        voicePreflightGeneration += 1
        isVoicePreflighting = false
    }

    func isVoicePreflightCurrent(_ generation: Int) -> Bool {
        generation == voicePreflightGeneration
    }
}
