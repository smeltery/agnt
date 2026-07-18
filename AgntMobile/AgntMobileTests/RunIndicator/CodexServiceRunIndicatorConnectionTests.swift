// FILE: CodexServiceRunIndicatorConnectionTests.swift
// Purpose: Verifies reconnect and pairing cleanup behavior that affects run indicators.
// Layer: Unit Test
// Exports: CodexServiceRunIndicatorConnectionTests
// Depends on: XCTest, Network, AgntMobile

import Network
import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceRunIndicatorConnectionTests: CodexServiceRunIndicatorTestCase {
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
}
