// FILE: CodexServiceRunIndicatorDisplayTests.swift
// Purpose: Verifies display preparation clears or skips run-indicator state.
// Layer: Unit Test
// Exports: CodexServiceRunIndicatorDisplayTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceRunIndicatorDisplayTests: CodexServiceRunIndicatorTestCase {
    func testPrepareThreadForDisplayClearsOutcomeBadge() async {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: turnID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .ready)

        await service.prepareThreadForDisplay(threadId: threadID)

        XCTAssertNil(service.threadRunBadgeState(for: threadID))
    }

    func testPrepareThreadForDisplaySkipsHydrationForFreshEmptyThread() async {
        let service = makeService()
        let freshThreadID = "thread-fresh-\(UUID().uuidString)"
        let runningThreadID = "thread-running-\(UUID().uuidString)"
        let runningTurnID = "turn-running-\(UUID().uuidString)"

        service.isConnected = true
        service.isInitialized = true
        service.threads = [
            CodexThread(id: freshThreadID, createdAt: Date(), updatedAt: Date()),
            CodexThread(id: runningThreadID, createdAt: Date(), updatedAt: Date())
        ]
        service.resumedThreadIDs.insert(freshThreadID)
        service.runningThreadIDs.insert(runningThreadID)
        service.activeTurnIdByThread[runningThreadID] = runningTurnID
        service.activeThreadId = runningThreadID

        var recordedMethods: [String] = []
        service.requestTransportOverride = { method, _ in
            recordedMethods.append(method)
            XCTFail("Fresh empty thread should not trigger RPC during initial display prep")
            return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
        }

        let didPrepare = await service.prepareThreadForDisplay(threadId: freshThreadID)

        XCTAssertTrue(didPrepare)
        XCTAssertEqual(service.activeThreadId, freshThreadID)
        XCTAssertTrue(recordedMethods.isEmpty)
    }
}
