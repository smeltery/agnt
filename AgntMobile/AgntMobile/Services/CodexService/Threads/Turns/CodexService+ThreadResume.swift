// FILE: CodexService+ThreadResume.swift
// Purpose: Thread resume and in-flight turn refresh helpers.
// Layer: Service

import Foundation

extension CodexService {
    func createContinuationThread(from archivedThreadId: String) async throws -> CodexThread {
        let continuationRuntimeOverride = threadRuntimeOverride(for: archivedThreadId)
        let continuationProjectPath = try await requiredContinuationProjectPath(from: archivedThreadId)
        let continuationThread = try await startThreadIfReady(
            preferredProjectPath: continuationProjectPath,
            runtimeOverride: continuationRuntimeOverride
        )
        appendSystemMessage(
            threadId: continuationThread.id,
            text: "Continued from archived thread `\(archivedThreadId)`"
        )
        return continuationThread
    }

    private func requiredContinuationProjectPath(from archivedThreadId: String) async throws -> String {
        if let sourceProjectPath = thread(for: archivedThreadId)?.normalizedProjectPath {
            return sourceProjectPath
        }

        try await awaitRuntimeInitializedIfNeeded()
        return try await createRootlessChatRoot(promptHint: nil)
    }

    @discardableResult
    func ensureThreadResumed(
        threadId: String,
        force: Bool = false,
        preferredProjectPath: String? = nil,
        modelIdentifierOverride: String? = nil
    ) async throws -> CodexThread? {
        guard !threadId.isEmpty else {
            return nil
        }

        if force {
            forcedResumeEscalationThreadIDs.insert(threadId)
        }
        if !force, resumedThreadIDs.contains(threadId) {
            return thread(for: threadId)
        }
        let requestedSignature = CodexThreadResumeRequestSignature(
            projectPath: CodexThreadStartProjectBinding.normalizedProjectPath(preferredProjectPath)
                ?? thread(for: threadId)?.gitWorkingDirectory,
            modelIdentifier: modelIdentifierOverride ?? runtimeModelIdentifierForTurn()
        )
        let refreshGeneration = currentPerThreadRefreshGeneration(for: threadId)
        if let existingTask = threadResumeTaskByThreadID[threadId] {
            if threadResumeRequestSignatureByThreadID[threadId] == requestedSignature {
                return try await existingTask.value
            }

            _ = try await existingTask.value
            return try await ensureThreadResumed(
                threadId: threadId,
                force: force,
                preferredProjectPath: preferredProjectPath,
                modelIdentifierOverride: modelIdentifierOverride
            )
        }

        let task = Task<CodexThread?, Error> { @MainActor in
            defer {
                // Ignore stale refreshes so an older task cannot clear newer state.
                if isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) {
                    threadResumeTaskByThreadID.removeValue(forKey: threadId)
                    threadResumeRequestSignatureByThreadID.removeValue(forKey: threadId)
                    forcedResumeEscalationThreadIDs.remove(threadId)
                }
            }

            var params: RPCObject = [
                "threadId": .string(threadId),
            ]
            let resolvedProjectPath = requestedSignature.projectPath
            if let workingDirectory = resolvedProjectPath {
                params["cwd"] = .string(workingDirectory)
            }
            if let modelIdentifier = requestedSignature.modelIdentifier {
                params["model"] = .string(modelIdentifier)
            }
            if supportsTurnPagination {
                params["excludeTurns"] = .bool(true)
            }
            var didRequestExcludedTurns = params["excludeTurns"] != nil
            let response: RPCMessage
            do {
                response = try await sendRequestWithSandboxFallback(method: "thread/resume", baseParams: params)
            } catch {
                guard didRequestExcludedTurns, consumeUnsupportedTurnPagination(error) else {
                    throw error
                }

                params.removeValue(forKey: "excludeTurns")
                didRequestExcludedTurns = false
                response = try await sendRequestWithSandboxFallback(method: "thread/resume", baseParams: params)
            }
            guard !Task.isCancelled,
                  isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                throw CancellationError()
            }

            guard let resultObject = response.result?.objectValue else {
                resumedThreadIDs.insert(threadId)
                return nil
            }

