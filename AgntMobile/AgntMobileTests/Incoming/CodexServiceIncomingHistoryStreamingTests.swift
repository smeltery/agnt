// FILE: CodexServiceIncomingHistoryStreamingTests.swift
// Purpose: Verifies incoming streaming history snapshot merge behavior.
// Layer: Unit Test
// Exports: CodexServiceIncomingHistoryStreamingTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingHistoryStreamingTests: CodexServiceIncomingStreamingTestCase {
    func testClosedAssistantSnapshotWithOlderPrefixDoesNotReplaceFinalBlock() {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let finalText = "TLDR: risposta finale."
        let flattenedText = """
        Uso la skill check-code perché sto controllando la repo.

        TLDR: risposta finale.
        """
        let localMessage = CodexMessage(
            threadId: threadID,
            role: .assistant,
            text: finalText,
            turnId: turnID,
            itemId: "message-1",
            isStreaming: false
        )
        let serverMessage = CodexMessage(
            threadId: threadID,
            role: .assistant,
            text: flattenedText,
            turnId: turnID,
            itemId: "message-1",
            isStreaming: false
        )

        XCTAssertFalse(
            CodexService.shouldReplaceClosedAssistantMessage(localMessage, with: serverMessage)
        )
    }

    func testRunningHistorySnapshotWithoutItemDoesNotPolluteItemScopedAssistant() throws {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let currentText = "Si, sure-sure per i processi pesanti."
        let flattenedText = """
        Si, sure-sure per i processi pesanti.

        Controllo solo i processi attivi, senza lanciare build o test.

        Si, sure-sure per i processi pesanti.
        """
        let localMessage = CodexMessage(
            id: CodexService.stableAssistantMessageID(threadId: threadID, turnId: turnID, itemId: "message-current")!,
            threadId: threadID,
            role: .assistant,
            text: currentText,
            turnId: turnID,
            itemId: "message-current",
            isStreaming: true
        )
        let serverSnapshot = CodexMessage(
            threadId: threadID,
            role: .assistant,
            text: flattenedText,
            turnId: turnID,
            itemId: nil,
            isStreaming: false
        )

        let merged = try CodexService.mergeHistoryMessages(
            [localMessage],
            [serverSnapshot],
            activeThreadIDs: [threadID],
            runningThreadIDs: []
        )

        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].text, currentText)
        XCTAssertEqual(merged[0].itemId, "message-current")
        XCTAssertTrue(merged[0].isStreaming)
    }

    func testRunningHistorySnapshotWithRepeatedPrefixDoesNotDuplicateAssistantText() throws {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "message-current"
        let currentText = "Si, sure-sure per i processi pesanti."
        let flattenedText = """
        Si, sure-sure per i processi pesanti.

        Controllo solo i processi attivi, senza lanciare build o test.

        Si, sure-sure per i processi pesanti.
        """
        let localMessage = CodexMessage(
            id: CodexService.stableAssistantMessageID(threadId: threadID, turnId: turnID, itemId: itemID)!,
            threadId: threadID,
            role: .assistant,
            text: currentText,
            turnId: turnID,
            itemId: itemID,
            isStreaming: true
        )
        let serverSnapshot = CodexMessage(
            id: CodexService.stableAssistantMessageID(threadId: threadID, turnId: turnID, itemId: itemID)!,
            threadId: threadID,
            role: .assistant,
            text: flattenedText,
            turnId: turnID,
            itemId: itemID,
            isStreaming: false
        )

        let merged = try CodexService.mergeHistoryMessages(
            [localMessage],
            [serverSnapshot],
            activeThreadIDs: [threadID],
            runningThreadIDs: []
        )

        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].text, currentText)
        XCTAssertEqual(merged[0].itemId, itemID)
        XCTAssertTrue(merged[0].isStreaming)
    }

    func testRunningHistorySnapshotWithExtraOlderSuffixDoesNotExtendAssistantText() throws {
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "message-current"
        let currentText = "Si, sure-sure per i processi pesanti."
        let flattenedText = """
        Si, sure-sure per i processi pesanti.

        Controllo solo i processi attivi, senza lanciare build o test.
        """
        let localMessage = CodexMessage(
            id: CodexService.stableAssistantMessageID(threadId: threadID, turnId: turnID, itemId: itemID)!,
            threadId: threadID,
            role: .assistant,
            text: currentText,
            turnId: turnID,
            itemId: itemID,
            isStreaming: true
        )
        let serverSnapshot = CodexMessage(
            id: CodexService.stableAssistantMessageID(threadId: threadID, turnId: turnID, itemId: itemID)!,
            threadId: threadID,
            role: .assistant,
            text: flattenedText,
            turnId: turnID,
            itemId: itemID,
            isStreaming: false
        )

        let merged = try CodexService.mergeHistoryMessages(
            [localMessage],
            [serverSnapshot],
            activeThreadIDs: [threadID],
            runningThreadIDs: []
        )

        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].text, currentText)
        XCTAssertEqual(merged[0].itemId, itemID)
        XCTAssertTrue(merged[0].isStreaming)
    }
}
