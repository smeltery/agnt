// FILE: CodexServiceIncomingRunIndicatorTests.swift
// Purpose: Verifies sidebar run badge transitions (running/ready/failed) from app-server events.
// Layer: Unit Test
// Exports: CodexServiceIncomingRunIndicatorTests
// Depends on: XCTest, AgntMobile

import XCTest
import Network
@testable import AgntMobile

@MainActor
final class CodexServiceIncomingRunIndicatorTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testRuntimeItemCompletionDebugLogCoalescesBursts() {
        let service = makeService()

        service.recordCompactRuntimeItemCompletion(itemType: "agent_message")
        service.recordCompactRuntimeItemCompletion(itemType: "tool_call")
        service.recordCompactRuntimeItemCompletion(itemType: "agent_message")

        XCTAssertTrue(service.runtimeDebugLogEntries.isEmpty)

        service.flushCompactRuntimeItemCompletions()

        XCTAssertEqual(service.runtimeDebugLogEntries.count, 1)
        XCTAssertTrue(service.runtimeDebugLogEntries[0].contains("rpc item/completed x3"))
        XCTAssertTrue(service.runtimeDebugLogEntries[0].contains("agent_message:2"))
        XCTAssertTrue(service.runtimeDebugLogEntries[0].contains("tool_call:1"))
    }

    func testRuntimeDebugLogClearDropsPendingItemCompletionBatch() {
        let service = makeService()

        service.recordCompactRuntimeItemCompletion(itemType: "agent_message")
        service.clearRuntimeDebugLog()
        service.flushCompactRuntimeItemCompletions()

        XCTAssertTrue(service.runtimeDebugLogEntries.isEmpty)
    }

    func testAssistantDeltaCoalescingAppliesOrderedDeltasOnFlush() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"

        service.enqueueAssistantDelta(threadId: threadID, turnId: turnID, itemId: itemID, delta: "Hello")
        service.enqueueAssistantDelta(threadId: threadID, turnId: turnID, itemId: itemID, delta: " world")

        XCTAssertTrue(service.messages(for: threadID).isEmpty)

        service.flushAllPendingStreamingDeltas()

        let messages = service.messages(for: threadID)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.role, .assistant)
        XCTAssertEqual(messages.first?.text, "Hello world")
        XCTAssertTrue(messages.first?.isStreaming == true)
    }

    func testAssistantDeltaCoalescingMergesCumulativeSnapshotsBeforeFlush() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "item-\(UUID().uuidString)"

        service.enqueueAssistantDelta(threadId: threadID, turnId: turnID, itemId: itemID, delta: "Yes")
        service.enqueueAssistantDelta(threadId: threadID, turnId: turnID, itemId: itemID, delta: "Yes, the")
        service.enqueueAssistantDelta(threadId: threadID, turnId: turnID, itemId: itemID, delta: "Yes, the imagegen skill")

        service.flushAllPendingStreamingDeltas()

        let messages = service.messages(for: threadID)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.text, "Yes, the imagegen skill")
        XCTAssertTrue(messages.first?.isStreaming == true)
    }

    func testSystemDeltaCoalescingAppliesThinkingDeltasOnFlush() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"
        let itemID = "thinking-\(UUID().uuidString)"

        service.appendStreamingSystemItemDelta(
            threadId: threadID,
            turnId: turnID,
            itemId: itemID,
            kind: .thinking,
            delta: "Looking"
        )
        service.appendStreamingSystemItemDelta(
            threadId: threadID,
            turnId: turnID,
            itemId: itemID,
            kind: .thinking,
            delta: " around"
        )

        XCTAssertTrue(service.messages(for: threadID).isEmpty)

        service.flushAllPendingStreamingDeltas()

        let messages = service.messages(for: threadID)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.role, .system)
        XCTAssertEqual(messages.first?.kind, .thinking)
        XCTAssertEqual(messages.first?.text, "Looking around")
        XCTAssertTrue(messages.first?.isStreaming == true)
    }

    func testNilTurnSystemDeltasFlushBeforeTurnCompletionClosesRows() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let itemID = "thinking-\(UUID().uuidString)"

        service.appendStreamingSystemItemDelta(
            threadId: threadID,
            turnId: nil,
            itemId: itemID,
            kind: .thinking,
            delta: "Recovering"
        )

        XCTAssertTrue(service.messages(for: threadID).isEmpty)

        service.markTurnCompleted(threadId: threadID, turnId: nil)

        let messages = service.messages(for: threadID)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.kind, .thinking)
        XCTAssertEqual(messages.first?.text, "Recovering")
        XCTAssertFalse(messages.first?.isStreaming ?? true)
        XCTAssertTrue(service.pendingSystemDeltasByKey.isEmpty)
    }

    func testTimelineStateTracksLatestRepoRefreshSignal() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.appendSystemMessage(
            threadId: threadID,
            text: "Status: completed\n\nPath: Sources/App.swift\nKind: update\nTotals: +1 -0",
            kind: .fileChange
        )

        let state = service.timelineState(for: threadID)

        XCTAssertNotNil(state.repoRefreshSignal)
        XCTAssertEqual(state.repoRefreshSignal, state.renderSnapshot.repoRefreshSignal)
    }

    func testErrorWithWillRetryDoesNotMarkFailed() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)

        service.handleNotification(
            method: "error",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "message": .string("temporary"),
                "willRetry": .bool(true),
            ])
        )

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)
        XCTAssertTrue(service.failedThreadIDs.isEmpty)
    }

    func testCompletionFailureMarksThreadAsFailed() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        sendTurnCompletedFailure(service: service, threadID: threadID, turnID: turnID, message: "boom")

        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .failed)
        XCTAssertEqual(service.lastErrorMessage, "boom")
    }

    func testMarkThreadAsViewedClearsReadyAndFailedBadges() {
        let service = makeService()
        let readyThreadID = "thread-ready-\(UUID().uuidString)"
        let failedThreadID = "thread-failed-\(UUID().uuidString)"
        let readyTurnID = "turn-\(UUID().uuidString)"
        let failedTurnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: readyThreadID, turnID: readyTurnID)
        sendTurnCompletedSuccess(service: service, threadID: readyThreadID, turnID: readyTurnID)

        sendTurnStarted(service: service, threadID: failedThreadID, turnID: failedTurnID)
        sendTurnFailed(service: service, threadID: failedThreadID, turnID: failedTurnID, message: "failed")

        service.markThreadAsViewed(readyThreadID)
        service.markThreadAsViewed(failedThreadID)

        XCTAssertNil(service.threadRunBadgeState(for: readyThreadID))
        XCTAssertNil(service.threadRunBadgeState(for: failedThreadID))
    }

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

    func testActiveThreadDoesNotReceiveReadyOrFailedBadge() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let successTurnID = "turn-\(UUID().uuidString)"
        let failedTurnID = "turn-\(UUID().uuidString)"

        service.activeThreadId = threadID
        sendTurnStarted(service: service, threadID: threadID, turnID: successTurnID)
        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: successTurnID)
        XCTAssertNil(service.threadRunBadgeState(for: threadID))

        sendTurnStarted(service: service, threadID: threadID, turnID: failedTurnID)
        sendTurnFailed(service: service, threadID: threadID, turnID: failedTurnID, message: "boom")
        XCTAssertNil(service.threadRunBadgeState(for: threadID))
    }

    func testNewTurnClearsPreviousOutcomeBeforeRunning() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let failedTurnID = "turn-\(UUID().uuidString)"
        let resumedTurnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: failedTurnID)
        sendTurnFailed(service: service, threadID: threadID, turnID: failedTurnID, message: "boom")
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .failed)

        sendTurnStarted(service: service, threadID: threadID, turnID: resumedTurnID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .running)

        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: resumedTurnID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .ready)
    }

    func testMultipleThreadsTrackIndependentBadgeStates() {
        let service = makeService()
        let runningThreadID = "thread-running-\(UUID().uuidString)"
        let readyThreadID = "thread-ready-\(UUID().uuidString)"
        let failedThreadID = "thread-failed-\(UUID().uuidString)"
        let runningTurnID = "turn-\(UUID().uuidString)"
        let readyTurnID = "turn-\(UUID().uuidString)"
        let failedTurnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: runningThreadID, turnID: runningTurnID)

        sendTurnStarted(service: service, threadID: readyThreadID, turnID: readyTurnID)
        sendTurnCompletedSuccess(service: service, threadID: readyThreadID, turnID: readyTurnID)

        sendTurnStarted(service: service, threadID: failedThreadID, turnID: failedTurnID)
        sendTurnFailed(service: service, threadID: failedThreadID, turnID: failedTurnID, message: "failed")

        XCTAssertEqual(service.threadRunBadgeState(for: runningThreadID), .running)
        XCTAssertEqual(service.threadRunBadgeState(for: readyThreadID), .ready)
        XCTAssertEqual(service.threadRunBadgeState(for: failedThreadID), .failed)
    }

    func testDisconnectClearsOutcomeBadges() async {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"
        let turnID = "turn-\(UUID().uuidString)"

        sendTurnStarted(service: service, threadID: threadID, turnID: turnID)
        sendTurnCompletedSuccess(service: service, threadID: threadID, turnID: turnID)
        XCTAssertEqual(service.threadRunBadgeState(for: threadID), .ready)

        await service.disconnect()

        XCTAssertTrue(service.runningThreadIDs.isEmpty)
        XCTAssertTrue(service.readyThreadIDs.isEmpty)
        XCTAssertTrue(service.failedThreadIDs.isEmpty)
        XCTAssertNil(service.threadRunBadgeState(for: threadID))
    }

    func testThreadHasActiveOrRunningTurnUsesRunningFallback() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        XCTAssertFalse(service.threadHasActiveOrRunningTurn(threadID))
        service.runningThreadIDs.insert(threadID)
        XCTAssertTrue(service.threadHasActiveOrRunningTurn(threadID))
    }

    func testBackgroundConnectionAbortSuppressesErrorAndArmsReconnect() {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        service.lastErrorMessage = nil
        service.setForegroundState(false)

        service.handleReceiveError(NWError.posix(.ECONNABORTED))

        XCTAssertFalse(service.isConnected)
        XCTAssertFalse(service.isInitialized)
        XCTAssertNil(service.lastErrorMessage)
        XCTAssertTrue(service.shouldAutoReconnectOnForeground)
    }

    func testForegroundConnectionAbortArmsReconnect() {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        service.lastErrorMessage = nil
        service.setForegroundState(true)

        service.handleReceiveError(NWError.posix(.ECONNABORTED))

        XCTAssertFalse(service.isConnected)
        XCTAssertFalse(service.isInitialized)
        XCTAssertNil(service.lastErrorMessage)
        XCTAssertTrue(service.shouldAutoReconnectOnForeground)
        XCTAssertEqual(
            service.connectionRecoveryState,
            .retrying(attempt: 0, message: "Reconnecting...")
        )
    }

    func testForegroundConnectionTimeoutSuppressesErrorAndArmsReconnect() {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        service.lastErrorMessage = nil
        service.setForegroundState(true)

        service.handleReceiveError(NWError.posix(.ETIMEDOUT))

        XCTAssertFalse(service.isConnected)
        XCTAssertFalse(service.isInitialized)
        XCTAssertNil(service.lastErrorMessage)
        XCTAssertTrue(service.shouldAutoReconnectOnForeground)
        XCTAssertEqual(
            service.connectionRecoveryState,
            .retrying(attempt: 0, message: "Connection timed out. Retrying...")
        )
    }

    func testRelaySessionReplacementClearsSavedPairingAndDisablesReconnect() {
        let service = makeService()

        withSavedRelayPairing(sessionId: "session-\(UUID().uuidString)", relayURL: "wss://relay.test/relay") {
            service.relaySessionId = SecureStore.readString(for: CodexSecureKeys.relaySessionId)
            service.relayUrl = SecureStore.readString(for: CodexSecureKeys.relayUrl)
            service.isConnected = true
            service.isInitialized = true

            service.handleReceiveError(
                CodexServiceError.disconnected,
                relayCloseCode: .privateCode(4001)
            )

            XCTAssertFalse(service.isConnected)
            XCTAssertFalse(service.shouldAutoReconnectOnForeground)
            XCTAssertNil(service.relaySessionId)
            XCTAssertNil(service.relayUrl)
            XCTAssertEqual(
                service.lastErrorMessage,
                "This relay session was replaced by another Mac connection. Scan a new QR code to reconnect."
            )
        }
    }

    func testMacUnavailableCloseKeepsSavedPairingAndRetriesReconnect() {
        let service = makeService()

        withSavedRelayPairing(sessionId: "session-\(UUID().uuidString)", relayURL: "wss://relay.test/relay") {
            service.relaySessionId = SecureStore.readString(for: CodexSecureKeys.relaySessionId)
            service.relayUrl = SecureStore.readString(for: CodexSecureKeys.relayUrl)
            service.isConnected = true
            service.isInitialized = true
            service.lastErrorMessage = nil
            service.setForegroundState(true)

            service.handleReceiveError(
                CodexServiceError.disconnected,
                relayCloseCode: .privateCode(4002)
            )

            XCTAssertFalse(service.isConnected)
            XCTAssertFalse(service.isInitialized)
            XCTAssertTrue(service.shouldAutoReconnectOnForeground)
            XCTAssertEqual(service.relaySessionId, SecureStore.readString(for: CodexSecureKeys.relaySessionId))
            XCTAssertEqual(service.relayUrl, SecureStore.readString(for: CodexSecureKeys.relayUrl))
            XCTAssertEqual(
                service.lastErrorMessage,
                "The saved Mac session is temporarily unavailable. agnt will keep retrying. If you restarted the bridge on your Mac, scan the new QR code."
            )
            XCTAssertEqual(service.connectionRecoveryState, .retrying(attempt: 0, message: "Reconnecting..."))
        }
    }

    func testReceiveErrorClearsResumedThreadCacheForReconnect() {
        let service = makeService()
        let threadID = "thread-\(UUID().uuidString)"

        service.resumedThreadIDs = [threadID]
        service.isConnected = true
        service.isInitialized = true

        service.handleReceiveError(
            CodexServiceError.disconnected,
            relayCloseCode: .privateCode(4002)
        )

        XCTAssertTrue(service.resumedThreadIDs.isEmpty)
    }

    func testMacAbsenceBufferOverflowKeepsPairingAndShowsRetryMessage() {
        let service = makeService()

        withSavedRelayPairing(sessionId: "session-\(UUID().uuidString)", relayURL: "wss://relay.test/relay") {
            service.relaySessionId = SecureStore.readString(for: CodexSecureKeys.relaySessionId)
            service.relayUrl = SecureStore.readString(for: CodexSecureKeys.relayUrl)
            service.isConnected = true
            service.isInitialized = true
            service.lastErrorMessage = nil
            service.setForegroundState(true)

            service.handleReceiveError(
                CodexServiceError.disconnected,
                relayCloseCode: .privateCode(4004)
            )

            XCTAssertFalse(service.isConnected)
            XCTAssertFalse(service.isInitialized)
            XCTAssertTrue(service.shouldAutoReconnectOnForeground)
            XCTAssertEqual(service.connectionRecoveryState, .idle)
            XCTAssertEqual(service.relaySessionId, SecureStore.readString(for: CodexSecureKeys.relaySessionId))
            XCTAssertEqual(service.relayUrl, SecureStore.readString(for: CodexSecureKeys.relayUrl))
            XCTAssertEqual(
                service.lastErrorMessage,
                "The Mac was temporarily unavailable and this message could not be delivered. Wait a moment, then try again."
            )
        }
    }

    func testRetryableDisconnectResetsEncryptedSecurityStateBackToTrustedMac() {
        let service = makeService()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let macPublicKey = "public-key-\(UUID().uuidString)"

        service.relaySessionId = "session-\(UUID().uuidString)"
        service.relayUrl = "wss://relay.test/relay"
        service.relayMacDeviceId = macDeviceID
        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: macPublicKey,
            lastPairedAt: Date()
        )
        service.secureConnectionState = .encrypted
        service.secureMacFingerprint = codexSecureFingerprint(for: macPublicKey)
        service.isConnected = true
        service.isInitialized = true

        service.handleReceiveError(NWError.posix(.ECONNABORTED))

        XCTAssertEqual(service.secureConnectionState, .trustedMac)
        XCTAssertEqual(service.secureMacFingerprint, codexSecureFingerprint(for: macPublicKey))
        XCTAssertTrue(service.shouldAutoReconnectOnForeground)
    }

    func testTrustedReconnectReceiveErrorDoesNotAdvanceFailureBudgetByItself() {
        let service = makeService()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let macPublicKey = "public-key-\(UUID().uuidString)"

        service.relaySessionId = "session-\(UUID().uuidString)"
        service.relayUrl = "wss://relay.test/relay"
        service.relayMacDeviceId = macDeviceID
        service.lastTrustedMacDeviceId = macDeviceID
        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: macPublicKey,
            lastPairedAt: Date(),
            relayURL: "wss://relay.test/relay"
        )

        for _ in 0..<3 {
            service.secureConnectionState = .reconnecting
            service.handleReceiveError(NWError.posix(.ECONNABORTED))
        }

        XCTAssertEqual(service.trustedReconnectFailureCount, 0)
        XCTAssertTrue(service.shouldAutoReconnectOnForeground)
        XCTAssertEqual(service.connectionRecoveryState, .retrying(attempt: 0, message: "Reconnecting..."))
        XCTAssertEqual(service.secureConnectionState, .trustedMac)
        XCTAssertNotNil(service.relaySessionId)
        XCTAssertNotNil(service.relayUrl)
        XCTAssertEqual(service.relayMacDeviceId, macDeviceID)
        XCTAssertNil(service.lastErrorMessage)
        XCTAssertTrue(service.hasSavedRelaySession)
        XCTAssertTrue(service.hasTrustedMacReconnectCandidate)
    }

    func testTrustedReconnectHandshakeFailureCounterResetsForFreshPairing() {
        let service = makeService()
        let macDeviceID = "mac-\(UUID().uuidString)"

        service.relaySessionId = "session-\(UUID().uuidString)"
        service.relayUrl = "wss://relay.test/relay"
        service.relayMacDeviceId = macDeviceID
        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: "public-key-\(UUID().uuidString)",
            lastPairedAt: Date()
        )

        XCTAssertFalse(service.recordTrustedReconnectFailureIfNeeded(isTrustedReconnectAttempt: true))
        XCTAssertEqual(service.trustedReconnectFailureCount, 1)

        service.rememberRelayPairing(
            CodexPairingQRPayload(
                v: codexPairingQRVersion,
                relay: "wss://relay.test/relay",
                sessionId: "fresh-session-\(UUID().uuidString)",
                macDeviceId: macDeviceID,
                macIdentityPublicKey: "fresh-public-key-\(UUID().uuidString)",
                expiresAt: Int64(Date().timeIntervalSince1970) + 60
            )
        )

        XCTAssertEqual(service.trustedReconnectFailureCount, 0)
    }

    func testSavedRelaySessionRequiresBothSessionIdAndRelayURL() {
        let service = makeService()

        XCTAssertFalse(service.hasSavedRelaySession)

        service.relaySessionId = "session-1"
        XCTAssertFalse(service.hasSavedRelaySession)

        service.relayUrl = "wss://relay.test/relay"
        XCTAssertTrue(service.hasSavedRelaySession)
    }

    func testRecoverableTimeoutMapsToFriendlyFailureMessage() {
        let service = makeService()

        XCTAssertTrue(service.isRecoverableTransientConnectionError(NWError.posix(.ETIMEDOUT)))
        XCTAssertEqual(
            service.userFacingConnectFailureMessage(NWError.posix(.ETIMEDOUT)),
            "Connection timed out. Check server/network."
        )
    }

    private func sendTurnStarted(service: CodexService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
    }

    private func sendTurnCompletedSuccess(service: CodexService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
    }

    private func sendTurnCompletedFailure(
        service: CodexService,
        threadID: String,
        turnID: String,
        message: String
    ) {
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turn": .object([
                    "id": .string(turnID),
                    "status": .string("failed"),
                    "error": .object([
                        "message": .string(message),
                    ]),
                ]),
            ])
        )
    }

    private func sendTurnCompletedStopped(service: CodexService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turn": .object([
                    "id": .string(turnID),
                    "status": .string("interrupted"),
                ]),
            ])
        )
    }

    private func sendTurnFailed(service: CodexService, threadID: String, turnID: String, message: String) {
        service.handleNotification(
            method: "turn/failed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "message": .string(message),
            ])
        )
    }

    private func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingRunIndicatorTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        // CodexService currently crashes while deallocating in unit-test environment.
        // Keep instances alive for process lifetime so assertions remain deterministic.
        Self.retainedServices.append(service)
        return service
    }

    private func makeTimelineMessage(
        id: String,
        threadID: String,
        role: CodexMessageRole,
        kind: CodexMessageKind = .chat,
        text: String,
        turnID: String,
        orderIndex: Int
    ) -> CodexMessage {
        CodexMessage(
            id: id,
            threadId: threadID,
            role: role,
            kind: kind,
            text: text,
            turnId: turnID,
            isStreaming: false,
            orderIndex: orderIndex
        )
    }

    // Persists a relay pairing the same way the app does so close-code cleanup can be tested honestly.
    private func withSavedRelayPairing(
        sessionId: String,
        relayURL: String,
        perform body: () -> Void
    ) {
        SecureStore.writeString(sessionId, for: CodexSecureKeys.relaySessionId)
        SecureStore.writeString(relayURL, for: CodexSecureKeys.relayUrl)
        defer {
            SecureStore.deleteValue(for: CodexSecureKeys.relaySessionId)
            SecureStore.deleteValue(for: CodexSecureKeys.relayUrl)
        }

        body()
    }

    private func flushAsyncSideEffects() async {
        await Task.yield()
        try? await Task.sleep(nanoseconds: 30_000_000)
    }
}
