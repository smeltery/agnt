// FILE: CodexServiceCatchupRecoveryTests.swift
// Purpose: Verifies deferred-history recovery and running-thread catch-up escalation for large or active chats.
// Layer: Unit Test
// Exports: CodexServiceCatchupRecoveryTests
// Depends on: XCTest, AgntMobile

import XCTest
@testable import AgntMobile

@MainActor
final class CodexServiceCatchupRecoveryTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testRunningCatchupEscalatesExistingLightweightTaskIntoForcedResume() async {
        let service = makeService()
        let threadID = "thread-running"
        let turnID = "turn-running"

        service.isConnected = true
        service.isInitialized = true
        service.upsertThread(CodexThread(id: threadID, title: "Running"))

        var resumeRequestCount = 0
        service.requestTransportOverride = { method, params in
            switch method {
            case "thread/read":
                try? await Task.sleep(nanoseconds: 20_000_000)
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "id": .string(threadID),
                            "title": .string("Running"),
                            "turns": .array([
                                .object([
                                    "id": .string(turnID),
                                    "status": .string("running"),
                                ]),
                            ]),
                        ]),
                    ]),
                    includeJSONRPC: false
                )
            case "thread/resume":
                resumeRequestCount += 1
                XCTAssertEqual(params?.objectValue?["threadId"]?.stringValue, threadID)
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "id": .string(threadID),
                            "title": .string("Running"),
                        ]),
                    ]),
                    includeJSONRPC: false
                )
            default:
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([:]),
                    includeJSONRPC: false
                )
            }
        }

        async let lightweightOutcome = service.catchUpRunningThreadIfNeeded(
            threadId: threadID,
            shouldForceResume: false
        )
        await Task.yield()
        let forcedOutcome = await service.catchUpRunningThreadIfNeeded(
            threadId: threadID,
            shouldForceResume: true
        )
        let initialOutcome = await lightweightOutcome

        XCTAssertEqual(resumeRequestCount, 1)
        XCTAssertTrue(forcedOutcome.isRunning)
        XCTAssertTrue(forcedOutcome.didRunForcedResume)
        XCTAssertTrue(initialOutcome.isRunning)
    }

    func testServerUpdateRearmsDeferredHistoryRefreshForLargeActiveChat() {
        let service = makeService()
        let threadID = "thread-large"
        let previousUpdatedAt = Date(timeIntervalSince1970: 10)
        let nextUpdatedAt = Date(timeIntervalSince1970: 20)

        service.activeThreadId = threadID
        service.threadsWithSatisfiedDeferredHistoryHydration.insert(threadID)
        service.messagesByThread[threadID] = (0..<401).map { index in
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "message-\(index)"
            )
        }

        let shouldRefresh = service.shouldRefreshDeferredHydrationForServerUpdate(
            incomingThread: CodexThread(
                id: threadID,
                title: "Large",
                preview: "new preview",
                updatedAt: nextUpdatedAt
            ),
            existingThread: CodexThread(
                id: threadID,
                title: "Large",
                preview: "old preview",
                updatedAt: previousUpdatedAt
            ),
            treatAsServerState: true
        )

        XCTAssertTrue(shouldRefresh)
    }

    func testForegroundSyncKeepsDeferredLargeClosedChatOffForcedHistoryRead() async {
        let service = makeService()
        let threadID = "thread-large-closed"

        service.isConnected = true
        service.isInitialized = true
        service.activeThreadId = threadID
        service.upsertThread(CodexThread(id: threadID, title: "Large Closed"))
        service.messagesByThread[threadID] = (0..<401).map { index in
            CodexMessage(
                threadId: threadID,
                role: .assistant,
                text: "message-\(index)"
            )
        }

        var lightweightTurnRefreshCount = 0
        var canonicalHistoryReadCount = 0
        service.requestTransportOverride = { method, params in
            switch method {
            case "thread/read":
                let includeTurns = params?.objectValue?["includeTurns"]?.boolValue ?? false
                if includeTurns {
                    canonicalHistoryReadCount += 1
                    try? await Task.sleep(nanoseconds: 120_000_000)
                } else {
                    lightweightTurnRefreshCount += 1
                }
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "id": .string(threadID),
                            "title": .string("Large Closed"),
                            "turns": .array([]),
                        ]),
                    ]),
                    includeJSONRPC: false
                )
            default:
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([:]),
                    includeJSONRPC: false
                )
            }
        }

        let startedAt = Date()
        await service.syncActiveThreadState(threadId: threadID)
        let elapsed = Date().timeIntervalSince(startedAt)

        XCTAssertEqual(lightweightTurnRefreshCount, 1)
        XCTAssertLessThan(elapsed, 0.1)
        XCTAssertTrue(service.threadsNeedingCanonicalHistoryReconcile.contains(threadID))
        XCTAssertLessThanOrEqual(canonicalHistoryReadCount, 1)
    }

    func testMarkingNewCanonicalReconcileClearsStaleRetryAttempt() {
        let service = makeService()
        let threadID = "thread-retry-attempt"

        service.canonicalHistoryReconcileRetryAttemptByThreadID[threadID] = 4

        service.markThreadNeedingCanonicalHistoryReconcile(threadID)

        XCTAssertTrue(service.threadsNeedingCanonicalHistoryReconcile.contains(threadID))
        XCTAssertNil(service.canonicalHistoryReconcileRetryAttemptByThreadID[threadID])
    }

    func testCancelPerThreadRefreshWorkClearsCanonicalRetryAttempt() {
        let service = makeService()
        let threadID = "thread-retry-cancel"

        service.canonicalHistoryReconcileRetryAttemptByThreadID[threadID] = 3
        service.canonicalHistoryReconcileRetryTaskByThreadID[threadID] = Task { @MainActor in }

        service.cancelPerThreadRefreshWork(for: threadID)

        XCTAssertNil(service.canonicalHistoryReconcileRetryAttemptByThreadID[threadID])
        XCTAssertNil(service.canonicalHistoryReconcileRetryTaskByThreadID[threadID])
    }

    func testJsonlFallbackFirstPaintSchedulesCanonicalPaginatedRetry() async throws {
        let service = makeService()
        let threadID = "thread-jsonl-first-paint"
        let turnID = "turn-jsonl-first-paint"
        service.isConnected = true
        service.isInitialized = true
        service.supportsTurnPagination = true
        service.activeThreadId = threadID
        service.activeTurnIdByThread[threadID] = "turn-running-guard"
        service.upsertThread(CodexThread(id: threadID, title: "Large chat", preview: "Existing history"))

        var requireCanonicalValues: [Bool] = []
        service.requestTransportOverride = { method, params in
            switch method {
            case "thread/read":
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "id": .string(threadID),
                            "title": .string("Large chat"),
                            "preview": .string("Existing history"),
                        ]),
                    ]),
                    includeJSONRPC: false
                )
            case "thread/turns/list":
                let requiresCanonical = params?.objectValue?["agntRequireCanonical"]?.boolValue == true
                requireCanonicalValues.append(requiresCanonical)
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "data": .array([
                            .object([
                                "id": .string(turnID),
                                "status": .string("completed"),
                                "items": .array([
                                    .object([
                                        "id": .string("assistant-jsonl-first-paint"),
                                        "type": .string("agentMessage"),
                                        "text": .string(requiresCanonical ? "Canonical history" : "Fast local history"),
                                    ]),
                                ]),
                            ]),
                        ]),
                        "nextCursor": requiresCanonical
                            ? .string("canonical-older-cursor")
                            : .string("agnt-jsonl-handoff-v1:test"),
                        "agntJsonlFallback": .bool(!requiresCanonical),
                    ]),
                    includeJSONRPC: false
                )
            default:
                return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
            }
        }

        let provisionalOutcome = try await service.loadThreadHistoryIfNeeded(
            threadId: threadID,
            forceRefresh: true
        )

        XCTAssertEqual(provisionalOutcome, .loadedProvisionalPaginatedWindow)
        XCTAssertEqual(requireCanonicalValues, [false])
        XCTAssertTrue(service.provisionalPaginatedHistoryThreadIDs.contains(threadID))
        XCTAssertTrue(service.threadsNeedingCanonicalHistoryReconcile.contains(threadID))
        XCTAssertFalse(service.hasRemoteOlderThreadHistoryCursor(threadId: threadID))
        XCTAssertEqual(service.messages(for: threadID).last?.text, "Fast local history")

        service.activeTurnIdByThread.removeValue(forKey: threadID)
        let canonicalOutcome = try await service.loadThreadHistoryIfNeeded(
            threadId: threadID,
            forceRefresh: true
        )

        XCTAssertEqual(canonicalOutcome, .loadedPaginatedWindow)
        XCTAssertEqual(requireCanonicalValues, [false, true])
        XCTAssertFalse(service.provisionalPaginatedHistoryThreadIDs.contains(threadID))
        XCTAssertFalse(service.threadsNeedingCanonicalHistoryReconcile.contains(threadID))
        XCTAssertTrue(service.hasRemoteOlderThreadHistoryCursor(threadId: threadID))
        XCTAssertEqual(service.messages(for: threadID).last?.text, "Canonical history")
    }

    func testEmptyInitialPaginationForExistingThreadStaysLoadingAndRetryable() async throws {
        let service = makeService()
        let threadID = "thread-empty-existing"
        service.isConnected = true
        service.isInitialized = true
        service.supportsTurnPagination = true
        service.activeThreadId = threadID
        service.upsertThread(CodexThread(id: threadID, title: "Existing chat", preview: "Older message"))
        service.requestTransportOverride = { method, _ in
            switch method {
            case "thread/read":
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "id": .string(threadID),
                            "title": .string("Existing chat"),
                            "preview": .string("Older message"),
                        ]),
                    ]),
                    includeJSONRPC: false
                )
            case "thread/turns/list":
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object(["data": .array([]), "nextCursor": .null]),
                    includeJSONRPC: false
                )
            default:
                return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
            }
        }

        let outcome = try await service.loadThreadHistoryIfNeeded(threadId: threadID, forceRefresh: true)
        service.isConnected = false
        service.canonicalHistoryReconcileTaskByThreadID[threadID]?.cancel()
        service.canonicalHistoryReconcileRetryTaskByThreadID[threadID]?.cancel()

        XCTAssertEqual(outcome, .deferredAfterEmptyPage)
        XCTAssertFalse(service.initialTurnsLoadedByThreadID.contains(threadID))
        XCTAssertFalse(service.hydratedThreadIDs.contains(threadID))
        XCTAssertTrue(service.threadsNeedingCanonicalHistoryReconcile.contains(threadID))
        XCTAssertEqual(service.threadDisplayPhase(threadId: threadID), .loading)
    }

    func testBridgePaginationFailureKeepsCachedRowsAndRetries() async throws {
        let service = makeService()
        let threadID = "thread-bridge-retry"
        service.isConnected = true
        service.isInitialized = true
        service.supportsTurnPagination = true
        service.activeThreadId = threadID
        service.upsertThread(CodexThread(id: threadID, title: "Large chat", preview: "Existing history"))
        service.messagesByThread[threadID] = [
            CodexMessage(id: "cached", threadId: threadID, role: .assistant, text: "Cached history"),
        ]

        service.requestTransportOverride = { method, _ in
            switch method {
            case "thread/read":
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([
                        "thread": .object([
                            "id": .string(threadID),
                            "title": .string("Large chat"),
                            "preview": .string("Existing history"),
                        ]),
                    ]),
                    includeJSONRPC: false
                )
            case "thread/turns/list":
                throw CodexServiceError.rpcError(RPCError(
                    code: -32000,
                    message: "The newest chat turn is too large to relay safely.",
                    data: .object(["errorCode": .string("thread_turns_list_failed")])
                ))
            default:
                return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
            }
        }

        let outcome = try await service.loadThreadHistoryIfNeeded(threadId: threadID, forceRefresh: true)
        service.isConnected = false
        service.canonicalHistoryReconcileTaskByThreadID[threadID]?.cancel()
        service.canonicalHistoryReconcileRetryTaskByThreadID[threadID]?.cancel()

        XCTAssertEqual(outcome, .deferredAfterUnavailablePage)
        XCTAssertEqual(service.messages(for: threadID).map(\.text), ["Cached history"])
        XCTAssertTrue(service.hydratedThreadIDs.contains(threadID))
        XCTAssertTrue(service.initialTurnsLoadedByThreadID.contains(threadID))
        XCTAssertTrue(service.threadsNeedingCanonicalHistoryReconcile.contains(threadID))
    }

    private func makeService() -> CodexService {
        let suiteName = "CodexServiceCatchupRecoveryTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        Self.retainedServices.append(service)
        return service
    }
}
