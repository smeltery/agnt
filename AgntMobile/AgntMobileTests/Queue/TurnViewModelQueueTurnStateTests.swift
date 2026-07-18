// FILE: TurnViewModelQueueTurnStateTests.swift
// Purpose: Validates queued-turn refresh, interrupt, and direct steer behavior.
// Layer: Unit Test
// Exports: TurnViewModelQueueTurnStateTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class TurnViewModelQueueTurnStateTests: TurnViewModelQueueTestCase {
    func testRefreshInFlightTurnStateUsesLatestTurnAndClearsOlderInterruptibleTurn() async {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        service.runningThreadIDs.insert("thread-queue")
        service.activeTurnIdByThread["thread-queue"] = "turn-old"
        service.activeTurnId = "turn-old"

        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "thread/read")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": .object([
                        "turns": .array([
                            .object([
                                "id": .string("turn-old"),
                                "status": .string("in_progress"),
                            ]),
                            .object([
                                "id": .string("turn-latest"),
                                "status": .string("completed"),
                            ]),
                        ])
                    ])
                ]),
                includeJSONRPC: false
            )
        }

        let didRefresh = await service.refreshInFlightTurnState(threadId: "thread-queue")

        XCTAssertTrue(didRefresh)
        XCTAssertFalse(service.runningThreadIDs.contains("thread-queue"))
        XCTAssertNil(service.activeTurnIdByThread["thread-queue"])
    }

    func testRefreshInFlightTurnStateKeepsLatestTurnWhenStatusIsMissing() async {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        service.runningThreadIDs.insert("thread-queue")
        service.activeTurnIdByThread["thread-queue"] = "turn-old"
        service.activeTurnId = "turn-old"

        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "thread/read")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": .object([
                        "turns": .array([
                            .object([
                                "id": .string("turn-old"),
                                "status": .string("in_progress"),
                            ]),
                            .object([
                                "id": .string("turn-latest"),
                            ]),
                        ])
                    ])
                ]),
                includeJSONRPC: false
            )
        }

        let didRefresh = await service.refreshInFlightTurnState(threadId: "thread-queue")

        XCTAssertTrue(didRefresh)
        XCTAssertTrue(service.runningThreadIDs.contains("thread-queue"))
        XCTAssertEqual(service.activeTurnIdByThread["thread-queue"], "turn-latest")
        XCTAssertEqual(service.activeTurnId, "turn-latest")
    }

    func testInterruptTurnDoesNotTargetCompletedLatestTurnWhenRunningTurnHasNoID() async {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        service.runningThreadIDs.insert("thread-queue")
        service.protectedRunningFallbackThreadIDs.insert("thread-queue")

        var recordedMethods: [String] = []
        service.requestTransportOverride = { method, _ in
            recordedMethods.append(method)
            XCTAssertEqual(method, "thread/read")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": .object([
                        "turns": .array([
                            .object([
                                "status": .string("in_progress"),
                            ]),
                            .object([
                                "id": .string("turn-completed"),
                                "status": .string("completed"),
                            ]),
                        ])
                    ])
                ]),
                includeJSONRPC: false
            )
        }

        do {
            try await service.interruptTurn(turnId: nil, threadId: "thread-queue")
            XCTFail("interruptTurn should fail when no interruptible turn id is available")
        } catch {
            XCTAssertTrue(
                service.userFacingTurnErrorMessage(from: error).contains("interruptible turn ID")
            )
        }

        XCTAssertEqual(recordedMethods, ["thread/read"])
        XCTAssertFalse(service.runningThreadIDs.contains("thread-queue"))
        XCTAssertFalse(service.protectedRunningFallbackThreadIDs.contains("thread-queue"))
    }

    func testSteerQueuedDraftIsNoOpWhenThreadIsNotRunning() async {
        let service = makeService()
        service.isConnected = true

        var recordedMethods: [String] = []
        service.requestTransportOverride = { method, _ in
            recordedMethods.append(method)
            return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
        }

        let viewModel = makeViewModel()
        let draft = makeDraft(text: "queued")
        service.queuedTurnDraftsByThread["thread-queue"] = [draft]

        viewModel.steerQueuedDraft(id: draft.id, codex: service, threadID: "thread-queue")
        await waitForSteerCompletion(viewModel)

        XCTAssertTrue(recordedMethods.isEmpty)
        XCTAssertEqual(service.queuedTurnDraftsByThread["thread-queue"]?.map(\.id), [draft.id])
    }

    func testSteerTurnSendsExpectedRequestShapeAndDoesNotAppendUserMessage() async throws {
        let service = makeService()
        let attachment = CodexImageAttachment(
            thumbnailBase64JPEG: "thumb",
            payloadDataURL: "data:image/jpeg;base64,CCCC"
        )

        var capturedParams: JSONValue?
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "turn/steer")
            capturedParams = params
            return RPCMessage(id: .string(UUID().uuidString), result: .object(["turnId": .string("turn-123")]), includeJSONRPC: false)
        }

        try await service.steerTurn(
            userInput: "Steer this",
            threadId: "thread-steer",
            expectedTurnId: "turn-123",
            attachments: [attachment],
            skillMentions: [
                CodexTurnSkillMention(
                    id: "check-code",
                    name: "check-code",
                    path: "/Users/me/.codex/skills/check-code/SKILL.md"
                )
            ]
        )

        let paramsObject = try XCTUnwrap(capturedParams?.objectValue)
        XCTAssertEqual(paramsObject["threadId"]?.stringValue, "thread-steer")
        XCTAssertEqual(paramsObject["expectedTurnId"]?.stringValue, "turn-123")
        XCTAssertEqual(paramsObject["input"]?.arrayValue?.count, 3)
        let optimisticMessage = try XCTUnwrap(service.messagesByThread["thread-steer"]?.last)
        XCTAssertEqual(optimisticMessage.role, .user)
        XCTAssertEqual(optimisticMessage.text, "Steer this")
        XCTAssertEqual(optimisticMessage.deliveryState, .confirmed)
        XCTAssertEqual(optimisticMessage.turnId, "turn-123")
    }

    func testSteerTurnRetriesOnceWithRefreshedTurnID() async throws {
        let service = makeService()
        var steerAttemptTurnIDs: [String] = []

        service.requestTransportOverride = { method, params in
            if method == "turn/steer" {
                let expectedTurnID = params?.objectValue?["expectedTurnId"]?.stringValue ?? ""
                steerAttemptTurnIDs.append(expectedTurnID)
                if steerAttemptTurnIDs.count == 1 {
                    throw CodexServiceError.rpcError(RPCError(code: -32000, message: "no active turn"))
                }
                return RPCMessage(id: .string(UUID().uuidString), result: .object(["turnId": .string(expectedTurnID)]), includeJSONRPC: false)
            }

            XCTAssertEqual(method, "thread/read")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": .object([
                        "turns": .array([
                            .object([
                                "id": .string("turn-refreshed"),
                                "status": .string("in_progress"),
                            ])
                        ])
                    ])
                ]),
                includeJSONRPC: false
            )
        }

        try await service.steerTurn(
            userInput: "Retry steer",
            threadId: "thread-steer",
            expectedTurnId: "turn-stale"
        )

        XCTAssertEqual(steerAttemptTurnIDs, ["turn-stale", "turn-refreshed"])
    }
}
