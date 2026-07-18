// FILE: CodexServiceImageGenerationTestSupport.swift
// Purpose: Provides shared fixtures for generated-image incoming tests.
// Layer: Unit Test Support
// Exports: CodexServiceImageGenerationTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
class CodexServiceImageGenerationTestCase: XCTestCase {
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

    func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingImageGenerationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        Self.retainedServices.append(service)
        return service
    }
}
