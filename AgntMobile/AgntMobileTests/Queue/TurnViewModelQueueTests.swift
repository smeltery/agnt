// FILE: TurnViewModelQueueTests.swift
// Purpose: Validates client-side per-thread turn queue send and flush behavior.
// Layer: Unit Test
// Exports: TurnViewModelQueueTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class TurnViewModelQueueTests: TurnViewModelQueueTestCase {
    func testSendTurnQueuesImmediatelyWhenThreadBusy() async throws {
        let service = makeService()
        service.isConnected = true
        service.runningThreadIDs.insert("thread-queue")
        service.activeTurnIdByThread["thread-queue"] = "turn-live"

        let viewModel = makeViewModel()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,AAAA"
        )
        var recordedMethods: [String] = []

        viewModel.input = "Please inspect @TurnView.swift"
        viewModel.composerMentionedFiles = [
            TurnComposerMentionedFile(
                fileName: "TurnView.swift",
                path: "AgntMobile/Views/Turn/TurnView.swift"
            )
        ]
        viewModel.composerMentionedSkills = [
            TurnComposerMentionedSkill(
                name: "check-code",
                path: "/Users/me/.codex/skills/check-code/SKILL.md",
                description: "Review code"
            )
        ]
        viewModel.composerAttachments = [
            TurnComposerImageAttachment(id: "att-1", state: .ready(attachment))
        ]
        service.requestTransportOverride = { method, params in
            recordedMethods.append(method)
            XCTFail("sendTurn should queue instead of calling \(method) while the thread is busy")
            return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
        }

        viewModel.sendTurn(codex: service, threadID: "thread-queue")
        await waitForSendCompletion(viewModel)

        XCTAssertTrue(recordedMethods.isEmpty)
        XCTAssertEqual(viewModel.queuedCount(codex: service, threadID: "thread-queue"), 1)
        XCTAssertTrue(viewModel.input.isEmpty)
        XCTAssertTrue(viewModel.composerMentionedFiles.isEmpty)
        XCTAssertTrue(viewModel.composerMentionedSkills.isEmpty)
        XCTAssertTrue(viewModel.composerAttachments.isEmpty)
        XCTAssertFalse(viewModel.isQueuePaused(codex: service, threadID: "thread-queue"))
        let queuedDraft = try XCTUnwrap(service.queuedTurnDraftsByThread["thread-queue"]?.first)
        XCTAssertEqual(queuedDraft.text, "Please inspect @AgntMobile/Views/Turn/TurnView.swift")
        XCTAssertEqual(queuedDraft.skillMentions.map(\.id), ["check-code"])
        XCTAssertEqual(queuedDraft.attachments.count, 1)
        XCTAssertTrue(service.messagesByThread["thread-queue"]?.isEmpty ?? true)
    }

    func testFlushQueueDoesNothingWhenDisconnected() {
        let service = makeService()
        service.isConnected = false

        let viewModel = makeViewModel()
        service.queuedTurnDraftsByThread["thread-queue"] = [makeDraft(text: "queued")]

        viewModel.flushQueueIfPossible(codex: service, threadID: "thread-queue")

        XCTAssertEqual(viewModel.queuedCount(codex: service, threadID: "thread-queue"), 1)
        XCTAssertFalse(viewModel.isSending)
    }

    func testFlushQueueDoesNothingWhenThreadBusy() {
        let service = makeService()
        service.isConnected = true
        service.runningThreadIDs.insert("thread-queue")

        let viewModel = makeViewModel()
        service.queuedTurnDraftsByThread["thread-queue"] = [makeDraft(text: "queued")]

        viewModel.flushQueueIfPossible(codex: service, threadID: "thread-queue")

        XCTAssertEqual(viewModel.queuedCount(codex: service, threadID: "thread-queue"), 1)
        XCTAssertFalse(viewModel.isSending)
    }

    func testFlushQueueDoesNothingWhenProtectedRunningFallbackIsActive() {
        let service = makeService()
        service.isConnected = true
        service.protectedRunningFallbackThreadIDs.insert("thread-queue")

        let viewModel = makeViewModel()
        service.queuedTurnDraftsByThread["thread-queue"] = [makeDraft(text: "queued")]

        viewModel.flushQueueIfPossible(codex: service, threadID: "thread-queue")

        XCTAssertEqual(viewModel.queuedCount(codex: service, threadID: "thread-queue"), 1)
        XCTAssertFalse(viewModel.isSending)
    }

    func testFlushQueueFailureRequeuesAndPausesQueue() async {
        let service = makeService()
        service.isConnected = true

        let viewModel = makeViewModel()
        service.queuedTurnDraftsByThread["thread-queue"] = [makeDraft(text: "queued")]

        viewModel.flushQueueIfPossible(codex: service, threadID: "thread-queue")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(viewModel.queuedCount(codex: service, threadID: "thread-queue"), 1)
        XCTAssertTrue(viewModel.isQueuePaused(codex: service, threadID: "thread-queue"))
        XCTAssertNotNil(viewModel.queuePauseMessage(codex: service, threadID: "thread-queue"))
        XCTAssertEqual(service.lastErrorMessage?.hasPrefix("Queue paused:"), true)
    }

    func testResumeQueueClearsPauseState() {
        let service = makeService()
        service.isConnected = false

        let viewModel = makeViewModel()
        service.queuedTurnDraftsByThread["thread-queue"] = [makeDraft(text: "queued")]
        service.queuePauseStateByThread["thread-queue"] = .paused(errorMessage: "temporary")

        viewModel.resumeQueueAndFlushIfPossible(codex: service, threadID: "thread-queue")

        XCTAssertFalse(viewModel.isQueuePaused(codex: service, threadID: "thread-queue"))
        XCTAssertEqual(viewModel.queuedCount(codex: service, threadID: "thread-queue"), 1)
    }

    func testQueuedDraftsPersistAcrossViewModelRecreationForSameThread() {
        let service = makeService()
        service.isConnected = true
        service.runningThreadIDs.insert("thread-queue")

        let firstViewModel = makeViewModel()
        firstViewModel.input = "Message one"
        firstViewModel.sendTurn(codex: service, threadID: "thread-queue")

        let secondViewModel = makeViewModel()
        XCTAssertEqual(secondViewModel.queuedCount(codex: service, threadID: "thread-queue"), 1)
        XCTAssertEqual(secondViewModel.queuedCount(codex: service, threadID: "other-thread"), 0)
    }

    func testSendTurnStartsImmediatelyWhenRunningFlagRefreshClearsStaleBusyState() async {
        let service = makeService()
        service.isConnected = true
        service.runningThreadIDs.insert("thread-queue")
        service.resumedThreadIDs.insert("thread-queue")

        var recordedMethods: [String] = []
        service.requestTransportOverride = { method, _ in
            recordedMethods.append(method)
            if method == "thread/read" {
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "turns": .array([])
                        ])
                    ]),
                    includeJSONRPC: false
                )
            }

            XCTAssertEqual(method, "turn/start")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-new")]),
                includeJSONRPC: false
            )
        }

        let viewModel = makeViewModel()
        viewModel.input = "send now"

        viewModel.sendTurn(codex: service, threadID: "thread-queue")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(recordedMethods, ["thread/read", "turn/start"])
        XCTAssertEqual(viewModel.queuedCount(codex: service, threadID: "thread-queue"), 0)
        XCTAssertEqual(service.activeTurnID(for: "thread-queue"), "turn-new")
    }

    func testSendTurnQueuesAfterBusyRefreshConfirmsActiveRun() async {
        let service = makeService()
        service.isConnected = true
        service.runningThreadIDs.insert("thread-queue")

        var recordedMethods: [String] = []
        service.requestTransportOverride = { method, params in
            recordedMethods.append(method)
            if method == "thread/read" {
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "turns": .array([
                                .object([
                                    "id": .string("turn-fallback"),
                                    "status": .string("in_progress"),
                                ])
                            ])
                        ])
                    ]),
                    includeJSONRPC: false
                )
            }

            XCTFail("sendTurn should not steer automatically after busy refresh")
            return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
        }

        let viewModel = makeViewModel()
        viewModel.input = "Follow up now"

        viewModel.sendTurn(codex: service, threadID: "thread-queue")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(recordedMethods, ["thread/read"])
        XCTAssertEqual(viewModel.queuedCount(codex: service, threadID: "thread-queue"), 1)
        XCTAssertEqual(service.queuedTurnDraftsByThread["thread-queue"]?.first?.text, "Follow up now")
        XCTAssertTrue(service.messagesByThread["thread-queue"]?.isEmpty ?? true)
    }

    func testSendTurnStoresOnlyConfirmedFileMentionsOnUserMessage() async throws {
        let service = makeService()
        service.isConnected = true
        service.resumedThreadIDs.insert("thread-queue")
        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "turn/start")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-new")]),
                includeJSONRPC: false
            )
        }

        let viewModel = makeViewModel()
        viewModel.input = "Please inspect @TurnView.swift"
        viewModel.composerMentionedFiles = [
            TurnComposerMentionedFile(
                fileName: "TurnView.swift",
                path: "AgntMobile/Views/Turn/TurnView.swift"
            )
        ]

        viewModel.sendTurn(codex: service, threadID: "thread-queue")
        await waitForSendCompletion(viewModel)

        let message = try XCTUnwrap(service.messagesByThread["thread-queue"]?.last)
        XCTAssertEqual(message.text, "Please inspect @AgntMobile/Views/Turn/TurnView.swift")
        XCTAssertEqual(message.fileMentions, ["AgntMobile/Views/Turn/TurnView.swift"])
    }

    func testSendTurnDoesNotStoreManualFileLikeTextAsConfirmedMention() async throws {
        let service = makeService()
        service.isConnected = true
        service.resumedThreadIDs.insert("thread-queue")
        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "turn/start")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-new")]),
                includeJSONRPC: false
            )
        }

        let viewModel = makeViewModel()
        viewModel.input = "Please inspect @AgntMobile/Views/Turn/TurnView.swift"

        viewModel.sendTurn(codex: service, threadID: "thread-queue")
        await waitForSendCompletion(viewModel)

        let message = try XCTUnwrap(service.messagesByThread["thread-queue"]?.last)
        XCTAssertEqual(message.text, "Please inspect @AgntMobile/Views/Turn/TurnView.swift")
        XCTAssertTrue(message.fileMentions.isEmpty)
    }

    func testFlushQueuePreservesPlanModeFromBusyThreadQueue() async {
        let service = makeService()
        service.isConnected = true
        service.runningThreadIDs.insert("thread-queue")
        service.supportsTurnCollaborationMode = true
        service.selectedModelId = "gpt-5.3-codex"

        let viewModel = makeViewModel()
        viewModel.isPlanModeArmed = true
        viewModel.input = "Plan the rollout"

        viewModel.sendTurn(codex: service, threadID: "thread-queue")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(viewModel.queuedCount(codex: service, threadID: "thread-queue"), 1)
        XCTAssertEqual(
            service.queuedTurnDraftsByThread["thread-queue"]?.first?.collaborationMode,
            .plan
        )

        service.runningThreadIDs.remove("thread-queue")
        service.activeTurnIdByThread["thread-queue"] = nil

        var capturedParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/start")
            capturedParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-plan")]),
                includeJSONRPC: false
            )
        }

        viewModel.flushQueueIfPossible(codex: service, threadID: "thread-queue")
        await waitForSendCompletion(viewModel)

        XCTAssertEqual(
            capturedParams?.objectValue?["collaborationMode"]?.objectValue?["mode"]?.stringValue,
            CodexCollaborationModeKind.plan.rawValue
        )
        XCTAssertEqual(viewModel.queuedCount(codex: service, threadID: "thread-queue"), 0)
    }

    func testSendTurnQueuesWhenBusyEvenIfActiveTurnMappingExists() async {
        let service = makeService()
        service.isConnected = true
        service.runningThreadIDs.insert("thread-queue")
        service.activeTurnIdByThread["thread-queue"] = "turn-live"

        var recordedMethods: [String] = []
        service.requestTransportOverride = { method, _ in
            recordedMethods.append(method)
            XCTFail("sendTurn should not call \(method) while an active turn exists")
            return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
        }

        let viewModel = makeViewModel()
        viewModel.input = "Retry as new turn"

        viewModel.sendTurn(codex: service, threadID: "thread-queue")
        await waitForSendCompletion(viewModel)

        XCTAssertTrue(recordedMethods.isEmpty)
        XCTAssertEqual(viewModel.queuedCount(codex: service, threadID: "thread-queue"), 1)
        XCTAssertEqual(service.queuedTurnDraftsByThread["thread-queue"]?.first?.text, "Retry as new turn")
        XCTAssertTrue(service.messagesByThread["thread-queue"]?.isEmpty ?? true)
    }
}
