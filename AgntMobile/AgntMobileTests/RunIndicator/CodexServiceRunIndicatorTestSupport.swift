// FILE: CodexServiceRunIndicatorTestSupport.swift
// Purpose: Shared fixtures for CodexService run-indicator tests.
// Layer: Unit Test Support
// Exports: CodexServiceRunIndicatorTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
class CodexServiceRunIndicatorTestCase: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func sendTurnStarted(service: CodexService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/started",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
    }

    func sendTurnCompletedSuccess(service: CodexService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
            ])
        )
    }

    func sendTurnCompletedFailure(
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

    func sendTurnFailed(service: CodexService, threadID: String, turnID: String, message: String) {
        service.handleNotification(
            method: "turn/failed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "message": .string(message),
            ])
        )
    }

    func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingRunIndicatorTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        // CodexService currently crashes while deallocating in unit-test environment.
        Self.retainedServices.append(service)
        return service
    }

    func withSavedRelayPairing(
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
}
