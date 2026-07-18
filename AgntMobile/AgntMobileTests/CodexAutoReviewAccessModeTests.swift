// FILE: CodexAutoReviewAccessModeTests.swift
// Purpose: Verifies approve-for-me runtime payload compatibility.
// Layer: Unit Test
// Exports: CodexAutoReviewAccessModeTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexAutoReviewAccessModeTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testAutoReviewModeSendsCanonicalReviewer() async throws {
        let service = makeService()
        service.selectedAccessMode = .autoReview
        var capturedParams: [String: JSONValue] = [:]
        service.requestTransportOverride = { _, params in
            capturedParams = params?.objectValue ?? [:]
            return RPCMessage(
                id: .string("request-1"),
                result: .object([:]),
                includeJSONRPC: false
            )
        }

        _ = try await service.sendRequestWithApprovalPolicyFallback(
            method: "turn/start",
            baseParams: [:],
            context: "test"
        )

        XCTAssertEqual(capturedParams["approvalPolicy"], .string("on-request"))
        XCTAssertEqual(capturedParams["approvalsReviewer"], .string("auto_review"))
    }

    func testAutoReviewFallsBackToLegacyReviewer() async throws {
        let service = makeService()
        service.selectedAccessMode = .autoReview
        var attempts: [[String: JSONValue]] = []
        service.requestTransportOverride = { _, params in
            let object = params?.objectValue ?? [:]
            attempts.append(object)
            if object["approvalsReviewer"] == .string("auto_review") {
                throw CodexServiceError.rpcError(
                    RPCError(
                        code: -32602,
                        message: "unknown variant `auto_review`, expected `user` or `guardian_subagent`"
                    )
                )
            }
            return RPCMessage(
                id: .string("request-1"),
                result: .object([:]),
                includeJSONRPC: false
            )
        }

        _ = try await service.sendRequestWithApprovalPolicyFallback(
            method: "turn/start",
            baseParams: [:],
            context: "test"
        )

        XCTAssertEqual(attempts.map { $0["approvalsReviewer"] }, [.string("auto_review"), .string("guardian_subagent")])
    }

    private func makeService() -> CodexService {
        let suiteName = "CodexAutoReviewAccessModeTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        Self.retainedServices.append(service)
        return service
    }
}
