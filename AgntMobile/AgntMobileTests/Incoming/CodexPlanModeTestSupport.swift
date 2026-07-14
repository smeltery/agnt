// FILE: CodexPlanModeTestSupport.swift
// Purpose: Provides shared fixtures for plan-mode tests.
// Layer: Unit Test Support
// Exports: CodexPlanModeTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
class CodexPlanModeTestCase: XCTestCase {
    static var retainedServices: [CodexService] = []
    static var retainedViewModels: [TurnViewModel] = []

    func makeService(
        suiteName: String = "CodexPlanModeTests.\(UUID().uuidString)",
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

    func makeModel() -> CodexModelOption {
        CodexModelOption(
            id: "gpt-5-codex",
            model: "gpt-5-codex",
            displayName: "GPT-5 Codex",
            description: "Test model",
            isDefault: true,
            supportedReasoningEfforts: [
                CodexReasoningEffortOption(reasoningEffort: "medium", description: "Medium"),
            ],
            defaultReasoningEffort: "medium"
        )
    }

    func waitForSendCompletion(_ viewModel: TurnViewModel) async {
        for _ in 0..<120 {
            if !viewModel.isSending {
                return
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Expected send to complete")
    }

    func textInput(from params: JSONValue?) -> String? {
        params?
            .objectValue?["input"]?
            .arrayValue?
            .compactMap(\.objectValue)
            .first(where: { $0["type"]?.stringValue == "text" })?["text"]?
            .stringValue
    }
}
