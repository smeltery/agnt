// FILE: CodexThreadGoalTests.swift
// Purpose: Validates thread goal RPC encoding, error mapping, and local mirroring.
// Layer: Unit Test
// Exports: CodexThreadGoalTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexThreadGoalTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testGoalCapsuleElapsedTimeAlwaysIncludesSeconds() {
        XCTAssertEqual(GoalStatusChip.formatElapsedSeconds(11_839), "3h 17m 19s")
        XCTAssertEqual(GoalStatusChip.formatElapsedSeconds(79), "1m 19s")
        XCTAssertEqual(GoalStatusChip.formatElapsedSeconds(9), "9s")
    }

    func testSetThreadGoalOmitsTokenBudgetWhenKeeping() async throws {
        let (service, captured) = makeCapturingService()

        _ = try await service.setThreadGoal(
            threadId: "thread-1",
            objective: "Ship goal mode",
            status: .active,
            tokenBudget: .keep
        )

        let params = try XCTUnwrap(captured().first?.objectValue)
        XCTAssertEqual(params["objective"]?.stringValue, "Ship goal mode")
        XCTAssertEqual(params["status"]?.stringValue, "active")
        XCTAssertNil(params["tokenBudget"])
    }

    func testSetThreadGoalSendsExplicitNullWhenClearingBudget() async throws {
        let (service, captured) = makeCapturingService()

        _ = try await service.setThreadGoal(threadId: "thread-1", tokenBudget: .clear)

        let params = try XCTUnwrap(captured().first?.objectValue)
        XCTAssertEqual(params["tokenBudget"], .null)
    }

    func testSetThreadGoalRejectsInvalidBudgetBeforeTransport() async {
        let service = makeService()
        var didSend = false
        service.requestTransportOverride = { _, _ in
            didSend = true
            return RPCMessage(id: .string("1"), result: .object([:]), includeJSONRPC: false)
        }

        do {
            _ = try await service.setThreadGoal(threadId: "thread-1", tokenBudget: .set(0))
            XCTFail("Expected invalid budget")
        } catch {
            XCTAssertEqual(error as? CodexThreadGoalError, .invalidBudget)
            XCTAssertFalse(didSend)
        }
    }

    func testSetThreadGoalUpdatesLocalMirrorFromResponse() async throws {
        let (service, _) = makeCapturingService()

        let goal = try await service.setThreadGoal(threadId: "thread-1", objective: "Ship goal mode")

        XCTAssertEqual(goal.status, .active)
        XCTAssertEqual(service.goalByThreadID["thread-1"]?.objective, "Ship goal mode")
    }

    func testMethodNotFoundDisablesGoalSupport() async {
        let service = makeService()
        service.requestTransportOverride = { _, _ in
            throw CodexServiceError.rpcError(RPCError(code: -32601, message: "Method not found"))
        }

        do {
            _ = try await service.setThreadGoal(threadId: "thread-1", objective: "x")
            XCTFail("Expected unsupported goals")
        } catch {
            XCTAssertEqual(error as? CodexThreadGoalError, .goalsUnsupported)
            XCTAssertFalse(service.supportsThreadGoals)
        }
    }

    func testClearThreadGoalRemovesLocalMirror() async throws {
        let service = makeService()
        service.goalByThreadID["thread-1"] = makeGoal(threadId: "thread-1")
        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "thread/goal/clear")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["cleared": .bool(true)]),
                includeJSONRPC: false
            )
        }

        let cleared = try await service.clearThreadGoal(threadId: "thread-1")

        XCTAssertTrue(cleared)
        XCTAssertNil(service.goalByThreadID["thread-1"])
    }

    func testThreadGoalNotificationsUpdateLocalMirror() {
        let service = makeService()
        service.handleNotification(
            method: "thread/goal/updated",
            params: .object([
                "goal": .object(goalObject(threadId: "thread-1", objective: "Keep CI green")),
            ])
        )

        XCTAssertEqual(service.goalByThreadID["thread-1"]?.objective, "Keep CI green")

        service.handleNotification(
            method: "thread/goal/cleared",
            params: .object(["threadId": .string("thread-1")])
        )

        XCTAssertNil(service.goalByThreadID["thread-1"])
    }

    private func makeCapturingService() -> (CodexService, () -> [JSONValue]) {
        let service = makeService()
        var capturedParams: [JSONValue] = []
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "thread/goal/set")
            capturedParams.append(params ?? .null)
            let requestObjective = params?.objectValue?["objective"]?.stringValue ?? "existing objective"
            let requestStatus = params?.objectValue?["status"]?.stringValue ?? "active"
            let threadId = params?.objectValue?["threadId"]?.stringValue ?? "thread-1"
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["goal": .object(goalObject(
                    threadId: threadId,
                    objective: requestObjective,
                    status: requestStatus
                ))]),
                includeJSONRPC: false
            )
        }
        return (service, { capturedParams })
    }

    private func makeService() -> CodexService {
        let suiteName = "CodexThreadGoalTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        Self.retainedServices.append(service)
        return service
    }

    private func makeGoal(threadId: String) -> CodexThreadGoal {
        CodexThreadGoal(object: goalObject(threadId: threadId, objective: "Existing objective"))!
    }
}

private func goalObject(
    threadId: String,
    objective: String,
    status: String = "active"
) -> [String: JSONValue] {
    [
        "threadId": .string(threadId),
        "objective": .string(objective),
        "status": .string(status),
        "tokenBudget": .null,
        "tokensUsed": .integer(0),
        "timeUsedSeconds": .integer(0),
        "createdAt": .integer(1),
        "updatedAt": .integer(1),
    ]
}
