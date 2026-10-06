// FILE: CodexService+ThreadHistoryHydration.swift
// Purpose: Thread history fetch, pagination, fallback, and merge pipeline.
// Layer: Service

import Foundation

extension CodexService {
    // Loads the recent history page once per thread, leaving older pages behind a cursor.
    @discardableResult
    func loadThreadHistoryIfNeeded(
        threadId: String,
        forceRefresh: Bool = false,
        markHydratedWhenNotMaterialized: Bool = true,
        allowForceRefreshRetry: Bool = true
    ) async throws -> ThreadHistoryLoadOutcome {
        if forceRefresh {
            forcedHistoryLoadThreadIDs.insert(threadId)
        }
        if shouldShowImmediateEmptyPlaceholder(
            threadId: threadId,
            hasVisibleMessages: !messages(for: threadId).isEmpty,
            isThreadRunning: threadHasActiveOrRunningTurn(threadId)
        ) {
            forcedHistoryLoadThreadIDs.remove(threadId)
            hydratedThreadIDs.insert(threadId)
            refreshThreadTimelineState(for: threadId)
            return .alreadyHydrated
        }
        if !forceRefresh,
           hydratedThreadIDs.contains(threadId),
           hasSatisfiedInitialThreadHistoryLoad(threadId: threadId) {
            return .alreadyHydrated
        }
        if !markHydratedWhenNotMaterialized {
            deferHydratedMarkForNotMaterializedThreadIDs.insert(threadId)
        }

        if let existingTask = threadHistoryLoadTaskByThreadID[threadId] {
            let outcome = try await existingTask.value
            if forceRefresh,
               allowForceRefreshRetry,
               outcome == .skippedForRunningThread,
               threadHasActiveOrRunningTurn(threadId) {
                forcedHistoryLoadThreadIDs.insert(threadId)
                return try await loadThreadHistoryIfNeeded(
                    threadId: threadId,
                    forceRefresh: true,
                    markHydratedWhenNotMaterialized: markHydratedWhenNotMaterialized,
                    allowForceRefreshRetry: false
                )
            }
            return outcome
        }

        let refreshGeneration = currentPerThreadRefreshGeneration(for: threadId)
        let task = Task<ThreadHistoryLoadOutcome, Error> { @MainActor in
            let hadInitialTurnsLoadedBeforeRefresh = initialTurnsLoadedByThreadID.contains(threadId)
            let hadAuthoritativeLocalStartBeforeRefresh = hasAuthoritativeLocalHistoryStart(threadId: threadId)
            let hadProvisionalPaginatedHistoryBeforeRefresh = provisionalPaginatedHistoryThreadIDs.contains(threadId)
            let requiresCanonicalPaginatedHistory = hadProvisionalPaginatedHistoryBeforeRefresh
                || threadsNeedingCanonicalHistoryReconcile.contains(threadId)
            let initialTurnsTask = supportsTurnPagination
                ? Task { @MainActor in
                    try await self.fetchInitialThreadTurnsHistoryPage(
                        threadId: threadId,
                        requireCanonical: requiresCanonicalPaginatedHistory
                    )
                }
                : nil
            loadingThreadIDs.insert(threadId)
            defer {
                initialTurnsTask?.cancel()
                // Only clear bookkeeping for the latest refresh generation.
                if isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) {
                    loadingThreadIDs.remove(threadId)
                    threadHistoryLoadTaskByThreadID.removeValue(forKey: threadId)
                    forcedHistoryLoadThreadIDs.remove(threadId)
                    deferHydratedMarkForNotMaterializedThreadIDs.remove(threadId)
                }
            }

            // Metadata comes from thread/read without turns; transcript rows come from
            // thread/turns/list so large chats never require one huge app-server response.
            let metadataParams: JSONValue = .object([
                "threadId": .string(threadId),
                "includeTurns": .bool(false),
            ])

            let response: RPCMessage
            do {
                response = try await sendRequest(
                    method: "thread/read",
                    params: metadataParams,
                    timeoutNanoseconds: ThreadHistoryHydrationPolicy.requestTimeoutNanoseconds
                )
            } catch let error as CodexServiceError {
                if shouldTreatAsEmptyUnmaterializedThreadHistory(
                    error,
                    threadId: threadId,
                    markHydratedWhenNotMaterialized: markHydratedWhenNotMaterialized
                ) {
                    return .notMaterialized
                }
                if case .rpcError(let rpcError) = error, rpcError.code == -32600 {
                    // Sidebar/timeline metadata fetches should keep retrying while the child thread
                    // is still materializing, but full history hydration can stop here.
                    let shouldMarkHydrated = markHydratedWhenNotMaterialized
                        && !deferHydratedMarkForNotMaterializedThreadIDs.contains(threadId)
                    if shouldMarkHydrated {
                        hydratedThreadIDs.insert(threadId)
                        initialTurnsLoadedByThreadID.insert(threadId)
                    }
                    return .notMaterialized
                }
                if shouldDeferThreadHistoryAfterTimeout(error) {
                    markThreadHistoryDeferredAfterTimeout(threadId: threadId)
                    debugSyncLog("thread/read timed out for thread=\(threadId); showing local timeline while canonical history is deferred")
                    return .deferredAfterTimeout
                }
                throw error
            }

            guard !Task.isCancelled,
                  isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                throw CancellationError()
            }

