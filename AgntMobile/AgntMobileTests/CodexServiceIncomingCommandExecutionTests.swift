// FILE: CodexServiceIncomingCommandExecutionTests.swift
// Purpose: Verifies command execution event handling and replay behavior.
// Layer: Unit Test
// Exports: CodexServiceIncomingCommandExecutionTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingCommandExecutionTests: CodexServiceIncomingCommandExecutionTestCase {
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
}