            var resumedThread: CodexThread?
            var didReceiveEmbeddedHistory = false
            if let threadValue = resultObject["thread"],
               var decodedThread = decodeModel(CodexThread.self, from: threadValue) {
                decodedThread.syncState = .live
                upsertThread(decodedThread, treatAsServerState: true)
                resumedThread = decodedThread

                if let threadObject = threadValue.objectValue {
                    if didRequestExcludedTurns,
                       threadObject["turns"]?.arrayValue?.isEmpty == false {
                        markTurnPaginationUnsupportedForCurrentRuntime()
                        didRequestExcludedTurns = false
                    }
                    let historyMessages = decodeMessagesFromThreadRead(threadId: threadId, threadObject: threadObject)
                    registerSubagentThreads(from: historyMessages, parentThreadId: threadId)
                    if !historyMessages.isEmpty {
                        didReceiveEmbeddedHistory = true
                        initialTurnsLoadedByThreadID.insert(threadId)
                        updateThreadTimelineProjectionForEmbeddedHistory(
                            threadId: threadId,
                            decodedMessageCount: historyMessages.count
                        )
                        let existingMessages = messagesByThread[threadId] ?? []
                        let activeThreadIDs = Set(activeTurnIdByThread.keys)
                        let runningIDs = runningThreadIDs
                        let usedRecentWindow = threadHasActiveOrRunningTurn(threadId)
                            && Self.shouldPreferRecentHistoryWindow(
                                existingCount: existingMessages.count,
                                historyCount: historyMessages.count
                            )
                        if !usedRecentWindow {
                            markThreadLocalHistoryStartAuthoritative(threadId, clearRemoteCursor: true)
                        }
                        if usedRecentWindow {
                            markThreadNeedingCanonicalHistoryReconcile(threadId)
                        }
                        let merged = try await mergeHistoryMessagesOffMainActor(
                            existing: existingMessages,
                            history: historyMessages,
                            activeThreadIDs: activeThreadIDs,
                            runningThreadIDs: runningIDs,
                            preferRecentWindow: usedRecentWindow
                        )
                        guard !Task.isCancelled,
                              isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                            throw CancellationError()
                        }
                        let shouldForceMerge = force || forcedResumeEscalationThreadIDs.contains(threadId)
                        // Forced resumes are used when reopening a running thread, so merge the
                        // latest snapshot even mid-run and let mergeHistoryMessages preserve
                        // existing streaming rows instead of waiting for the final block.
                        if (shouldForceMerge || !threadHasActiveOrRunningTurn(threadId) || existingMessages.isEmpty)
                            && merged != existingMessages {
                            messagesByThread[threadId] = merged
                            persistMessages()
                            updateCurrentOutput(for: threadId)
                        }
                        if usedRecentWindow, !threadHasActiveOrRunningTurn(threadId) {
                            scheduleCanonicalHistoryReconcileIfNeeded(for: threadId)
                        } else if !threadHasActiveOrRunningTurn(threadId) {
                            markThreadCanonicalHistoryReconciled(threadId)
                        }
                    }
                }
            } else if let index = threadIndex(for: threadId) {
                threads[index].syncState = .live
            }

            guard !Task.isCancelled,
                  isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                throw CancellationError()
            }
            if !didRequestExcludedTurns || didReceiveEmbeddedHistory {
                hydratedThreadIDs.insert(threadId)
                if !supportsTurnPagination {
                    initialTurnsLoadedByThreadID.insert(threadId)
                }
            }
            resumedThreadIDs.insert(threadId)
            return resumedThread
        }

        threadResumeTaskByThreadID[threadId] = task
        threadResumeRequestSignatureByThreadID[threadId] = requestedSignature
        return try await task.value
    }

    func isThreadMissingOnServer(_ threadId: String) async -> Bool {
        let params: JSONValue = .object([
            "threadId": .string(threadId),
            "includeTurns": .bool(false),
        ])

        do {
            _ = try await sendRequest(method: "thread/read", params: params)
            return false
        } catch {
            return shouldTreatAsThreadNotFound(error)
        }
    }

    // Rebuilds active turn/running state from server truth after reconnect/background transitions.
    // Returns false when the snapshot could not be refreshed, so callers can fall back to history sync.
    func refreshInFlightTurnState(threadId: String) async -> Bool {
        let normalizedThreadID = normalizedInterruptIdentifier(threadId)
        guard let normalizedThreadID,
              isConnected,
              isInitialized else {
            return false
        }

        let refreshGeneration = currentPerThreadRefreshGeneration(for: normalizedThreadID)
        if let existingTask = turnStateRefreshTaskByThreadID[normalizedThreadID] {
            return await existingTask.value
        }

        let task = Task<Bool, Never> { @MainActor in
            defer {
                if isPerThreadRefreshCurrent(for: normalizedThreadID, generation: refreshGeneration) {
                    turnStateRefreshTaskByThreadID.removeValue(forKey: normalizedThreadID)
                }
            }

            do {
                let snapshot = try await readThreadTurnStateSnapshot(threadId: normalizedThreadID)
                guard !Task.isCancelled,
                      isPerThreadRefreshCurrent(for: normalizedThreadID, generation: refreshGeneration) else {
                    return false
                }

                if let runningTurnID = snapshot.interruptibleTurnID {
                    markThreadAsRunning(normalizedThreadID)
                    setProtectedRunningFallback(false, for: normalizedThreadID)
                    setActiveTurnID(runningTurnID, for: normalizedThreadID)
                    threadIdByTurnID[runningTurnID] = normalizedThreadID
                    activeTurnId = runningTurnID
                    return true
                }

                if snapshot.hasInterruptibleTurnWithoutID {
                    markThreadAsRunning(normalizedThreadID)
                    setProtectedRunningFallback(true, for: normalizedThreadID)
                } else {
                    clearRunningState(for: normalizedThreadID)
                }

                if let existingTurnID = activeTurnID(for: normalizedThreadID) {
                    setActiveTurnID(nil, for: normalizedThreadID)
                    if threadIdByTurnID[existingTurnID] == normalizedThreadID {
                        threadIdByTurnID.removeValue(forKey: existingTurnID)
                    }
                    if activeTurnId == existingTurnID {
                        activeTurnId = nil
                    }
                }
                return true
            } catch {
                debugSyncLog("in-flight turn refresh failed thread=\(normalizedThreadID): \(error.localizedDescription)")
                return false
            }
        }

        turnStateRefreshTaskByThreadID[normalizedThreadID] = task
        return await task.value
    }
}
