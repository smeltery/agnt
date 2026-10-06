// FILE: CodexService+TurnInterrupts.swift
// Purpose: Resolves in-flight turn state and sends turn interruption requests.
// Layer: Service support
// Exports: CodexService turn interrupt helpers
// Depends on: Foundation, JSONValue, CodexSyntheticIdentifiers

import Foundation

private enum ThreadTurnStateSnapshotPolicy {
    static let recentTurnLimit = 8
    static let requestTimeoutNanoseconds: UInt64 = 30_000_000_000
}

extension CodexService {
    func sendInterruptRequest(
        turnId: String,
        threadId: String?,
        useSnakeCaseParams: Bool
    ) async throws {
        var params: RPCObject = [:]
        params[useSnakeCaseParams ? "turn_id" : "turnId"] = .string(turnId)
        if let threadId {
            params[useSnakeCaseParams ? "thread_id" : "threadId"] = .string(threadId)
        }
        _ = try await sendRequest(method: "turn/interrupt", params: .object(params))
    }

    // Normalizes ids coming from UI/runtime state before RPC usage.
    func normalizedInterruptIdentifier(_ rawValue: String?) -> String? {
        guard let rawValue else { return nil }
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // Resolves the currently interruptible turn id from the latest turn page when local state is stale.
    // If the runtime reports "running" without an id yet, surface that instead of falling
    // back to the latest completed turn and interrupting the wrong run.
    func resolveInFlightTurnID(threadId: String) async throws -> String? {
        let maxAttempts = 3
        for attempt in 0..<maxAttempts {
            let snapshot = try await readThreadTurnStateSnapshot(threadId: threadId)
            if let interruptibleTurnID = snapshot.interruptibleTurnID {
                return interruptibleTurnID
            }
            if snapshot.hasInterruptibleTurnWithoutID {
                if attempt < (maxAttempts - 1) {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    continue
                }
                throw CodexServiceError.invalidInput(
                    "The active run has not published an interruptible turn ID yet. Please try again in a moment."
                )
            }
            return nil
        }
        return nil
    }

    // Parses turn status values from app-server turn objects.
    func normalizedInterruptTurnStatus(from turnObject: [String: JSONValue]) -> String? {
        let status = turnObject["status"]?.stringValue
            ?? turnObject["turnStatus"]?.stringValue
            ?? turnObject["turn_status"]?.stringValue

        guard let status else { return nil }

        let trimmed = status.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        return trimmed
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
            .lowercased()
    }

    // Marks statuses that can still accept turn/interrupt.
    func isInterruptibleTurnStatus(_ normalizedStatus: String?) -> Bool {
        guard let normalizedStatus else {
            return true
        }

        if normalizedStatus.contains("inprogress")
            || normalizedStatus.contains("running")
            || normalizedStatus.contains("pending")
            || normalizedStatus.contains("started") {
            return true
        }

        if normalizedStatus.contains("complete")
            || normalizedStatus.contains("failed")
            || normalizedStatus.contains("error")
            || normalizedStatus.contains("interrupt")
            || normalizedStatus.contains("cancel")
            || normalizedStatus.contains("stopped") {
            return false
        }

        return true
    }

    // Retries with snake_case params for strict or legacy server parsers.
    func shouldRetryInterruptWithSnakeCaseParams(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        guard rpcError.code == -32600 || rpcError.code == -32602 else {
            return false
        }

        let message = rpcError.message.lowercased()
        let hints = ["turnid", "threadid", "turn_id", "thread_id", "unknown field", "missing field", "invalid"]
        return hints.contains { message.contains($0) }
    }

    // Reads only the latest turn page when supported, then falls back for older runtimes.
    func readThreadTurnStateSnapshot(threadId: String) async throws -> (
        interruptibleTurnID: String?,
        hasInterruptibleTurnWithoutID: Bool,
        latestTurnID: String?,
        latestTurnStatus: String?
    ) {
        if supportsTurnPagination {
            do {
                let response = try await sendRequest(
                    method: "thread/turns/list",
                    params: .object([
                        "threadId": .string(threadId),
                        "limit": .integer(ThreadTurnStateSnapshotPolicy.recentTurnLimit),
                        "sortDirection": .string("desc"),
                        "agntTurnStateOnly": .bool(true),
                    ]),
                    timeoutNanoseconds: ThreadTurnStateSnapshotPolicy.requestTimeoutNanoseconds
                )

                guard let resultObject = response.result?.objectValue else {
                    return (nil, false, nil, nil)
                }
                if let mirrorActiveTurnID = normalizedInterruptIdentifier(
                    resultObject["agntMirrorActiveTurnId"]?.stringValue
                ) {
                    return (mirrorActiveTurnID, false, mirrorActiveTurnID, "inprogress")
                }

                let turnObjects = (
                    resultObject["data"]?.arrayValue
                        ?? resultObject["items"]?.arrayValue
                        ?? resultObject["turns"]?.arrayValue
                        ?? []
                ).compactMap { $0.objectValue }
                return turnStateSnapshot(from: turnObjects, newestFirst: true, knownParallelTurnIDs: knownParallelTurnIDs(for: threadId))
            } catch {
                guard consumeUnsupportedTurnPagination(error, attemptedMethod: "thread/turns/list") else {
                    throw error
                }
            }
        }

        let response: RPCMessage
        do {
            response = try await sendRequest(
                method: "thread/read",
                params: .object([
                    "threadId": .string(threadId),
                    "includeTurns": .bool(true),
                ]),
                timeoutNanoseconds: ThreadTurnStateSnapshotPolicy.requestTimeoutNanoseconds
            )
        } catch {
            guard shouldRetryThreadReadTurnSnapshotWithSnakeCase(error) else {
                throw error
            }

            response = try await sendRequest(
                method: "thread/read",
                params: .object([
                    "thread_id": .string(threadId),
                    "include_turns": .bool(true),
                ]),
                timeoutNanoseconds: ThreadTurnStateSnapshotPolicy.requestTimeoutNanoseconds
            )
        }

        let turnObjects = response.result?.objectValue?["thread"]?.objectValue?["turns"]?.arrayValue?
            .compactMap { $0.objectValue } ?? []
        return turnStateSnapshot(from: turnObjects, newestFirst: false, knownParallelTurnIDs: knownParallelTurnIDs(for: threadId))
    }

    // Parses latest/running turn metadata from either descending pages or chronological legacy arrays.
    func turnStateSnapshot(
        from turnObjects: [RPCObject],
        newestFirst: Bool,
        knownParallelTurnIDs: Set<String> = []
    ) -> (
        interruptibleTurnID: String?,
        hasInterruptibleTurnWithoutID: Bool,
        latestTurnID: String?,
        latestTurnStatus: String?
    ) {
        guard !turnObjects.isEmpty else {
            return (nil, false, nil, nil)
        }

        let newestTurnObjects = newestFirst ? turnObjects : Array(turnObjects.reversed())
        let latestTurnID = newestTurnObjects.compactMap { turnObject -> String? in
            guard let turnID = normalizedInterruptIdentifier(
                turnObject["id"]?.stringValue
                    ?? turnObject["turnId"]?.stringValue
                    ?? turnObject["turn_id"]?.stringValue
            ), !CodexSyntheticIdentifiers.isHistoryCompactionMarkerTurnID(turnID) else {
                return nil
            }
            return turnID
        }.first
        let latestTurn = newestTurnObjects.first { turn in
            normalizedInterruptIdentifier(turn["id"]?.stringValue
                ?? turn["turnId"]?.stringValue ?? turn["turn_id"]?.stringValue) == latestTurnID
        }
        let latestTurnStatus = latestTurn.flatMap { normalizedInterruptTurnStatus(from: $0) }


        // Parallel turns can finish out of order. A newer terminal turn does not
        // prove that an older in-progress sibling is no longer interruptible.
        var hasInterruptibleTurnWithoutID = false
        var encounteredTerminalBoundary = false
        for turnObject in newestTurnObjects {
            // The bridge's compaction banner ships without a real turn status
            // (older bridges omit it entirely); reading it as interruptible
            // flagged idle heavy threads as running.
            if let turnID = normalizedInterruptIdentifier(
                turnObject["id"]?.stringValue
                    ?? turnObject["turnId"]?.stringValue
                    ?? turnObject["turn_id"]?.stringValue
            ), CodexSyntheticIdentifiers.isHistoryCompactionMarkerTurnID(turnID) {
                continue
            }
            let turnStatus = normalizedInterruptTurnStatus(from: turnObject)
            if !isInterruptibleTurnStatus(turnStatus) {
                encounteredTerminalBoundary = true
                continue
            }
            if let interruptibleTurnID = normalizedInterruptIdentifier(
                turnObject["id"]?.stringValue
                    ?? turnObject["turnId"]?.stringValue
                    ?? turnObject["turn_id"]?.stringValue
            ) {
                // A terminal row is a sequential-history boundary unless local
                // lifecycle already proves this older turn was a parallel sibling.
                if encounteredTerminalBoundary,
                   !knownParallelTurnIDs.contains(interruptibleTurnID) {
                    continue
                }
                return (interruptibleTurnID, false, latestTurnID, latestTurnStatus)
            }

            if encounteredTerminalBoundary {
                continue
            }
            hasInterruptibleTurnWithoutID = true
            break
        }

        return (nil, hasInterruptibleTurnWithoutID, latestTurnID, latestTurnStatus)
    }

    private func knownParallelTurnIDs(for threadId: String) -> Set<String> {
        var turnIDs = displacedActiveTurnIDsByThread[threadId] ?? []
        if let activeTurnID = activeTurnID(for: threadId) {
            turnIDs.insert(activeTurnID)
        }
        return turnIDs
    }

    // Keeps stop recovery compatible with runtimes that only accept snake_case thread/read params.
    func shouldRetryThreadReadTurnSnapshotWithSnakeCase(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        guard rpcError.code == -32600 || rpcError.code == -32602 else {
            return false
        }

        let message = rpcError.message.lowercased()
        let hints = ["threadid", "includeturns", "thread_id", "include_turns", "unknown field", "missing field", "invalid"]
        return hints.contains { message.contains($0) }
    }

    // Retries after refreshing turn id when local activeTurn cache is stale.
    func shouldRetryInterruptWithRefreshedTurnID(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        let hints = [
            "turn not found",
            "no active turn",
            "not in progress",
            "not running",
            "already completed",
            "already finished",
            "invalid turn",
            "no such turn",
            "not active",
            "does not exist",
            "cannot interrupt"
        ]
        return hints.contains { message.contains($0) }
    }

    // Retries steer once after refreshing the active turn id when the server rejects the precondition.
    func shouldRetrySteerWithRefreshedTurnID(_ error: Error) -> Bool {
        shouldRetryInterruptWithRefreshedTurnID(error)
    }
}
