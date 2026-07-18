// FILE: TurnComposerDraftPersistenceTests.swift
// Purpose: Verifies local composer draft restoration and send failure behavior.
// Layer: Unit Test
// Exports: TurnComposerDraftPersistenceTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class TurnComposerDraftPersistenceTests: TurnComposerSendTestCase {
    func testSendTurnRestoresRawDraftWhenStartTurnFails() async {
        let service = makeService()
        service.isConnected = true

        let viewModel = TurnViewModel()
        let rawInput = "Please update @TurnView.swift"
        let rawMention = TurnComposerMentionedFile(
            fileName: "TurnView.swift",
            path: "Views/Turn/TurnView.swift"
        )
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )

        viewModel.input = rawInput
        viewModel.composerMentionedFiles = [rawMention]
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-1", state: .ready(attachment))
        ]

        viewModel.sendTurn(codex: service, threadID: "thread-send-failure")
        await waitForSendCompletion(viewModel)

        XCTAssertFalse(viewModel.isSending)
        XCTAssertEqual(viewModel.input, rawInput)
        XCTAssertEqual(viewModel.composerMentionedFiles, [rawMention])
        XCTAssertEqual(viewModel.readyComposerAttachments, [attachment])
        XCTAssertEqual(viewModel.composerAttachments.count, 1)
    }

    func testLocalDraftRestoresComposerStateForSameThread() {
        let service = makeService()
        let firstViewModel = TurnViewModel()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )

        firstViewModel.input = "Draft with @TurnView.swift"
        firstViewModel.composerMentionedFiles = [
            TurnComposerMentionedFile(fileName: "TurnView.swift", path: "Views/Turn/TurnView.swift")
        ]
        firstViewModel.composerMentionedSkills = [
            TurnComposerMentionedSkill(name: "check-code", path: "/skills/check-code/SKILL.md", description: "Review")
        ]
        firstViewModel.composerMentionedPlugins = [
            TurnComposerMentionedPlugin(name: "github", path: "plugin://github", displayName: "GitHub")
        ]
        firstViewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-1", state: .ready(attachment))
        ]
        firstViewModel.isPlanModeArmed = true
        firstViewModel.isSubagentsSelectionArmed = true
        firstViewModel.saveLocalDraft(codex: service, threadID: "thread-draft")

        let secondViewModel = TurnViewModel()
        secondViewModel.restoreSavedLocalDraftIfNeeded(codex: service, threadID: "thread-draft")

        XCTAssertEqual(secondViewModel.input, firstViewModel.input)
        XCTAssertEqual(secondViewModel.composerMentionedFiles, firstViewModel.composerMentionedFiles)
        XCTAssertEqual(secondViewModel.composerMentionedSkills, firstViewModel.composerMentionedSkills)
        XCTAssertEqual(secondViewModel.composerMentionedPlugins, firstViewModel.composerMentionedPlugins)
        XCTAssertEqual(secondViewModel.readyComposerAttachments, [attachment])
        XCTAssertTrue(secondViewModel.isPlanModeArmed)
        XCTAssertTrue(secondViewModel.isSubagentsSelectionArmed)
    }

    func testLocalDraftReflectsRemovedAttachment() {
        let service = makeService()
        let viewModel = TurnViewModel()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )

        viewModel.input = "Keep the text only"
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "attachment-1", state: .ready(attachment))
        ]
        viewModel.saveLocalDraft(codex: service, threadID: "thread-draft-removal")

        viewModel.removeComposerAttachment(id: "attachment-1")
        viewModel.saveLocalDraft(codex: service, threadID: "thread-draft-removal")

        XCTAssertEqual(service.composerDraft(for: "thread-draft-removal")?.input, "Keep the text only")
        XCTAssertEqual(service.composerDraft(for: "thread-draft-removal")?.attachments, [])
    }

    func testLocalDraftClearsAfterSuccessfulSend() async {
        let service = makeService()
        service.isConnected = true
        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "turn/start")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-sent")]),
                includeJSONRPC: false
            )
        }

        let viewModel = TurnViewModel()
        viewModel.input = "Send this"
        viewModel.saveLocalDraft(codex: service, threadID: "thread-draft-clear")

        viewModel.sendTurn(codex: service, threadID: "thread-draft-clear")
        await waitForSendCompletion(viewModel)

        XCTAssertNil(service.composerDraft(for: "thread-draft-clear"))
    }

    func testLocalDraftSurvivesFailedSend() async {
        let service = makeService()
        service.isConnected = true

        let viewModel = TurnViewModel()
        viewModel.input = "Retry this later"
        viewModel.saveLocalDraft(codex: service, threadID: "thread-draft-failure")

        viewModel.sendTurn(codex: service, threadID: "thread-draft-failure")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(service.composerDraft(for: "thread-draft-failure")?.input, "Retry this later")
        XCTAssertEqual(viewModel.input, "Retry this later")
    }
}
