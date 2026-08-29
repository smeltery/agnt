// FILE: CodexThreadProjectRoutingTests.swift
// Purpose: Verifies same-thread project rebind behavior for managed worktree handoff flows.
// Layer: Unit Test
// Exports: CodexThreadProjectRoutingTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexThreadProjectRoutingTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testMoveThreadToProjectPathKeepsRebindWhenResumeFailsOnlyBecauseRolloutIsMissing() async throws {
        let service = makeService()
        let originalThread = CodexThread(
            id: "thread-1",
            title: "Source",
            cwd: "/tmp/agnt-local"
        )
        service.upsertThread(originalThread)
        service.activeThreadId = "thread-1"
        service.resumedThreadIDs = ["thread-1"]

        var resumeRequests: [[String: JSONValue]] = []
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "thread/resume")
            resumeRequests.append(params?.objectValue ?? [:])
            throw CodexServiceError.rpcError(
                RPCError(code: -32600, message: "no rollout found for thread id thread-1")
            )
        }

        let movedThread = try await service.moveThreadToProjectPath(
            threadId: "thread-1",
            projectPath: "/tmp/agnt-worktree"
        )

        XCTAssertEqual(resumeRequests.count, 1)
        XCTAssertEqual(resumeRequests.first?["threadId"]?.stringValue, "thread-1")
        XCTAssertEqual(resumeRequests.first?["cwd"]?.stringValue, "/tmp/agnt-worktree")
        XCTAssertEqual(movedThread.gitWorkingDirectory, "/tmp/agnt-worktree")
        XCTAssertEqual(service.thread(for: "thread-1")?.gitWorkingDirectory, "/tmp/agnt-worktree")
        XCTAssertEqual(service.currentAuthoritativeProjectPath(for: "thread-1"), "/tmp/agnt-worktree")
        XCTAssertEqual(service.activeThreadId, "thread-1")
        XCTAssertFalse(service.resumedThreadIDs.contains("thread-1"))
    }

    func testRolloutMissingFallbackStillRejectsImmediateStaleServerProjectPath() async throws {
        let service = makeService()
        service.upsertThread(
            CodexThread(
                id: "thread-1",
                title: "Source",
                cwd: "/tmp/agnt-local"
            )
        )
        service.activeThreadId = "thread-1"

        service.requestTransportOverride = { method, _ in
            XCTAssertEqual(method, "thread/resume")
            throw CodexServiceError.rpcError(
                RPCError(code: -32600, message: "no rollout found for thread id thread-1")
            )
        }

        _ = try await service.moveThreadToProjectPath(
            threadId: "thread-1",
            projectPath: "/tmp/agnt-worktree"
        )

        service.upsertThread(
            CodexThread(
                id: "thread-1",
                title: "Source",
                cwd: "/tmp/agnt-local"
            ),
            treatAsServerState: true
        )

        XCTAssertEqual(service.thread(for: "thread-1")?.gitWorkingDirectory, "/tmp/agnt-worktree")
        XCTAssertEqual(service.currentAuthoritativeProjectPath(for: "thread-1"), "/tmp/agnt-worktree")

        service.upsertThread(
            CodexThread(
                id: "thread-1",
                title: "Source",
                cwd: "/tmp/agnt-worktree"
            ),
            treatAsServerState: true
        )

        XCTAssertEqual(service.thread(for: "thread-1")?.gitWorkingDirectory, "/tmp/agnt-worktree")
        XCTAssertNil(service.currentAuthoritativeProjectPath(for: "thread-1"))
    }

    func testServerStateCannotOverwriteAuthoritativeRebindUntilMatchingPathArrives() {
        let service = makeService()
        service.upsertThread(
            CodexThread(
                id: "thread-1",
                title: "Source",
                cwd: "/tmp/agnt-local"
            )
        )

        service.beginAuthoritativeProjectPathTransition(
            threadId: "thread-1",
            projectPath: "/tmp/agnt-worktree"
        )

        service.upsertThread(
            CodexThread(
                id: "thread-1",
                title: "Source",
                cwd: "/tmp/agnt-local"
            ),
            treatAsServerState: true
        )

        XCTAssertEqual(service.thread(for: "thread-1")?.gitWorkingDirectory, "/tmp/agnt-worktree")
        XCTAssertEqual(service.currentAuthoritativeProjectPath(for: "thread-1"), "/tmp/agnt-worktree")

        service.upsertThread(
            CodexThread(
                id: "thread-1",
                title: "Source",
                cwd: "/tmp/agnt-worktree"
            ),
            treatAsServerState: true
        )

        XCTAssertEqual(service.thread(for: "thread-1")?.gitWorkingDirectory, "/tmp/agnt-worktree")
        XCTAssertNil(service.currentAuthoritativeProjectPath(for: "thread-1"))
    }

    func testManagedWorktreeAssociationPersistsAcrossLocalHandoffs() async throws {
        let service = makeService()
        service.upsertThread(
            CodexThread(
                id: "thread-1",
                title: "Source",
                cwd: "/tmp/agnt-local"
            )
        )

        var resumeResponses: [String] = []
        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "thread/resume")
            let cwd = params?.objectValue?["cwd"]?.stringValue ?? ""
            resumeResponses.append(cwd)
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": .object([
                        "id": .string("thread-1"),
                        "cwd": .string(cwd),
                        "title": .string("Source"),
                    ]),
                ]),
                includeJSONRPC: false
            )
        }

        let worktreePath = "/Users/me/.codex/worktrees/a1b2/agnt"
        _ = try await service.moveThreadToProjectPath(threadId: "thread-1", projectPath: worktreePath)
        _ = try await service.moveThreadToProjectPath(threadId: "thread-1", projectPath: "/tmp/agnt-local")

        XCTAssertEqual(resumeResponses, [worktreePath, "/tmp/agnt-local"])
        XCTAssertEqual(service.associatedManagedWorktreePath(for: "thread-1"), worktreePath)
    }

    func testManagedWorktreeAssociationIsScopedPerMac() {
        let suiteName = "CodexThreadProjectRoutingTests.macScope.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = makeService(defaults: defaults)
        let macA = "mac-a-\(UUID().uuidString)"
        let macB = "mac-b-\(UUID().uuidString)"

        service.setCurrentTrustedMacDeviceId(macA)
        service.rememberAssociatedManagedWorktreePath("/tmp/worktree-a", for: "thread-a")
        service.planSessionSourceByThread["thread-a"] = .requested

        service.setCurrentTrustedMacDeviceId(macB)
        service.loadMacScopedDefaultsState(for: macB)
        service.rememberAssociatedManagedWorktreePath("/tmp/worktree-b", for: "thread-b")
        service.planSessionSourceByThread["thread-b"] = .compatibilityFallback

        service.setCurrentTrustedMacDeviceId(macA)
        service.loadMacScopedDefaultsState(for: macA)
        XCTAssertEqual(service.associatedManagedWorktreePath(for: "thread-a"), "/tmp/worktree-a")
        XCTAssertNil(service.associatedManagedWorktreePath(for: "thread-b"))
        XCTAssertEqual(service.planSessionSourceByThread["thread-a"], .requested)
        XCTAssertNil(service.planSessionSourceByThread["thread-b"])

        service.setCurrentTrustedMacDeviceId(macB)
        service.loadMacScopedDefaultsState(for: macB)
        XCTAssertEqual(service.associatedManagedWorktreePath(for: "thread-b"), "/tmp/worktree-b")
        XCTAssertNil(service.associatedManagedWorktreePath(for: "thread-a"))
        XCTAssertEqual(service.planSessionSourceByThread["thread-b"], .compatibilityFallback)
        XCTAssertNil(service.planSessionSourceByThread["thread-a"])
    }

    func testClearInMemoryMacScopedStateClearsAuthoritativeProjectPathTransitions() {
        let service = makeService()

        service.beginAuthoritativeProjectPathTransition(
            threadId: "thread-1",
            projectPath: "/tmp/agnt-worktree"
        )

        service.clearInMemoryMacScopedState()

        XCTAssertNil(service.currentAuthoritativeProjectPath(for: "thread-1"))
    }

    func testContinuationThreadInheritsArchivedThreadProjectPath() async throws {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        service.upsertThread(
            CodexThread(
                id: "thread-desktop-owned",
                title: "Desktop thread",
                cwd: "/Users/me/Developer/synara"
            )
        )

        service.requestTransportOverride = { method, params in
            XCTAssertEqual(method, "thread/start")
            XCTAssertEqual(params?.objectValue?["cwd"]?.stringValue, "/Users/me/Developer/synara")
            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "thread": .object([
                        "id": .string("thread-continuation"),
                        "cwd": .string("/Users/me/Developer/synara"),
                    ]),
                ]),
                includeJSONRPC: false
            )
        }

        let continuation = try await service.createContinuationThread(from: "thread-desktop-owned")

        XCTAssertEqual(continuation.id, "thread-continuation")
        XCTAssertEqual(continuation.normalizedProjectPath, "/Users/me/Developer/synara")
    }

    func testContinuationThreadDoesNotStartWithoutAProjectPath() async throws {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        var requestedMethods: [String] = []

        service.requestTransportOverride = { method, _ in
            requestedMethods.append(method)
            if method == "thread/start" {
                XCTFail("Continuation must not start without an explicit cwd")
            }
            throw CodexServiceError.invalidResponse("Unable to create rootless chat root")
        }

        do {
            _ = try await service.createContinuationThread(from: "thread-without-project")
            XCTFail("Expected continuation creation to fail")
        } catch {
            XCTAssertEqual(requestedMethods, ["project/createRootlessChatRoot"])
        }
    }

    func testStartThreadIfReadyMintsRootlessChatRootWhenNoProjectPathIsProvided() async throws {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true
        let rootlessPath = "/Users/me/Documents/Codex/2026-08-29/untitled-chat"
        var requestedMethods: [String] = []

        service.requestTransportOverride = { method, params in
            requestedMethods.append(method)
            switch method {
            case "project/createRootlessChatRoot":
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "path": .string(rootlessPath),
                    ]),
                    includeJSONRPC: false
                )
            case "thread/start":
                XCTAssertEqual(params?.objectValue?["cwd"]?.stringValue, rootlessPath)
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "id": .string("thread-rootless"),
                            // Server may echo process cwd; preferred mint must win.
                            "cwd": .string("/Users/me"),
                        ]),
                    ]),
                    includeJSONRPC: false
                )
            default:
                throw CodexServiceError.invalidResponse("Unexpected method \(method)")
            }
        }

        let thread = try await service.startThreadIfReady()

        XCTAssertEqual(thread.id, "thread-rootless")
        XCTAssertEqual(thread.normalizedProjectPath, rootlessPath)
        XCTAssertEqual(requestedMethods, ["project/createRootlessChatRoot", "thread/start"])
        XCTAssertEqual(service.currentAuthoritativeProjectPath(for: "thread-rootless"), rootlessPath)
    }

    private func makeService(defaults: UserDefaults? = nil) -> CodexService {
        let resolvedDefaults: UserDefaults
        if let defaults {
            resolvedDefaults = defaults
        } else {
            let suiteName = "CodexThreadProjectRoutingTests.\(UUID().uuidString)"
            let isolatedDefaults = UserDefaults(suiteName: suiteName) ?? .standard
            isolatedDefaults.removePersistentDomain(forName: suiteName)
            resolvedDefaults = isolatedDefaults
        }

        let service = CodexService(defaults: resolvedDefaults)
        Self.retainedServices.append(service)
        return service
    }
}
