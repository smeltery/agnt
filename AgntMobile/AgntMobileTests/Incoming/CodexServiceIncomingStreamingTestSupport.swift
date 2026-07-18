// FILE: CodexServiceIncomingStreamingTestSupport.swift
// Purpose: Provides shared fixtures for incoming streaming tests.
// Layer: Unit Test Support
// Exports: CodexServiceIncomingStreamingTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
class CodexServiceIncomingStreamingTestCase: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func sendTurnCompletedSuccess(service: CodexService, threadID: String, turnID: String) {
        service.handleNotification(
            method: "turn/completed",
            params: .object([
                "threadId": .string(threadID),
                "turnId": .string(turnID),
                "usage": .object([:]),
            ])
        )
    }

    func makeService() -> CodexService {
        let suiteName = "CodexServiceIncomingStreamingTests.(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        service.messagesByThread = [:]
        Self.retainedServices.append(service)
        return service
    }

    func makeTimelineMessage(
        id: String,
        threadID: String,
        role: CodexMessageRole,
        kind: CodexMessageKind = .chat,
        text: String,
        turnID: String,
        orderIndex: Int
    ) -> CodexMessage {
        CodexMessage(
            id: id,
            threadId: threadID,
            role: role,
            kind: kind,
            text: text,
            turnId: turnID,
            orderIndex: orderIndex
        )
    }
}
