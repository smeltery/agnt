// FILE: CodexServiceIncomingCommandExecutionTestSupport.swift
// Purpose: Provides shared fixtures for command execution incoming tests.
// Layer: Unit Test Support
// Exports: CodexServiceIncomingCommandExecutionTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
class CodexServiceIncomingCommandExecutionTestCase: XCTestCase {
    static var retainedServices: [CodexService] = []

    func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingCommandExecutionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        // CodexService currently crashes while deallocating in unit-test environment.
        // Keep instances alive for the process lifetime so assertions can run deterministically.
        Self.retainedServices.append(service)
        return service
    }
}
