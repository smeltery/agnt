// FILE: CodexSystemNoticeTests.swift
// Purpose: Verifies bridge-level system notice parsing and dismissal.
// Layer: Unit Test
// Exports: CodexSystemNoticeTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexSystemNoticeTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testSystemNoticeNotificationEnqueuesTrimmedNotice() {
        let service = makeService()

        service.handleIncomingRPCMessage(
            RPCMessage(
                method: "system/notice",
                params: .object([
                    "severity": .string(" warning "),
                    "title": .string("  MCP auth needed  "),
                    "message": .string("  Reconnect the provider.  "),
                    "provider": .string("  opencode  "),
                    "threadId": .string("  thread-1  "),
                    "durationMs": .integer(50),
                ])
            )
        )

        let notice = service.systemNotices.first
        XCTAssertEqual(service.systemNotices.count, 1)
        XCTAssertEqual(notice?.severity, .warn)
        XCTAssertEqual(notice?.title, "MCP auth needed")
        XCTAssertEqual(notice?.message, "Reconnect the provider.")
        XCTAssertEqual(notice?.provider, "opencode")
        XCTAssertEqual(notice?.threadId, "thread-1")
        XCTAssertEqual(service.systemNoticeDismissTasksByID.count, 1)
    }

    func testSystemNoticeIgnoresEmptyPayloads() {
        let service = makeService()

        service.handleNotification(
            method: "system/notice",
            params: .object([
                "severity": .string("error"),
                "title": .string("  "),
                "message": .string("\n"),
            ])
        )

        XCTAssertTrue(service.systemNotices.isEmpty)
        XCTAssertTrue(service.systemNoticeDismissTasksByID.isEmpty)
    }

    func testSystemNoticeSeverityNormalizesBridgeValues() {
        XCTAssertEqual(CodexSystemNoticeSeverity(rawBridgeValue: "info"), .info)
        XCTAssertEqual(CodexSystemNoticeSeverity(rawBridgeValue: "warning"), .warn)
        XCTAssertEqual(CodexSystemNoticeSeverity(rawBridgeValue: "warn"), .warn)
        XCTAssertEqual(CodexSystemNoticeSeverity(rawBridgeValue: "danger"), .error)
        XCTAssertEqual(CodexSystemNoticeSeverity(rawBridgeValue: "error"), .error)
        XCTAssertEqual(CodexSystemNoticeSeverity(rawBridgeValue: "future"), .info)
        XCTAssertEqual(CodexSystemNoticeSeverity(rawBridgeValue: nil), .info)
    }

    func testDismissSystemNoticeRemovesNoticeAndCancelsTimer() {
        let service = makeService()
        service.handleNotification(
            method: "system/notice",
            params: .object([
                "title": .string("Hello"),
                "durationMs": .integer(1_000),
            ])
        )

        let notice = try XCTUnwrap(service.systemNotices.first)
        service.dismissSystemNotice(id: notice.id)

        XCTAssertTrue(service.systemNotices.isEmpty)
        XCTAssertTrue(service.systemNoticeDismissTasksByID.isEmpty)
    }

    func testTransientConnectionPromptResetClearsSystemNotices() {
        let service = makeService()
        service.handleNotification(
            method: "system/notice",
            params: .object([
                "title": .string("Provider warning"),
                "durationMs": .integer(1_000),
            ])
        )

        XCTAssertEqual(service.systemNotices.count, 1)
        service.clearTransientConnectionPrompts()

        XCTAssertTrue(service.systemNotices.isEmpty)
        XCTAssertTrue(service.systemNoticeDismissTasksByID.isEmpty)
    }

    private func makeService() -> CodexService {
        let suiteName = "CodexSystemNoticeTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        Self.retainedServices.append(service)
        return service
    }
}
