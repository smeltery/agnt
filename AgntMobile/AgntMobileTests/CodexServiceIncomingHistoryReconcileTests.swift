// FILE: CodexServiceIncomingHistoryReconcileTests.swift
// Purpose: Verifies incoming history reconciliation and canonical replacement behavior.
// Layer: Unit Test
// Exports: CodexServiceIncomingHistoryReconcileTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingHistoryReconcileTests: CodexServiceIncomingCommandExecutionTestCase {
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
}
