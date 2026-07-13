// FILE: CodexServiceIncomingCommandExecutionTests.swift
// Purpose: Verifies legacy+modern command execution event handling and dedup behavior.
// Layer: Unit Test
// Exports: CodexServiceIncomingCommandExecutionTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingCommandExecutionTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testLegacyBeginAndModernItemStartedMergeIntoSingleRunRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let callID = "call-\(UUID().uuidString)"

        service.handleNotification(
            method: "codex/event/exec_command_begin",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("exec_command_begin"),
                    "call_id": .string(callID),
                    "turn_id": .string(turnID),
                    "cwd": .string("/tmp"),
                    "command": .array([
                        .string("/bin/zsh"),
                        .string("-lc"),
                        .string("echo one"),
                    ]),
                ]),
            ])
        )

        service.handleNotification(
            method: "item/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(callID),
                    "type": .string("commandExecution"),
                    "status": .string("inProgress"),
                    "cwd": .string("/tmp"),
                    "command": .string("/bin/zsh -lc \"echo one\""),
                    "commandActions": .array([]),
                ]),
            ])
        )

        let runRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .commandExecution
        }
        XCTAssertEqual(runRows.count, 1)
        XCTAssertTrue(runRows[0].text.lowercased().hasPrefix("running "))
    }

    func testOutputDeltaDoesNotReplaceExistingCommandPreview() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let callID = "call-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(callID),
                    "type": .string("commandExecution"),
                    "status": .string("inProgress"),
                    "cwd": .string("/tmp"),
                    "command": .string("/bin/zsh -lc \"echo one\""),
                    "commandActions": .array([]),
                ]),
            ])
        )

        let before = service.messages(for: threadID).first { $0.itemId == callID }?.text
        service.handleNotification(
            method: "item/commandExecution/outputDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(callID),
                "delta": .string("ONE\n"),
            ])
        )
        let after = service.messages(for: threadID).first { $0.itemId == callID }?.text

        XCTAssertEqual(after, before)
        XCTAssertFalse((after ?? "").lowercased().contains("running command"))
    }

    func testLegacyEndCompletesExistingRunRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let callID = "call-\(UUID().uuidString)"

        service.handleNotification(
            method: "codex/event/exec_command_begin",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("exec_command_begin"),
                    "call_id": .string(callID),
                    "turn_id": .string(turnID),
                    "cwd": .string("/tmp"),
                    "command": .array([.string("echo"), .string("ok")]),
                ]),
            ])
        )

        service.handleNotification(
            method: "codex/event/exec_command_end",
            params: .object([
                "conversationId": .string(threadID),
                "id": .string(turnID),
                "msg": .object([
                    "type": .string("exec_command_end"),
                    "call_id": .string(callID),
                    "turn_id": .string(turnID),
                    "cwd": .string("/tmp"),
                    "status": .string("completed"),
                    "exit_code": .integer(0),
                    "command": .array([.string("echo"), .string("ok")]),
                ]),
            ])
        )

        let runRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .commandExecution
        }
        XCTAssertEqual(runRows.count, 1)
        XCTAssertTrue(runRows[0].text.lowercased().hasPrefix("completed "))
        XCTAssertFalse(runRows[0].isStreaming)
    }

    func testToolCallDeltaAddsDedicatedToolActivityRows() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/toolCall/outputDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "delta": .string("Read CodexProtocol.swift\nSearch extractSystemTitleAndBody\n{\"ignore\":\"json\"}"),
            ])
        )

        let toolRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .toolActivity
        }
        XCTAssertEqual(toolRows.count, 1)
        let body = toolRows[0].text
        XCTAssertTrue(body.contains("Read CodexProtocol.swift"))
        XCTAssertTrue(body.contains("Search extractSystemTitleAndBody"))
        XCTAssertFalse(body.contains("ignore"))
    }

    func testHistoryToolCallRestoresDedicatedToolActivityRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        let history = service.decodeMessagesFromThreadRead(
            threadId: threadID,
            threadObject: [
                "createdAt": .string("2026-03-12T10:00:00Z"),
                "turns": .array([
                    .object([
                        "id": .string(turnID),
                        "items": .array([
                            .object([
                                "id": .string("tool-item"),
                                "type": .string("toolCall"),
                                "name": .string("search"),
                                "status": .string("completed"),
                                "message": .string("Search extractSystemTitleAndBody"),
                            ]),
                        ]),
                    ]),
                ]),
            ]
        )

        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history[0].kind, .toolActivity)
        XCTAssertEqual(history[0].text, "Search extractSystemTitleAndBody")
        XCTAssertEqual(history[0].turnId, turnID)
    }

    func testHistoryRestoresGeneratedImageEndAndImageViewItems() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let history = service.decodeMessagesFromThreadRead(
            threadId: threadID,
            threadObject: [
                "createdAt": .string("2026-03-12T10:00:00Z"),
                "turns": .array([
                    .object([
                        "id": .string(turnID),
                        "items": .array([
                            .object([
                                "id": .string("image-end"),
                                "type": .string("image_generation_end"),
                                "saved_path": .string("/Users/example/generated end.png"),
                            ]),
                            .object([
                                "id": .string("image-view"),
                                "type": .string("imageView"),
                                "path": .string("/Users/example/viewed image.png"),
                            ]),
                        ]),
                    ]),
                ]),
            ]
        )

        XCTAssertEqual(history.count, 2)
        XCTAssertEqual(history.map(\.itemId), ["image-end", "image-view"])
        XCTAssertEqual(history.map(\.text), [
            "![Generated image](</Users/example/generated end.png>)",
            "![Generated image](</Users/example/viewed image.png>)",
        ])
    }

    func testHistoryDecodesNumericStringMicrosecondTimestamps() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let expectedDate = Date(timeIntervalSince1970: 1_710_000_000)
        let microseconds = "1710000000000000"

        let history = service.decodeMessagesFromThreadRead(
            threadId: threadID,
            threadObject: [
                "createdAt": .string(microseconds),
                "turns": .array([
                    .object([
                        "id": .string(turnID),
                        "items": .array([
                            .object([
                                "id": .string("assistant-item"),
                                "type": .string("assistantMessage"),
                                "createdAt": .string(microseconds),
                                "message": .string("Hello"),
                            ]),
                        ]),
                    ]),
                ]),
            ]
        )

        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history[0].createdAt.timeIntervalSince1970, expectedDate.timeIntervalSince1970, accuracy: 0.001)
    }

    func testMergeHistoryMessagesReplacesOptimisticCreatedAtWithTrustworthyServerTimestamp() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let localDate = Date(timeIntervalSince1970: 1_720_000_000)
        let serverDate = Date(timeIntervalSince1970: 1_710_000_000)

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Hello",
                createdAt: localDate,
                turnId: turnID,
                itemId: "assistant-item",
                isStreaming: false
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "Hello",
                createdAt: serverDate,
                turnId: turnID,
                itemId: "assistant-item",
                isStreaming: false
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)

        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].createdAt.timeIntervalSince1970, serverDate.timeIntervalSince1970, accuracy: 0.001)
    }

    func testLateActivityLineAfterTurnCompletionDoesNotReopenToolActivityStream() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "item/toolCall/outputDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "delta": .string("Read file A.swift"),
            ])
        )
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "codex/event/read",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "path": .string("B.swift"),
            ])
        )

        let toolRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .toolActivity
        }
        XCTAssertEqual(toolRows.count, 1)
        XCTAssertTrue(toolRows[0].text.contains("Read file A.swift"))
        XCTAssertTrue(toolRows[0].text.contains("Read B.swift"))
        XCTAssertFalse(toolRows[0].isStreaming)
    }

    func testLateActivityLineWithoutTurnIdAfterCompletionDoesNotCreateTrailingToolActivityRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )

        service.handleNotification(
            method: "codex/event/background_event",
            params: .object([
                "threadId": .string(threadID),
                "message": .string("Controllo subito il repository"),
            ])
        )

        let toolRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .toolActivity
        }
        XCTAssertTrue(toolRows.isEmpty)
    }

    func testEssentialReadEventUsesToolActivityInsteadOfThinking() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "codex/event/read",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "path": .string("A.swift"),
            ])
        )

        let toolRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .toolActivity
        }
        let thinkingRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .thinking
        }

        XCTAssertEqual(toolRows.count, 1)
        XCTAssertEqual(toolRows[0].text, "Read A.swift")
        XCTAssertTrue(thinkingRows.isEmpty)
    }

    func testLiveToolActivityReusesSingleMatchingTurnRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let existing = CodexMessage(
            threadId: threadID,
            role: .system,
            kind: .toolActivity,
            text: "Read A.swift",
            turnId: turnID,
            itemId: nil,
            isStreaming: true,
            deliveryState: .confirmed
        )
        service.messagesByThread[threadID] = [existing]

        service.upsertStreamingSystemItemMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "tool-real",
            kind: .toolActivity,
            text: "Read A.swift",
            isStreaming: true
        )

        let toolRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .toolActivity
        }
        XCTAssertEqual(toolRows.count, 1)
        XCTAssertEqual(toolRows[0].id, existing.id)
        XCTAssertEqual(toolRows[0].itemId, "tool-real")
    }

    func testLiveToolActivityKeepsDistinctStableItemsWithIdenticalTextSeparated() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        service.upsertStreamingSystemItemMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "tool-1",
            kind: .toolActivity,
            text: "Read foo.swift",
            isStreaming: true
        )
        service.upsertStreamingSystemItemMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: "tool-2",
            kind: .toolActivity,
            text: "Read foo.swift",
            isStreaming: true
        )

        let toolRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .toolActivity
        }
        XCTAssertEqual(toolRows.count, 2)
        XCTAssertEqual(toolRows.map(\.itemId), ["tool-1", "tool-2"])
    }

    func testCompletedToolActivityPlaceholderIsRemovedWhenNoContentArrives() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "tool-\(UUID().uuidString)"

        service.upsertStreamingSystemItemMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: itemID,
            kind: .toolActivity,
            text: "",
            isStreaming: true
        )
        service.completeStreamingSystemItemMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: itemID,
            kind: .toolActivity,
            text: nil
        )

        let toolRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .toolActivity
        }
        XCTAssertTrue(toolRows.isEmpty)
    }








    func testLegacyToolActivityAfterAssistantCreatesNewLaterRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        service.messagesByThread[threadID] = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read A.swift",
                createdAt: now,
                turnId: turnID,
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                kind: .chat,
                text: "Prima risposta",
                createdAt: now.addingTimeInterval(0.1),
                turnId: turnID,
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        service.appendToolActivityLine(
            threadId: threadID,
            turnId: turnID,
            line: "Read B.swift"
        )

        let messages = service.messages(for: threadID)
        let toolRows = messages.filter { $0.role == .system && $0.kind == .toolActivity }

        XCTAssertEqual(toolRows.count, 2)
        XCTAssertEqual(toolRows[0].text, "Read A.swift")
        XCTAssertEqual(toolRows[1].text, "Read B.swift")
        XCTAssertEqual(messages.map(\.role), [.system, .assistant, .system])
    }

    func testHistoryMergeDoesNotCollapseRepeatedToolActivityRowsWhenTurnHasMultipleCandidates() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now,
                turnId: turnID,
                itemId: "tool-1",
                isStreaming: false,
                deliveryState: .confirmed
            ),
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now.addingTimeInterval(0.1),
                turnId: turnID,
                itemId: "tool-2",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now.addingTimeInterval(0.2),
                turnId: turnID,
                itemId: "tool-3",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let toolRows = merged.filter { $0.role == .system && $0.kind == .toolActivity }

        XCTAssertEqual(toolRows.map(\.itemId), ["tool-1", "tool-2", "tool-3"])
    }

    func testHistoryMergeUpgradesSyntheticToolActivityIdentityToRealItemID() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now,
                turnId: turnID,
                itemId: "turn:\(turnID)|kind:toolActivity",
                isStreaming: true,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now.addingTimeInterval(0.2),
                turnId: turnID,
                itemId: "tool-1",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let toolRows = merged.filter { $0.role == .system && $0.kind == .toolActivity }

        XCTAssertEqual(toolRows.count, 1)
        XCTAssertEqual(toolRows[0].itemId, "tool-1")
    }

    func testHistoryMergeKeepsSingleCompletedSyntheticToolActivitySeparateFromRepeatedHistoryRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now,
                turnId: turnID,
                itemId: "turn:\(turnID)|kind:toolActivity",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .system,
                kind: .toolActivity,
                text: "Read foo.swift",
                createdAt: now.addingTimeInterval(0.2),
                turnId: turnID,
                itemId: "tool-1",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let toolRows = merged.filter { $0.role == .system && $0.kind == .toolActivity }

        XCTAssertEqual(toolRows.count, 2)
        XCTAssertEqual(toolRows.map(\.itemId), ["turn:\(turnID)|kind:toolActivity", "tool-1"])
    }


    func testHistoryUserMessageReconcilesPendingPhoneRowWhenHistoryOmitsLocalMetadata() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .user,
                text: "Fix this",
                fileMentions: ["Sources/App.swift"],
                createdAt: now,
                turnId: nil,
                itemId: nil,
                isStreaming: false,
                deliveryState: .pending,
                attachments: [
                    CodexImageAttachment(
                        thumbnailBase64JPEG: "thumb-1",
                        payloadDataURL: "data:image/jpeg;base64,abc"
                    ),
                ]
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .user,
                text: "Fix this",
                fileMentions: [],
                createdAt: now.addingTimeInterval(0.2),
                turnId: turnID,
                itemId: "user-1",
                isStreaming: false,
                deliveryState: .confirmed,
                attachments: []
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let userRows = merged.filter { $0.role == .user }

        XCTAssertEqual(userRows.count, 1)
        XCTAssertEqual(userRows[0].turnId, turnID)
        XCTAssertEqual(userRows[0].deliveryState, .confirmed)
        XCTAssertEqual(userRows[0].fileMentions, ["Sources/App.swift"])
        XCTAssertEqual(userRows[0].attachments.count, 1)
    }

    func testHistoryUserMessageDoesNotGuessBetweenTwoIdenticalPendingRows() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let now = Date()

        let existing = [
            CodexMessage(
                threadId: threadID,
                role: .user,
                text: "Fix this",
                createdAt: now,
                turnId: nil,
                itemId: nil,
                isStreaming: false,
                deliveryState: .pending
            ),
            CodexMessage(
                threadId: threadID,
                role: .user,
                text: "Fix this",
                createdAt: now.addingTimeInterval(0.2),
                turnId: nil,
                itemId: nil,
                isStreaming: false,
                deliveryState: .pending
            ),
        ]
        let history = [
            CodexMessage(
                threadId: threadID,
                role: .user,
                text: "Fix this",
                createdAt: now.addingTimeInterval(0.4),
                turnId: turnID,
                itemId: "user-1",
                isStreaming: false,
                deliveryState: .confirmed
            ),
        ]

        let merged = service.mergeHistoryMessages(existing, history)
        let userRows = merged.filter { $0.role == .user }

        XCTAssertEqual(userRows.count, 3)
        XCTAssertEqual(userRows.filter { $0.deliveryState == .pending }.count, 2)
        XCTAssertEqual(userRows.filter { $0.deliveryState == .confirmed }.count, 1)
        XCTAssertEqual(userRows.last?.turnId, turnID)
    }

    func testLateTerminalInteractionDoesNotRegressCompletedCommandRow() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let callID = "call-\(UUID().uuidString)"

        service.handleNotification(
            method: "item/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(callID),
                    "type": .string("commandExecution"),
                    "status": .string("inProgress"),
                    "command": .string("/bin/zsh -lc \"echo one\""),
                ]),
            ])
        )
        service.handleNotification(
            method: "item/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "item": .object([
                    "id": .string(callID),
                    "type": .string("commandExecution"),
                    "status": .string("completed"),
                    "command": .string("/bin/zsh -lc \"echo one\""),
                ]),
            ])
        )
        service.handleNotification(
            method: "item/commandExecution/terminalInteraction",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(callID),
                "command": .string("/bin/zsh -lc \"echo one\""),
            ])
        )

        let runRow = service.messages(for: threadID).first(where: {
            $0.role == .system && $0.kind == .commandExecution && $0.itemId == callID
        })
        XCTAssertNotNil(runRow)
        XCTAssertTrue(runRow?.text.lowercased().hasPrefix("completed ") ?? false)
        XCTAssertFalse(runRow?.isStreaming ?? true)
    }

    func testThreadReadRestoresNestedReviewModeMessages() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let history = service.decodeMessagesFromThreadRead(
            threadId: threadID,
            threadObject: [
                "createdAt": .string("2026-03-12T10:00:00Z"),
                "turns": .array([
                    .object([
                        "id": .string(turnID),
                        "items": .array([
                            .object([
                                "id": .string("review-enter"),
                                "type": .string("enteredReviewMode"),
                                "review": .object([
                                    "summary": .string("base branch"),
                                ]),
                            ]),
                            .object([
                                "id": .string("review-exit"),
                                "type": .string("exitedReviewMode"),
                                "review": .object([
                                    "content": .array([
                                        .string("Line one"),
                                        .string("Line two"),
                                    ]),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
            ]
        )

        XCTAssertEqual(history.count, 2)
        XCTAssertEqual(history[0].text, "Reviewing base branch...")
        XCTAssertEqual(history[0].kind, .commandExecution)
        XCTAssertEqual(history[1].text, "Line one\nLine two")
        XCTAssertEqual(history[1].kind, .chat)
    }

    func testRolloutMirrorReasoningRebindsToIpcThinkingRowInsteadOfDuplicating() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let realItemID = "reasoning-\(UUID().uuidString)"

        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string(realItemID),
                "delta": .string("Weighing options"),
            ])
        )
        service.handleNotification(
            method: "item/reasoning/textDelta",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "itemId": .string("rollout-thinking:\(threadID):\(turnID)"),
                "delta": .string(" and deciding"),
                "agntDesktopMirror": .bool(true),
                "agntRolloutLiveMirror": .bool(true),
            ])
        )

        let thinkingRows = service.messages(for: threadID).filter {
            $0.role == .system && $0.kind == .thinking
        }
        XCTAssertEqual(thinkingRows.count, 1)
        XCTAssertEqual(thinkingRows[0].itemId, realItemID)
    }

    func testThreadReplacedMarksCanonicalSourceReplacement() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        service.projectedTerminalStateByThreadID[threadID] = ["ipc-turn-1": .completed]

        service.handleNotification(
            method: "thread/replaced",
            params: .object(["threadId": .string(threadID)])
        )

        XCTAssertNil(service.projectedTerminalStateByThreadID[threadID])
        XCTAssertTrue(service.pendingCanonicalSourceReplacementThreadIDs.contains(threadID))
        XCTAssertTrue(service.forcedHistoryLoadThreadIDs.contains(threadID))
        XCTAssertTrue(service.threadsNeedingCanonicalHistoryReconcile.contains(threadID))
    }

    func testCanonicalSourceReplacementPrunesStaleMirrorRows() {
        let threadID = "thread-\(UUID().uuidString)"
        let existing = [
            CodexMessage(
                id: "older",
                threadId: threadID,
                role: .assistant,
                text: "Older cached page",
                turnId: "old-real-turn",
                itemId: "old-real-item",
                orderIndex: 0
            ),
            CodexMessage(
                id: "mirror-user",
                threadId: threadID,
                role: .user,
                text: "Build the app",
                turnId: "ipc-turn-1",
                itemId: "ipc-turn-1:input",
                deliveryState: .confirmed,
                orderIndex: 1
            ),
            CodexMessage(
                id: "mirror-finding",
                threadId: threadID,
                role: .system,
                kind: .thinking,
                text: "Stale synthetic finding",
                turnId: "ipc-turn-1",
                itemId: "turn:ipc-turn-1|kind:thinking",
                orderIndex: 2
            ),
            CodexMessage(
                id: "pending-user",
                threadId: threadID,
                role: .user,
                text: "Still sending",
                deliveryState: .pending,
                orderIndex: 3
            ),
        ]
        let history = [
            CodexMessage(
                id: "canonical-user",
                threadId: threadID,
                role: .user,
                text: "Build the app",
                turnId: "turn-real",
                itemId: "item-user",
                deliveryState: .confirmed,
                orderIndex: 0
            ),
            CodexMessage(
                id: "canonical-assistant",
                threadId: threadID,
                role: .assistant,
                text: "Done",
                turnId: "turn-real",
                itemId: "item-assistant",
                orderIndex: 1
            ),
        ]

        let repaired = CodexService.existingMessagesForCanonicalSourceReplacement(existing, history: history)

        XCTAssertTrue(repaired.contains { $0.id == "older" })
        XCTAssertTrue(repaired.contains { $0.id == "mirror-user" })
        XCTAssertFalse(repaired.contains { $0.id == "mirror-finding" })
        XCTAssertTrue(repaired.contains { $0.id == "pending-user" })
    }

    func testTurnTerminalStatePersistsCompletedGroupingAfterRelaunch() {
        let suiteName = "CodexServiceIncomingCommandExecutionTests.persist.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)

        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let messages = [
            CodexMessage(
                id: "user",
                threadId: threadID,
                role: .user,
                text: "make an icon",
                turnId: turnID
            ),
            CodexMessage(
                id: "preamble",
                threadId: threadID,
                role: .assistant,
                text: "Using imagegen...",
                turnId: turnID,
                itemId: "status"
            ),
            CodexMessage(
                id: "final",
                threadId: threadID,
                role: .assistant,
                text: "Done.",
                turnId: turnID,
                itemId: "final"
            ),
        ]

        let firstService = CodexService(defaults: defaults)
        firstService.messagesByThread[threadID] = messages
        firstService.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)

        let reloadedService = CodexService(defaults: defaults)
        reloadedService.messagesByThread[threadID] = messages
        reloadedService.refreshThreadTimelineState(for: threadID)
        Self.retainedServices.append(firstService)
        Self.retainedServices.append(reloadedService)

        let snapshot = reloadedService.timelineState(for: threadID).renderSnapshot
        let renderItems = TurnTimelineRenderProjection.project(
            messages: snapshot.messages,
            completedTurnIDs: snapshot.completedTurnIDs
        )

        XCTAssertEqual(reloadedService.turnTerminalState(for: turnID), .completed)
        XCTAssertTrue(snapshot.completedTurnIDs.contains(turnID))
        XCTAssertTrue(renderItems.contains {
            if case .previousMessages = $0 { return true }
            return false
        })
    }




    private func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingCommandExecutionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        // CodexService currently crashes while deallocating in unit-test environment.
        // Keep instances alive for the process lifetime so assertions can run deterministically.
        Self.retainedServices.append(service)
        return service
    }
}
