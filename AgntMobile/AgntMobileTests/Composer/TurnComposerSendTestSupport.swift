// FILE: TurnComposerSendTestSupport.swift
// Purpose: Provides shared fixtures for composer send tests.
// Layer: Unit Test Support
// Exports: TurnComposerSendTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
class TurnComposerSendTestCase: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func makeState(
        isSending: Bool = false,
        isConnected: Bool = true,
        trimmedInput: String = "hello",
        hasReadyImages: Bool = false,
        hasBlockingAttachmentState: Bool = false,
        hasSkillSelection: Bool = false,
        hasPluginSelection: Bool = false,
        hasReviewSelection: Bool = false,
        hasPendingReviewSelection: Bool = false,
        hasSubagentsSelection: Bool = false
    ) -> TurnComposerSendAvailability {
        TurnComposerSendAvailability(
            isSending: isSending,
            isConnected: isConnected,
            trimmedInput: trimmedInput,
            hasReadyImages: hasReadyImages,
            hasBlockingAttachmentState: hasBlockingAttachmentState,
            hasSkillSelection: hasSkillSelection,
            hasPluginSelection: hasPluginSelection,
            hasReviewSelection: hasReviewSelection,
            hasPendingReviewSelection: hasPendingReviewSelection,
            hasSubagentsSelection: hasSubagentsSelection
        )
    }

    func makeAccessoryState(
        hasAttachment: Bool = false,
        hasSkillSelection: Bool = false
    ) -> TurnComposerAccessoryState {
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )

        return TurnComposerAccessoryState(
            queuedDrafts: [],
            canSteerQueuedDrafts: false,
            canRestoreQueuedDrafts: false,
            steeringDraftID: nil,
            composerAttachments: hasAttachment ? [
                TurnComposerImageAttachment(id: "attachment-1", state: .ready(attachment))
            ] : [],
            composerMentionedFiles: [],
            composerMentionedSkills: hasSkillSelection ? [
                TurnComposerMentionedSkill(name: "check-code", path: "/skills/check-code/SKILL.md", description: "Review")
            ] : [],
            composerMentionedPlugins: [],
            composerReviewSelection: nil,
            isSubagentsSelectionArmed: false,
            isPlanModeArmed: false,
            isVoiceRecording: false,
            voiceAudioLevels: [],
            voiceRecordingDuration: 0
        )
    }

    func waitForSendCompletion(_ viewModel: TurnViewModel, maxPollCount: Int = 120) async {
        for _ in 0..<maxPollCount where viewModel.isSending {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    func textInput(from params: JSONValue?) -> String? {
        params?
            .objectValue?["input"]?
            .arrayValue?
            .compactMap(\.objectValue)
            .first(where: { $0["type"]?.stringValue == "text" })?["text"]?
            .stringValue
    }

    func makeService() -> CodexService {
        let suiteName = "TurnComposerSendAvailabilityTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]

        // CodexService currently crashes while deallocating in unit-test environment.
        // Keep instances alive for process lifetime so assertions remain deterministic.
        Self.retainedServices.append(service)
        return service
    }
}
