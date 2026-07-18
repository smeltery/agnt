// FILE: CodexPlanStructuredInputTestSupport.swift
// Purpose: Shared fixtures for structured plan input tests.
// Layer: Unit Test Support
// Exports: CodexPlanStructuredInputTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
class CodexPlanStructuredInputTestCase: XCTestCase {
    private static var retainedServices: [CodexService] = []
    private static var retainedViewModels: [TurnViewModel] = []

    func makeService(
        suiteName: String = "CodexPlanStructuredInputTests.\(UUID().uuidString)",
        reset: Bool = true
    ) -> CodexService {
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        if reset {
            defaults.removePersistentDomain(forName: suiteName)
        }
        let service = CodexService(defaults: defaults)
        if reset {
            service.messagesByThread = [:]
        }
        Self.retainedServices.append(service)
        return service
    }

    func makeViewModel() -> TurnViewModel {
        let viewModel = TurnViewModel()
        Self.retainedViewModels.append(viewModel)
        return viewModel
    }

    func waitForStructuredPromptDismissCompletion(
        _ viewModel: TurnViewModel,
        requestID: JSONValue,
        codex: CodexService
    ) async {
        for _ in 0..<120 {
            if !viewModel.isStructuredPlanPromptDismissing(requestID, codex: codex) {
                return
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Expected structured prompt dismiss to complete")
    }
}
