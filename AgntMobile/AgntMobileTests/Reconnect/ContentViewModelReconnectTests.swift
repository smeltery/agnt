// FILE: ContentViewModelReconnectTests.swift
// Purpose: Verifies reconnect URL selection and trusted-session candidate recovery.
// Layer: Unit Test
// Exports: ContentViewModelReconnectTests
// Depends on: XCTest, Foundation, Network, AgntMobile

import Foundation
import Network
import XCTest
@testable import AgntMobile

@MainActor
final class ContentViewModelReconnectTests: ContentViewModelReconnectTestCase {
    func testTrustedResolveURLCandidatesTryProxyRelativeThenRootRoute() {
        let candidates = CodexTrustedSessionResolveURLBuilder.candidates(
            from: "wss://relay.example.com/agnt/relay?stale=1#old"
        )

        XCTAssertEqual(
            candidates.map(\.absoluteString),
            [
                "https://relay.example.com/agnt/v1/trusted/session/resolve",
                "https://relay.example.com/v1/trusted/session/resolve",
            ]
        )
    }

    func testTrustedResolveURLCandidatesDoNotDuplicateRootRoute() {
        let candidates = CodexTrustedSessionResolveURLBuilder.candidates(
            from: "ws://relay.example.com/relay?stale=1"
        )

        XCTAssertEqual(
            candidates.map(\.absoluteString),
            [
                "http://relay.example.com/v1/trusted/session/resolve",
            ]
        )
    }

    func testPreferredReconnectURLFallsBackToSavedSessionWhenTrustedResolveReportsOffline() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let relayURL = "wss://relay.local/relay"

        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: Data(repeating: 9, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.lastTrustedMacDeviceId = macDeviceID
        service.setCurrentTrustedMacDeviceId(macDeviceID)
        service.relaySessionId = "saved-session"
        service.relayUrl = relayURL
        service.relayMacDeviceId = macDeviceID
        service.lastErrorMessage = "stale error"
        service.trustedSessionResolverOverride = {
            throw CodexTrustedSessionResolveError.macOffline("Your trusted Mac is offline right now.")
        }

        let reconnectURL = await viewModel.preferredReconnectURL(codex: service)

        XCTAssertEqual(reconnectURL, "\(relayURL)/saved-session")
        XCTAssertNil(service.lastErrorMessage)
    }

    func testPreferredReconnectURLStopsWhenTrustedResolveReportsOfflineAndNoSavedSessionExists() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let relayURL = "wss://relay.local/relay"

        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: Data(repeating: 10, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.lastTrustedMacDeviceId = macDeviceID
        service.setCurrentTrustedMacDeviceId(macDeviceID)
        service.trustedSessionResolverOverride = {
            throw CodexTrustedSessionResolveError.macOffline("Your trusted Mac is offline right now.")
        }

        let reconnectURL = await viewModel.preferredReconnectURL(codex: service)

        XCTAssertNil(reconnectURL)
        XCTAssertEqual(service.lastErrorMessage, "Your trusted Mac is offline right now.")
    }

    func testPreferredReconnectURLIgnoresSavedSessionForDifferentCurrentMac() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let currentMacDeviceID = "mac-current-\(UUID().uuidString)"
        let staleMacDeviceID = "mac-stale-\(UUID().uuidString)"

        service.trustedMacRegistry.records[currentMacDeviceID] = CodexTrustedMacRecord(
            macDeviceId: currentMacDeviceID,
            macIdentityPublicKey: Data(repeating: 7, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: "wss://relay.current/relay"
        )
        service.setCurrentTrustedMacDeviceId(currentMacDeviceID)
        service.relaySessionId = "saved-session"
        service.relayUrl = "wss://relay.stale/relay"
        service.relayMacDeviceId = staleMacDeviceID
        service.trustedSessionResolverOverride = {
            throw CodexTrustedSessionResolveError.noTrustedMac
        }

        let reconnectURL = await viewModel.preferredReconnectURL(codex: service)

        XCTAssertNil(reconnectURL)
    }

    func testPreferredReconnectURLStopsWithUnsupportedRelayWithoutForcingRePair() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let relayURL = "wss://relay.local/relay"

        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: Data(repeating: 16, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.lastTrustedMacDeviceId = macDeviceID
        service.setCurrentTrustedMacDeviceId(macDeviceID)
        service.shouldAutoReconnectOnForeground = true
        service.trustedSessionResolverOverride = {
            throw CodexTrustedSessionResolveError.unsupportedRelay
        }

        let reconnectURL = await viewModel.preferredReconnectURL(codex: service)

        XCTAssertNil(reconnectURL)
        XCTAssertEqual(service.secureConnectionState, .liveSessionUnresolved)
        XCTAssertFalse(service.shouldAutoReconnectOnForeground)
        XCTAssertEqual(
            service.lastErrorMessage,
            "Trusted reconnect is unavailable from this relay endpoint. Update or check the relay/proxy, then reconnect. Scan a new QR code only if this Mac was reset."
        )
    }

