// FILE: ContentViewModelMacSwitchTests.swift
// Purpose: Verifies trusted-Mac switch persistence and cancellation behavior.
// Layer: Unit Test
// Exports: ContentViewModelMacSwitchTests
// Depends on: XCTest, Foundation, Network, AgntMobile

import Foundation
import Network
import XCTest
@testable import AgntMobile

@MainActor
final class ContentViewModelMacSwitchTests: ContentViewModelReconnectTestCase {
    func testDisconnectPersistsMacScopedOverrideNamespace() async {
        let service = makeService()
        let currentMacDeviceID = "mac-current-\(UUID().uuidString)"
        let targetMacDeviceID = "mac-target-\(UUID().uuidString)"

        service.setCurrentTrustedMacDeviceId(currentMacDeviceID)
        service.messagesByThread = [
            "thread-current": [makeMessage(threadID: "thread-current", text: "current")]
        ]
        service.saveLocalState(for: currentMacDeviceID)

        service.messagesByThread = [
            "thread-target": [makeMessage(threadID: "thread-target", text: "target")]
        ]
        service.macScopedContextOverrideDeviceId = targetMacDeviceID

        await service.disconnect()

        XCTAssertEqual(
            service.messagePersistence.load(macDeviceId: currentMacDeviceID)["thread-current"]?.first?.text,
            "current"
        )
        XCTAssertEqual(
            service.messagePersistence.load(macDeviceId: targetMacDeviceID)["thread-target"]?.first?.text,
            "target"
        )
    }

    func testMirroredRunningCatchupSurvivesSaveAndLoadLocalStateRoundTrip() {
        let service = makeService()
        let macDeviceID = "mac-\(UUID().uuidString)"
        let threadID = "thread-\(UUID().uuidString)"

        service.messagesByThread = [
            threadID: [makeMessage(threadID: threadID, text: "still running")],
        ]
        service.markMirroredRunningCatchupNeeded(for: threadID)
        service.saveLocalState(for: macDeviceID)

        // A relaunch starts from a fresh in-memory service; only the persisted
        // snapshot should be able to repopulate the mirrored-running hint.
        service.mirroredRunningCatchupThreadIDs.removeAll()
        service.loadLocalState(for: macDeviceID)

        XCTAssertTrue(service.mirroredRunningCatchupThreadIDs.contains(threadID))
    }

    func testSwitchToTrustedMacFailureRestoresPreviousMacNamespaceWithoutPersistingTargetDrafts() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let currentMacDeviceID = "mac-current-\(UUID().uuidString)"
        let targetMacDeviceID = "mac-target-\(UUID().uuidString)"
        let relayURL = "wss://relay.local/relay"

