// FILE: ContentViewModelReconnectTestSupport.swift
// Purpose: Provides shared fixtures for reconnect tests.
// Layer: Unit Test Support
// Exports: ContentViewModelReconnectTestCase
// Depends on: XCTest, Foundation, AgntMobile

import Foundation
import XCTest
@testable import AgntMobile

@MainActor
class ContentViewModelReconnectTestCase: XCTestCase {
    private static var retainedServices: [CodexService] = []

    override func setUp() {
        super.setUp()
        clearStoredSecureRelayState()
    }

    override func tearDown() {
        clearStoredSecureRelayState()
        super.tearDown()
    }

    func makeService() -> CodexService {
        let suiteName = "ContentViewModelReconnectTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        Self.retainedServices.append(service)
        return service
    }

    // Clears the persisted relay keys so reconnect tests do not inherit state from other suites.
    func clearStoredSecureRelayState() {
        SecureStore.deleteValue(for: CodexSecureKeys.relaySessionId)
        SecureStore.deleteValue(for: CodexSecureKeys.relayUrl)
        SecureStore.deleteValue(for: CodexSecureKeys.relayMacDeviceId)
        SecureStore.deleteValue(for: CodexSecureKeys.relayMacIdentityPublicKey)
        SecureStore.deleteValue(for: CodexSecureKeys.relayProtocolVersion)
        SecureStore.deleteValue(for: CodexSecureKeys.relayLastAppliedBridgeOutboundSeq)
        SecureStore.deleteValue(for: CodexSecureKeys.relayBridgeReplayEpoch)
        SecureStore.deleteValue(for: CodexSecureKeys.trustedMacRegistry)
        SecureStore.deleteValue(for: CodexSecureKeys.currentTrustedMacDeviceId)
        SecureStore.deleteValue(for: CodexSecureKeys.lastTrustedMacDeviceId)
    }

    func makeMessage(threadID: String, text: String) -> CodexMessage {
        CodexMessage(
            threadId: threadID,
            role: .assistant,
            text: text
}
