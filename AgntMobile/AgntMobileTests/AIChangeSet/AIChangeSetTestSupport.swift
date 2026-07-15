// FILE: AIChangeSetTestSupport.swift
// Purpose: Provides shared fixtures for AI change-set tests.
// Layer: Unit Test Support
// Exports: AIChangeSetTestCase
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
class AIChangeSetTestCase: XCTestCase {
    func recordReadyChangeSet(
        service: CodexService,
        threadID: String,
        filePath: String
    ) -> CodexMessage {
        let turnID = "turn-\(UUID().uuidString)"
        service.completeAssistantMessage(
            threadId: threadID,
            turnId: turnID,
            itemId: nil,
            text: "Implemented the change."
        )
        service.recordTurnDiffChangeSet(
            threadId: threadID,
            turnId: turnID,
            diff: """
            diff --git a/\(filePath) b/\(filePath)
            index 1111111..2222222 100644
            --- a/\(filePath)
            +++ b/\(filePath)
            @@ -1 +1,2 @@
             struct App {}
            +let enabled = true
            """
        )
        service.recordTurnTerminalState(threadId: threadID, turnId: turnID, state: .completed)
        service.noteTurnFinished(threadId: threadID, turnId: turnID)
        return try! XCTUnwrap(service.messages(for: threadID).last(where: { $0.role == .assistant }))
    }

    func makeService() -> CodexService {
        let service = CodexService()
        Self.retainedServices.append(service)
        return service
    }

    static var retainedServices: [CodexService] = []
}