            guard let resultObject = response.result?.objectValue,
                  var threadObject = resultObject["thread"]?.objectValue else {
                throw CodexServiceError.invalidResponse("thread/read response missing thread payload")
            }

            extractContextWindowUsageIfAvailable(threadId: threadId, threadObject: threadObject)

            // Upsert thread metadata (name, agentNickname, agentRole, model, etc.)
            // so subagent identity resolves without navigating into the child thread.
            if let threadData = try? JSONEncoder().encode(JSONValue.object(threadObject)),
               let decoded = try? JSONDecoder().decode(CodexThread.self, from: threadData) {
                upsertThread(decoded, treatAsServerState: true)
            }

            let shouldForceRefresh = forceRefresh || forcedHistoryLoadThreadIDs.contains(threadId)

            // A turn may have started while thread/read was in flight. Normal background
            // history loads should still stay out of the way, but forced refreshes are
            // used when reopening a running thread and need to merge the latest snapshot.
            if threadHasActiveOrRunningTurn(threadId) && !shouldForceRefresh {
                hydratedThreadIDs.insert(threadId)
                if !supportsTurnPagination {
                    initialTurnsLoadedByThreadID.insert(threadId)
                }
                return .skippedForRunningThread
            }

            var loadedViaPagination = false
            var loadedProvisionalJsonlFallback = false
            if supportsTurnPagination {
                do {
                    let turnsPage: ThreadTurnsHistoryPage
                    if let initialTurnsTask {
                        turnsPage = try await initialTurnsTask.value
                    } else {
                        turnsPage = try await fetchInitialThreadTurnsHistoryPage(
                            threadId: threadId,
                            requireCanonical: requiresCanonicalPaginatedHistory
                        )
                    }
                    loadedViaPagination = true
                    loadedProvisionalJsonlFallback = turnsPage.isProvisionalJsonlFallback
                    let shouldSeedInitialCursor = !hadInitialTurnsLoadedBeforeRefresh
                        || hadProvisionalPaginatedHistoryBeforeRefresh
                        || (
                            !hasRemoteOlderThreadHistoryCursor(threadId: threadId)
                                && !hadAuthoritativeLocalStartBeforeRefresh
                        )
                    if !loadedProvisionalJsonlFallback {
                        updateOlderThreadHistoryCursorFromInitialPage(
                            threadId: threadId,
                            cursor: turnsPage.nextCursor,
                            isFreshInitialLoad: shouldSeedInitialCursor
                        )
                    }
                    threadObject["turns"] = .array(chronologicalTurnsFromDescendingPage(turnsPage.turns))
                } catch let error as CodexServiceError {
                    if shouldTreatAsEmptyUnmaterializedThreadHistory(
                        error,
                        threadId: threadId,
                        markHydratedWhenNotMaterialized: markHydratedWhenNotMaterialized
                    ) {
                        return .notMaterialized
                    }
                    if case .rpcError(let rpcError) = error, rpcError.code == -32600 {
                        let shouldMarkHydrated = markHydratedWhenNotMaterialized
                            && !deferHydratedMarkForNotMaterializedThreadIDs.contains(threadId)
                        if shouldMarkHydrated {
                            hydratedThreadIDs.insert(threadId)
                            initialTurnsLoadedByThreadID.insert(threadId)
                        }
                        return .notMaterialized
                    }
                    if shouldDeferThreadHistoryAfterTimeout(error) {
                        markThreadHistoryDeferredAfterTimeout(threadId: threadId)
                        debugSyncLog("thread/turns/list timed out for thread=\(threadId); showing local timeline while history is deferred")
                        return .deferredAfterTimeout
                    }
                    if shouldDeferThreadHistoryAfterBridgeFailure(error) {
                        markThreadHistoryDeferredAfterUnavailablePage(threadId: threadId)
                        debugSyncLog("bridge could not supply thread/turns/list for thread=\(threadId); keeping local timeline while history retries")
                        return .deferredAfterUnavailablePage
                    }
                    if consumeUnsupportedTurnPagination(error, attemptedMethod: "thread/turns/list") {
                        do {
                            threadObject = try await fetchLegacyThreadHistoryObject(threadId: threadId)
                        } catch let legacyError as CodexServiceError {
                            if shouldTreatAsEmptyUnmaterializedThreadHistory(
                                legacyError,
                                threadId: threadId,
                                markHydratedWhenNotMaterialized: markHydratedWhenNotMaterialized
                            ) {
                                return .notMaterialized
                            }
                            if case .rpcError(let rpcError) = legacyError, rpcError.code == -32600 {
                                let shouldMarkHydrated = markHydratedWhenNotMaterialized
                                    && !deferHydratedMarkForNotMaterializedThreadIDs.contains(threadId)
                                if shouldMarkHydrated {
                                    hydratedThreadIDs.insert(threadId)
                                    initialTurnsLoadedByThreadID.insert(threadId)
                                }
                                return .notMaterialized
                            }
                            if shouldDeferThreadHistoryAfterTimeout(legacyError) {
                                markThreadHistoryDeferredAfterTimeout(threadId: threadId)
                                debugSyncLog("legacy thread/read timed out for thread=\(threadId); showing local timeline while history is deferred")
                                return .deferredAfterTimeout
                            }
                            throw legacyError
                        }
                        extractContextWindowUsageIfAvailable(threadId: threadId, threadObject: threadObject)
                    } else {
                        throw error
                    }
                }
            } else {
                do {
                    threadObject = try await fetchLegacyThreadHistoryObject(threadId: threadId)
                } catch let error as CodexServiceError {
                    if shouldTreatAsEmptyUnmaterializedThreadHistory(
                        error,
                        threadId: threadId,
                        markHydratedWhenNotMaterialized: markHydratedWhenNotMaterialized
                    ) {
                        return .notMaterialized
                    }
                    if case .rpcError(let rpcError) = error, rpcError.code == -32600 {
                        let shouldMarkHydrated = markHydratedWhenNotMaterialized
                            && !deferHydratedMarkForNotMaterializedThreadIDs.contains(threadId)
                        if shouldMarkHydrated {
                            hydratedThreadIDs.insert(threadId)
                            initialTurnsLoadedByThreadID.insert(threadId)
                        }
                        return .notMaterialized
                    }
                    if shouldDeferThreadHistoryAfterTimeout(error) {
                        markThreadHistoryDeferredAfterTimeout(threadId: threadId)
                        debugSyncLog("legacy thread/read timed out for thread=\(threadId); showing local timeline while history is deferred")
                        return .deferredAfterTimeout
                    }
                    throw error
                }
                extractContextWindowUsageIfAvailable(threadId: threadId, threadObject: threadObject)
            }

