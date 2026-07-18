// FILE: CodexServiceIncomingFileChangeTestSupport.swift
// Purpose: Shared fixtures for incoming file-change tests.
// Layer: Unit Test Support
// Exports: CodexServiceIncomingFileChangeTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
class CodexServiceIncomingFileChangeTestCase: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingFileChangeTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        // CodexService currently crashes while deallocating in unit-test environment.
        Self.retainedServices.append(service)
        return service
    }
}
