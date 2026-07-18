// FILE: TurnViewModelQueueTestSupport.swift
// Purpose: Provides shared fixtures for turn queue tests.
// Layer: Unit Test Support
// Exports: TurnViewModelQueueTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
class TurnViewModelQueueTestCase: XCTestCase {
    private static var retainedServices: [CodexService] = []
    private static var retainedViewModels: [TurnViewModel] = []

    func makeDraft(text: String) -> QueuedTurnDraft {
        QueuedTurnDraft(
            id: UUID().uuidString,
            text: text,
            attachments: [],
            skillMentions: [],
            collaborationMode: nil,
            createdAt: Date()
        )
    }

    func waitForSendCompletion(_ viewModel: TurnViewModel, maxPollCount: Int = 160) async {
        for _ in 0..<maxPollCount where viewModel.isSending {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    func waitForSteerCompletion(_ viewModel: TurnViewModel, maxPollCount: Int = 160) async {
        for _ in 0..<maxPollCount where viewModel.steeringDraftID != nil {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    func makeViewModel() -> TurnViewModel {
        let viewModel = TurnViewModel()
        Self.retainedViewModels.append(viewModel)
        return viewModel
    }

    func makeService() -> CodexService {
        let suiteName = "TurnViewModelQueueTests.(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]

        // CodexService currently crashes while deallocating in unit-test environment.
        // Keep instances alive for process lifetime so assertions remain deterministic.
        Self.retainedServices.append(service)
        return service
    }
}