        service.trustedMacRegistry.records[currentMacDeviceID] = CodexTrustedMacRecord(
            macDeviceId: currentMacDeviceID,
            macIdentityPublicKey: Data(repeating: 31, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.trustedMacRegistry.records[targetMacDeviceID] = CodexTrustedMacRecord(
            macDeviceId: targetMacDeviceID,
            macIdentityPublicKey: Data(repeating: 32, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.setCurrentTrustedMacDeviceId(currentMacDeviceID)
        service.messagesByThread = [
            "thread-current": [makeMessage(threadID: "thread-current", text: "current")]
        ]
        service.saveLocalState(for: currentMacDeviceID)
        service.messagesByThread = [
            "thread-target-old": [makeMessage(threadID: "thread-target-old", text: "target-old")]
        ]
        service.saveLocalState(for: targetMacDeviceID)
        service.loadLocalState(for: currentMacDeviceID)
        service.trustedSessionResolverOverride = {
            CodexTrustedSessionResolveResponse(
                ok: true,
                macDeviceId: targetMacDeviceID,
                macIdentityPublicKey: Data(repeating: 33, count: 32).base64EncodedString(),
                displayName: "Target Mac",
                sessionId: "target-session"
            )
        }
        viewModel.connectOverride = { codex, _ in
            codex.messagesByThread = [
                "thread-target-new": [self.makeMessage(threadID: "thread-target-new", text: "target-new")]
            ]
            await codex.disconnect()
            throw CodexServiceError.disconnected
        }

        do {
            try await viewModel.switchToTrustedMac(deviceId: targetMacDeviceID, codex: service)
            XCTFail("Expected switch failure to roll back.")
        } catch {
            // Expected.
        }

        XCTAssertEqual(service.normalizedCurrentTrustedMacDeviceId, currentMacDeviceID)

        let currentMessages = service.messagePersistence.load(macDeviceId: currentMacDeviceID)
        let targetMessages = service.messagePersistence.load(macDeviceId: targetMacDeviceID)
        XCTAssertEqual(currentMessages["thread-current"]?.first?.text, "current")
        XCTAssertEqual(targetMessages["thread-target-old"]?.first?.text, "target-old")
        XCTAssertNil(targetMessages["thread-target-new"])
    }

    func testSwitchToScannedMacInterruptsRunningTurnsBeforeConnecting() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        var events: [String] = []

        service.isConnected = true
        service.runningThreadIDs = ["thread-1"]
        service.activeTurnIdByThread["thread-1"] = "turn-1"
        service.requestTransportOverride = { method, _ in
            events.append(method)
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([:]),
                includeJSONRPC: false
            )
        }
        viewModel.connectOverride = { _, _ in
            events.append("connect")
            throw CancellationError()
        }

        do {
            try await viewModel.switchToScannedMac(
                pairingPayload: CodexPairingQRPayload(
                    v: codexPairingQRVersion,
                    relay: "wss://relay.local/relay",
                    sessionId: "session-\(UUID().uuidString)",
                    macDeviceId: "mac-\(UUID().uuidString)",
                    macIdentityPublicKey: Data(repeating: 34, count: 32).base64EncodedString(),
                    expiresAt: Int64(Date().addingTimeInterval(60).timeIntervalSince1970 * 1000)
                ),
                codex: service
            )
            XCTFail("Expected connect override to abort the switch.")
        } catch {
            // Expected.
        }

        XCTAssertEqual(events.prefix(2), ["turn/interrupt", "connect"])
    }

    func testCancelledSwitchClearsCurrentSelectionMarksPreviousAndRemovesRelaySession() async {
        let service = makeService()
        let viewModel = ContentViewModel()
        let currentMacDeviceID = "mac-current-\(UUID().uuidString)"
        let targetMacDeviceID = "mac-target-\(UUID().uuidString)"
        let relayURL = "wss://relay.local/relay"

        service.trustedMacRegistry.records[currentMacDeviceID] = CodexTrustedMacRecord(
            macDeviceId: currentMacDeviceID,
            macIdentityPublicKey: Data(repeating: 35, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.trustedMacRegistry.records[targetMacDeviceID] = CodexTrustedMacRecord(
            macDeviceId: targetMacDeviceID,
            macIdentityPublicKey: Data(repeating: 36, count: 32).base64EncodedString(),
            lastPairedAt: Date(),
            relayURL: relayURL
        )
        service.setCurrentTrustedMacDeviceId(currentMacDeviceID)
        service.relaySessionId = "saved-session"
        service.relayUrl = relayURL
        service.relayMacDeviceId = currentMacDeviceID
        viewModel.connectOverride = { _, _ in
            while !Task.isCancelled {
                await Task.yield()
            }
            throw CancellationError()
        }

        let switchTask = Task {
            try await viewModel.switchToTrustedMac(deviceId: targetMacDeviceID, codex: service)
        }

        while !viewModel.isSwitchingMac {
            await Task.yield()
        }

        switchTask.cancel()
        await viewModel.requestMacSwitchCancellation(codex: service)

        do {
            try await switchTask.value
            XCTFail("Expected cancelled switch to terminate with cancellation.")
        } catch is CancellationError {
            // Expected.
        } catch {
            XCTFail("Expected CancellationError, got \(error)")
        }

        XCTAssertNil(service.normalizedCurrentTrustedMacDeviceId)
        XCTAssertEqual(service.normalizedPreviousTrustedMacDeviceId, currentMacDeviceID)
        XCTAssertNil(service.normalizedRelaySessionId)
        XCTAssertNil(service.normalizedRelayMacDeviceId)
        XCTAssertEqual(viewModel.macSwitchNotice, "Switch cancelled. Choose a Mac to reconnect.")
        XCTAssertFalse(viewModel.isSwitchingMac)
    }

    func testSuccessfulReconnectClearsPreviousMarkerAndSwitchNotice() async {
        let service = makeService()
        let viewModel = ContentViewModel()

        service.setPreviousTrustedMacDeviceId("mac-previous")
        viewModel.connectOverride = { _, _ in }

        try? await viewModel.connectWithAutoRecovery(
            codex: service,
            performAutoRetry: false,
            serverURLProvider: { "wss://relay.local/relay/session" }
        )

        XCTAssertNil(service.normalizedPreviousTrustedMacDeviceId)
        XCTAssertNil(viewModel.macSwitchNotice)
    }
}
