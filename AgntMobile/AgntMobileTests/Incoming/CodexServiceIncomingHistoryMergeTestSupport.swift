// FILE: CodexServiceIncomingHistoryMergeTestSupport.swift
// Purpose: Shared fixtures for incoming history-merge tests.
// Layer: Unit Test Support
// Exports: CodexServiceIncomingHistoryMergeTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
class CodexServiceIncomingHistoryMergeTestCase: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingHistoryMergeTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        Self.retainedServices.append(service)
        return service
    }
}
