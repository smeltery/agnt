// FILE: TurnViewModelQueueSteeringTests.swift
// Purpose: Validates steering queued drafts into active turns.
// Layer: Unit Test
// Exports: TurnViewModelQueueSteeringTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class TurnViewModelQueueSteeringTests: TurnViewModelQueueTestCase {
    func testSteerQueuedDraftRemovesOnlySelectedRowAndPreservesOrder() async {
        let service = makeService()
        service.isConnected = true
        service.runningThreadIDs.insert("thread-queue")
        service.activeTurnIdByThread["thread-queue"] = "turn-live"

        var recordedMethods: [String] = []
        var recordedParams: [JSONValue] = []
        service.requestTransportOverride = { method, params in
            recordedMethods.append(method)
            recordedParams.append(params ?? .null)
            return RPCMessage(id: .string(UUID().uuidString), result: .object(["turnId": .string("turn-live")]), includeJSONRPC: false)
        }

        let viewModel = makeViewModel()
        let first = makeDraft(text: "first")
        let second = makeDraft(text: "second")
        let third = makeDraft(text: "third")
        service.queuedTurnDraftsByThread["thread-queue"] = [first, second, third]

        viewModel.steerQueuedDraft(id: second.id, codex: service, threadID: "thread-queue")
        await waitForSteerCompletion(viewModel)

        XCTAssertEqual(recordedMethods, ["turn/steer"])
        XCTAssertEqual(
            service.queuedTurnDraftsByThread["thread-queue"]?.map(\.id),
            [first.id, third.id]
        )
        XCTAssertEqual(recordedParams.count, 1)
    }

    func testSteerQueuedDraftKeepsFullPayloadShape() async {
        let service = makeService()
        service.isConnected = true
        service.runningThreadIDs.insert("thread-queue")
        service.activeTurnIdByThread["thread-queue"] = "turn-live"

        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,BBBB"
        )
        let draft = QueuedTurnDraft(
            id: "draft-rich",
            text: "Please inspect this",
            attachments: [attachment],
            skillMentions: [
                CodexTurnSkillMention(
                    id: "check-code",
                    name: "check-code",
                    path: "/Users/me/.codex/skills/check-code/SKILL.md"
                )
            ],
            collaborationMode: nil,
            createdAt: Date()
        )

        var capturedParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/steer")
            capturedParams = params
            return RPCMessage(id: .string(UUID().uuidString), result: .object(["turnId": .string("turn-live")]), includeJSONRPC: false)
        }

        let viewModel = makeViewModel()
        service.queuedTurnDraftsByThread["thread-queue"] = [draft]

        viewModel.steerQueuedDraft(id: draft.id, codex: service, threadID: "thread-queue")
        await waitForSteerCompletion(viewModel)

        let paramsObject = capturedParams?.objectValue
        let inputItems = paramsObject?["input"]?.arrayValue ?? []
        XCTAssertEqual(paramsObject?["threadId"]?.stringValue, "thread-queue")
        XCTAssertEqual(paramsObject?["expectedTurnId"]?.stringValue, "turn-live")
        XCTAssertEqual(inputItems.count, 3)
        XCTAssertEqual(inputItems[0].objectValue?["type"]?.stringValue, "image")
        XCTAssertEqual(inputItems[0].objectValue?["url"]?.stringValue, attachment.payloadDataURL)
        XCTAssertEqual(inputItems[1].objectValue?["type"]?.stringValue, "text")
        XCTAssertEqual(inputItems[1].objectValue?["text"]?.stringValue, draft.text)
        XCTAssertEqual(inputItems[2].objectValue?["type"]?.stringValue, "skill")
        XCTAssertEqual(inputItems[2].objectValue?["id"]?.stringValue, "check-code")
    }

    func testSteerQueuedDraftPreservesPlanMode() async {
        let service = makeService()
        service.isConnected = true
        service.runningThreadIDs.insert("thread-queue")
        service.activeTurnIdByThread["thread-queue"] = "turn-live"
        service.selectedModelId = "gpt-5.3-codex"

        let draft = QueuedTurnDraft(
            id: "draft-plan",
            text: "Plan the rollout",
            attachments: [],
            skillMentions: [],
            collaborationMode: .plan,
            createdAt: Date()
        )

        var capturedParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/steer")
            capturedParams = params
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["turnId": .string("turn-live")]),
                includeJSONRPC: false
            )
        }

        let viewModel = makeViewModel()
        service.queuedTurnDraftsByThread["thread-queue"] = [draft]

        viewModel.steerQueuedDraft(id: draft.id, codex: service, threadID: "thread-queue")
        await waitForSteerCompletion(viewModel)

        XCTAssertEqual(
            capturedParams?.objectValue?["collaborationMode"]?.objectValue?["mode"]?.stringValue,
            CodexCollaborationModeKind.plan.rawValue
        )
    }

    func testSteerQueuedDraftFailureKeepsRowAndDoesNotPauseQueue() async {
        let service = makeService()
        service.isConnected = true
        service.runningThreadIDs.insert("thread-queue")
        service.activeTurnIdByThread["thread-queue"] = "turn-live"
        service.requestTransportOverride = { _, _ in
            throw CodexServiceError.rpcError(RPCError(code: -32000, message: "turn already completed"))
        }

        let viewModel = makeViewModel()
        let draft = makeDraft(text: "queued")
        service.queuedTurnDraftsByThread["thread-queue"] = [draft]

        viewModel.steerQueuedDraft(id: draft.id, codex: service, threadID: "thread-queue")
        await waitForSteerCompletion(viewModel)

        XCTAssertEqual(service.queuedTurnDraftsByThread["thread-queue"]?.map(\.id), [draft.id])
        XCTAssertFalse(viewModel.isQueuePaused(codex: service, threadID: "thread-queue"))
        XCTAssertEqual(service.lastErrorMessage, "turn already completed")
        XCTAssertTrue(service.messagesByThread["thread-queue"]?.isEmpty ?? true)
    }

    func testSteerQueuedDraftResolvesFallbackTurnIDWhenActiveMappingMissing() async {
        let service = makeService()
        service.isConnected = true
        service.runningThreadIDs.insert("thread-queue")

        var recordedMethods: [String] = []
        var expectedTurnIDs: [String] = []
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
            expectedTurnIDs.append(params?.objectValue?["expectedTurnId"]?.stringValue ?? "")
            return RPCMessage(id: .string(UUID().uuidString), result: .object(["turnId": .string("turn-fallback")]), includeJSONRPC: false)
        }

        let viewModel = makeViewModel()
        let draft = makeDraft(text: "queued")
        service.queuedTurnDraftsByThread["thread-queue"] = [draft]

        viewModel.steerQueuedDraft(id: draft.id, codex: service, threadID: "thread-queue")
        await waitForSteerCompletion(viewModel)

        XCTAssertEqual(recordedMethods, ["thread/read", "turn/steer"])
        XCTAssertEqual(expectedTurnIDs, ["turn-fallback"])
        XCTAssertTrue(service.queuedTurnDraftsByThread["thread-queue"]?.isEmpty ?? false)
    }

    func testSteerQueuedDraftStartsTurnWhenRunningFlagRefreshClearsStaleBusyState() async {
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
        let draft = makeDraft(text: "queued")
        service.queuedTurnDraftsByThread["thread-queue"] = [draft]

        viewModel.steerQueuedDraft(id: draft.id, codex: service, threadID: "thread-queue")
        await waitForSteerCompletion(viewModel)

        XCTAssertEqual(recordedMethods, ["thread/read", "turn/start"])
        XCTAssertTrue(service.queuedTurnDraftsByThread["thread-queue"]?.isEmpty ?? false)
        XCTAssertEqual(service.activeTurnID(for: "thread-queue"), "turn-new")
    }

    func testRestoreQueuedDraftMovesSelectedRowIntoComposerAndRemovesItFromQueue() {
        let service = makeService()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,DDDD"
        )
        let first = makeDraft(text: "keep queued")
        let second = QueuedTurnDraft(
            id: "draft-restore",
            text: "Please inspect @AgntMobile/Views/Turn/TurnView.swift",
            attachments: [attachment],
            skillMentions: [
                CodexTurnSkillMention(
                    id: "check-code",
                    name: "check-code",
                    path: "/Users/me/.codex/skills/check-code/SKILL.md"
                )
            ],
            collaborationMode: .plan,
            rawInput: "Please inspect @TurnView.swift",
            rawFileMentions: [
                TurnComposerMentionedFile(
                    fileName: "TurnView.swift",
                    path: "AgntMobile/Views/Turn/TurnView.swift"
                )
            ],
            rawSkillMentions: [
                TurnComposerMentionedSkill(
                    name: "check-code",
                    path: "/Users/me/.codex/skills/check-code/SKILL.md",
                    description: "Review code"
                )
            ],
            rawAttachments: [
                TurnComposerImageAttachment(id: "att-restore", state: .ready(attachment))
            ],
            rawSubagentsSelectionArmed: true,
            createdAt: Date()
        )

        let viewModel = makeViewModel()
        service.queuedTurnDraftsByThread["thread-queue"] = [first, second]

        viewModel.restoreQueuedDraftToComposer(id: second.id, codex: service, threadID: "thread-queue")

        XCTAssertEqual(service.queuedTurnDraftsByThread["thread-queue"]?.map(\.id), [first.id])
        XCTAssertEqual(viewModel.input, "Please inspect @TurnView.swift")
        XCTAssertEqual(viewModel.composerMentionedFiles.map(\.path), ["AgntMobile/Views/Turn/TurnView.swift"])
        XCTAssertEqual(viewModel.composerMentionedSkills.map(\.name), ["check-code"])
        XCTAssertEqual(viewModel.composerAttachments.count, 1)
        XCTAssertTrue(viewModel.isSubagentsSelectionArmed)
        XCTAssertTrue(viewModel.isPlanModeArmed)
    }

    func testRestoreQueuedDraftDoesNothingWhenComposerAlreadyHasContent() {
        let service = makeService()
        let viewModel = makeViewModel()
        let draft = makeDraft(text: "queued")
        service.queuedTurnDraftsByThread["thread-queue"] = [draft]
        viewModel.input = "Already editing"

        viewModel.restoreQueuedDraftToComposer(id: draft.id, codex: service, threadID: "thread-queue")

        XCTAssertEqual(service.queuedTurnDraftsByThread["thread-queue"]?.map(\.id), [draft.id])
        XCTAssertEqual(viewModel.input, "Already editing")
    }
}