            let historyTerminalStates = decodeTurnTerminalStatesFromThreadRead(threadObject)
            let didUpdateTerminalStates = mergeHistoryTurnTerminalStates(
                threadId: threadId,
                terminalStatesByTurnID: historyTerminalStates
            )
            let historyMessages = decodeMessagesFromThreadRead(threadId: threadId, threadObject: threadObject)
            if CodexAsyncUserInputProjection.hasMissingAnswerCandidate(
                in: messagesByThread[threadId] ?? [], canonical: historyMessages
            ) {
                scheduleAsyncAnswerVerification(threadId: threadId, delay: 3)
            }
            let isSuspiciousEmptyHistory = historyMessages.isEmpty
                && shouldDeferEmptyThreadHistoryPage(
                    threadId: threadId,
                    loadedViaPagination: loadedViaPagination
                )
            if isSuspiciousEmptyHistory {
                markThreadHistoryDeferredAfterEmptyPage(threadId: threadId)
                debugSyncLog("thread history returned no visible rows despite prior-content evidence thread=\(threadId); keeping cached timeline and retrying")
                return .deferredAfterEmptyPage
            }
            registerSubagentThreads(from: historyMessages, parentThreadId: threadId)
            if loadedViaPagination {
                seedThreadTimelineProjectionForPaginatedHistory(
                    threadId: threadId,
                    decodedMessageCount: historyMessages.count
                )
                initialTurnsLoadedByThreadID.insert(threadId)
            } else {
                updateThreadTimelineProjectionForEmbeddedHistory(threadId: threadId, decodedMessageCount: historyMessages.count)
            }
            var outcome: ThreadHistoryLoadOutcome = loadedViaPagination
                ? (loadedProvisionalJsonlFallback
                    ? .loadedProvisionalPaginatedWindow
                    : .loadedPaginatedWindow)
                : .loadedCanonicalHistory
            if !historyMessages.isEmpty {
                let cachedMessages = messagesByThread[threadId] ?? []
                let replacesMirroredSourceEpoch = !loadedProvisionalJsonlFallback
                    && pendingCanonicalSourceReplacementThreadIDs.contains(threadId)
                let existingMessages = replacesMirroredSourceEpoch
                    ? Self.existingMessagesForCanonicalSourceReplacement(cachedMessages, history: historyMessages)
                    : cachedMessages
                let activeThreadIDs = Set(activeTurnIdByThread.keys)
                let runningIDs = runningThreadIDs
                let usedRecentWindow = !replacesMirroredSourceEpoch
                    && shouldForceRefresh
                    && threadHasActiveOrRunningTurn(threadId)
                    && Self.shouldPreferRecentHistoryWindow(
                        existingCount: existingMessages.count,
                        historyCount: historyMessages.count
                    )
                if loadedViaPagination,
                   shouldTrustExistingCacheAsPrePaginationFullHistory(
                    threadId: threadId,
                    existingMessages: existingMessages,
                    paginatedMessages: historyMessages,
                    hadInitialTurnsLoadedBeforeRefresh: hadInitialTurnsLoadedBeforeRefresh,
                    hadAuthoritativeLocalStartBeforeRefresh: hadAuthoritativeLocalStartBeforeRefresh
                   ) {
                    markThreadLocalHistoryStartAuthoritative(threadId, clearRemoteCursor: true)
                    debugSyncLog("thread history migrated pre-pagination full cache thread=\(threadId) local=\(existingMessages.count) firstPage=\(historyMessages.count)")
                } else if !loadedViaPagination, !usedRecentWindow {
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
                guard shouldForceRefresh || !threadHasActiveOrRunningTurn(threadId) else {
                    hydratedThreadIDs.insert(threadId)
                    return .skippedForRunningThread
                }

                // Keep any already-hydrated local transcript and merge pages into it. Do not
                // shrink a legacy/full local cache down to only the first paginated page.
                let nextMessages = merged
                if nextMessages != cachedMessages {
                    messagesByThread[threadId] = nextMessages
                    persistMessages()
                    updateCurrentOutput(for: threadId)
                } else if didUpdateTerminalStates {
                    refreshThreadTimelineState(for: threadId)
                }
                if usedRecentWindow {
                    outcome = .loadedRecentWindow
                    if !threadHasActiveOrRunningTurn(threadId) {
                        scheduleCanonicalHistoryReconcileIfNeeded(for: threadId)
                    }
                } else if outcome.didCompleteCanonicalReconcile, !threadHasActiveOrRunningTurn(threadId) {
                    markThreadCanonicalHistoryReconciled(threadId)
                }
                if loadedProvisionalJsonlFallback {
                    provisionalPaginatedHistoryThreadIDs.insert(threadId)
                    markThreadNeedingCanonicalHistoryReconcile(threadId)
                } else if loadedViaPagination {
                    provisionalPaginatedHistoryThreadIDs.remove(threadId)
                }
                if replacesMirroredSourceEpoch {
                    pendingCanonicalSourceReplacementThreadIDs.remove(threadId)
                }
            } else if didUpdateTerminalStates {
                refreshThreadTimelineState(for: threadId)
            } else if loadedProvisionalJsonlFallback {
                provisionalPaginatedHistoryThreadIDs.insert(threadId)
                markThreadNeedingCanonicalHistoryReconcile(threadId)
            } else if loadedViaPagination {
                provisionalPaginatedHistoryThreadIDs.remove(threadId)
            }

            guard !Task.isCancelled,
                  isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                throw CancellationError()
            }
            if outcome == .loadedPaginatedWindow, !threadHasActiveOrRunningTurn(threadId) {
                markThreadPaginatedHistorySatisfied(threadId)
            } else if outcome.didCompleteCanonicalReconcile, !threadHasActiveOrRunningTurn(threadId) {
                markThreadCanonicalHistoryReconciled(threadId)
            }
            clearDeferredThreadHistoryErrorIfNeeded(threadId: threadId)
            initialTurnsLoadedByThreadID.insert(threadId)
            hydratedThreadIDs.insert(threadId)
            refreshThreadTimelineState(for: threadId)
            return outcome
        }

        threadHistoryLoadTaskByThreadID[threadId] = task
        return try await task.value
    }

    // Extracts context window usage from thread/read response if the runtime includes it.
    func extractContextWindowUsageIfAvailable(threadId: String, threadObject: [String: JSONValue]) {
        guard let usage = extractContextWindowUsage(from: threadObject) else { return }
        contextWindowUsageByThread[threadId] = usage
    }
}