    func testWakeDisplayRequiresSavedLiveSessionURL() {
        let service = makeService()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let relayURL = "wss://relay.local/relay"

        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: Data(repeating: 17, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.lastTrustedMacDeviceId = macDeviceID
        service.setCurrentTrustedMacDeviceId(macDeviceID)

        XCTAssertTrue(service.hasReconnectCandidate)
        XCTAssertFalse(service.canWakePreferredMacDisplay)

        service.relaySessionId = "saved-session"
        service.relayUrl = relayURL
        service.relayMacDeviceId = macDeviceID
        service.relayMacIdentityPublicKey = Data(repeating: 17, count: 32).base64EncodedString()

        XCTAssertTrue(service.canWakePreferredMacDisplay)
    }

    func testRecoverTrustedReconnectCandidatePreservesTrustedMacAndRelayBaseURL() {
        let service = makeService()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let relayURL = "wss://relay.local/relay"
        let macPublicKey = Data(repeating: 18, count: 32).base64EncodedString()

        service.trustedMacRegistry.records[macDeviceID] = CodexTrustedMacRecord(
            macDeviceId: macDeviceID,
            macIdentityPublicKey: macPublicKey,
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.lastTrustedMacDeviceId = macDeviceID
        service.setCurrentTrustedMacDeviceId(macDeviceID)
        service.relaySessionId = "stale-session"
        service.relayUrl = relayURL
        service.relayMacDeviceId = macDeviceID
        service.relayMacIdentityPublicKey = macPublicKey

        service.recoverTrustedReconnectCandidate()

        XCTAssertNil(service.normalizedRelaySessionId)
        XCTAssertEqual(service.normalizedRelayURL, relayURL)
        XCTAssertEqual(service.normalizedRelayMacDeviceId, macDeviceID)
        XCTAssertEqual(service.normalizedRelayMacIdentityPublicKey, macPublicKey)
        XCTAssertFalse(service.hasSavedRelaySession)
        XCTAssertTrue(service.hasTrustedMacReconnectCandidate)
        XCTAssertEqual(service.secureConnectionState, .liveSessionUnresolved)
        XCTAssertFalse(service.canWakePreferredMacDisplay)
        XCTAssertEqual(
            service.lastErrorMessage,
            "Secure reconnect could not be restored from the saved session. Try reconnecting again."
        )
    }

    func testPreferredReconnectURLUsesCurrentMacInsteadOfLastTrustedMac() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let lastTrustedMacDeviceID = "mac-last-\(UUID().uuidString)"
        let currentMacDeviceID = "mac-current-\(UUID().uuidString)"
        let relayURL = "wss://relay.local/relay"

        service.trustedMacRegistry.records[lastTrustedMacDeviceID] = CodexTrustedMacRecord(
            macDeviceId: lastTrustedMacDeviceID,
            macIdentityPublicKey: Data(repeating: 21, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.trustedMacRegistry.records[currentMacDeviceID] = CodexTrustedMacRecord(
            macDeviceId: currentMacDeviceID,
            macIdentityPublicKey: Data(repeating: 22, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.lastTrustedMacDeviceId = lastTrustedMacDeviceID
        service.setCurrentTrustedMacDeviceId(currentMacDeviceID)
        service.trustedSessionResolverOverride = {
            CodexTrustedSessionResolveResponse(
                ok: true,
                macDeviceId: currentMacDeviceID,
                macIdentityPublicKey: Data(repeating: 23, count: 32).base64EncodedString(),
                displayName: "Current Mac",
                sessionId: "resolved-current-session"
            )
        }

        let reconnectURL = await viewModel.preferredReconnectURL(codex: service)

        XCTAssertEqual(reconnectURL, "\(relayURL)/resolved-current-session")
        XCTAssertEqual(service.normalizedCurrentTrustedMacDeviceId, currentMacDeviceID)
        XCTAssertNil(service.normalizedRelayMacDeviceId)
    }

    func testPreferredReconnectURLUsesExplicitTargetMacInsteadOfCurrentMacDuringSwitch() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let currentMacDeviceID = "mac-current-\(UUID().uuidString)"
        let targetMacDeviceID = "mac-target-\(UUID().uuidString)"
        let currentRelayURL = "wss://relay.current/relay"
        let targetRelayURL = "wss://relay.target/relay"

        service.trustedMacRegistry.records[currentMacDeviceID] = CodexTrustedMacRecord(
            macDeviceId: currentMacDeviceID,
            macIdentityPublicKey: Data(repeating: 41, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: currentRelayURL
        )
        service.trustedMacRegistry.records[targetMacDeviceID] = CodexTrustedMacRecord(
            macDeviceId: targetMacDeviceID,
            macIdentityPublicKey: Data(repeating: 42, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: targetRelayURL
        )
        service.setCurrentTrustedMacDeviceId(currentMacDeviceID)
        service.trustedSessionResolverOverride = {
            CodexTrustedSessionResolveResponse(
                ok: true,
                macDeviceId: targetMacDeviceID,
                macIdentityPublicKey: Data(repeating: 43, count: 32).base64EncodedString(),
                displayName: "Target Mac",
                sessionId: "target-session"
            )
        }

        let reconnectURL = await viewModel.preferredReconnectURL(
            codex: service,
            targetMacDeviceId: targetMacDeviceID
        )

        XCTAssertEqual(reconnectURL, "\(targetRelayURL)/target-session")
    }
}
