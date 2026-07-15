// FILE: CodexService+ThreadHistoryOlderPages.swift
// Purpose: Loads older paginated thread history and advances older-page cursors.
// Layer: Service extension
// Exports: CodexService older thread history pagination APIs
// Depends on: CodexService thread history pagination primitives

import Foundation

extension CodexService {
    // Loads the next older page after local rows have all been revealed by the timeline.
    func loadOlderThreadHistoryPage(threadId: String) async {
        guard let cursor = olderThreadHistoryCursorByThreadID[threadId],
              cursorHasValue(cursor),
              !hasKnownLocalHistoryStart(threadId: threadId),
              !loadingOlderThreadHistoryIDs.contains(threadId) else {
            return
        }

        loadingOlderThreadHistoryIDs.insert(threadId)
        olderHistoryLoadErrorByThreadID.removeValue(forKey: threadId)
        refreshThreadTimelineState(for: threadId)
        defer {
            loadingOlderThreadHistoryIDs.remove(threadId)
            refreshThreadTimelineState(for: threadId)
        }

        do {
            var pageCursor = cursor
            var duplicatePagesSkipped = 0

            while true {
                let startedAt = Date()
                debugSyncLog("thread/turns/list older start thread=\(threadId) limit=\(ThreadHistoryHydrationPolicy.olderTurnPageSize)")
                let page = try await fetchThreadTurnsHistoryPage(
                    threadId: threadId,
                    limit: ThreadHistoryHydrationPolicy.olderTurnPageSize,
                    cursor: pageCursor,
                    timeoutNanoseconds: ThreadHistoryHydrationPolicy.requestTimeoutNanoseconds
                )
                let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
                let hasNextCursor = cursorHasValue(page.nextCursor)
                debugSyncLog("thread/turns/list older thread=\(threadId) limit=\(ThreadHistoryHydrationPolicy.olderTurnPageSize) turns=\(page.turns.count) hasNextCursor=\(hasNextCursor) elapsedMs=\(elapsedMs)")
                guard !Task.isCancelled else {
                    return
                }

                let threadObject: RPCObject = [
                    "id": .string(threadId),
                    "turns": .array(chronologicalTurnsFromDescendingPage(page.turns)),
                ]
                let olderMessages = decodeMessagesFromThreadRead(threadId: threadId, threadObject: threadObject)
                registerSubagentThreads(from: olderMessages, parentThreadId: threadId)

                let olderTerminalStates = decodeTurnTerminalStatesFromThreadRead(threadObject)
                _ = mergeHistoryTurnTerminalStates(
                    threadId: threadId,
                    terminalStatesByTurnID: olderTerminalStates
                )

                guard !olderMessages.isEmpty else {
                    if hasNextCursor,
                       page.nextCursor != pageCursor,
                       duplicatePagesSkipped < ThreadHistoryHydrationPolicy.duplicateOlderPageSkipLimit {
                        updateOlderThreadHistoryCursor(threadId: threadId, cursor: page.nextCursor)
                        pageCursor = page.nextCursor
                        duplicatePagesSkipped += 1
                        continue
                    }

                    debugSyncLog("thread/turns/list older empty page thread=\(threadId) hasNextCursor=\(hasNextCursor); advancing cursor")
                    finishOlderPageWithoutNewRows(
                        threadId: threadId,
                        nextCursor: page.nextCursor,
                        currentCursor: pageCursor
                    )
                    refreshThreadTimelineState(for: threadId)
                    return
                }

                let existingMessages = messagesByThread[threadId] ?? []
                let orderedOlderMessages = olderHistoryMessagesFilteredAndOrderedBeforeExisting(
                    olderMessages,
                    existingMessages: existingMessages
                )

                if orderedOlderMessages.isEmpty {
                    debugSyncLog("thread/turns/list older duplicate page thread=\(threadId) decodedMessages=\(olderMessages.count) hasNextCursor=\(hasNextCursor)")
                    if hasNextCursor,
                       page.nextCursor != pageCursor,
                       duplicatePagesSkipped < ThreadHistoryHydrationPolicy.duplicateOlderPageSkipLimit {
                        updateOlderThreadHistoryCursor(threadId: threadId, cursor: page.nextCursor)
                        pageCursor = page.nextCursor
                        duplicatePagesSkipped += 1
                        continue
                    }

                    debugSyncLog("thread/turns/list older duplicate pages exhausted thread=\(threadId) hasNextCursor=\(hasNextCursor); advancing cursor")
                    finishOlderPageWithoutNewRows(
                        threadId: threadId,
                        nextCursor: page.nextCursor,
                        currentCursor: pageCursor
                    )
                    refreshThreadTimelineState(for: threadId)
                    return
                }

                let merged = try await mergeHistoryMessagesOffMainActor(
                    existing: existingMessages,
                    history: orderedOlderMessages,
                    activeThreadIDs: Set(activeTurnIdByThread.keys),
                    runningThreadIDs: runningThreadIDs,
                    preferRecentWindow: false
                )

                guard !Task.isCancelled else {
                    return
                }

                if merged == existingMessages {
                    debugSyncLog("thread/turns/list older no-op page thread=\(threadId) decodedMessages=\(olderMessages.count) candidates=\(orderedOlderMessages.count) hasNextCursor=\(hasNextCursor)")
                    if hasNextCursor,
                       page.nextCursor != pageCursor,
                       duplicatePagesSkipped < ThreadHistoryHydrationPolicy.duplicateOlderPageSkipLimit {
                        updateOlderThreadHistoryCursor(threadId: threadId, cursor: page.nextCursor)
                        pageCursor = page.nextCursor
                        duplicatePagesSkipped += 1
                        continue
                    }

                    if !hasNextCursor {
                        updateOlderCursorOrMarkStart(threadId: threadId, nextCursor: page.nextCursor)
                        debugSyncLog("thread/turns/list older no-op after local start thread=\(threadId); hiding older button")
                        refreshThreadTimelineState(for: threadId)
                        return
                    }

                    finishOlderPageWithoutNewRows(
                        threadId: threadId,
                        nextCursor: page.nextCursor,
                        currentCursor: pageCursor
                    )
                    refreshThreadTimelineState(for: threadId)
                    return
                }

                updateOlderCursorOrMarkStart(
                    threadId: threadId,
                    nextCursor: page.nextCursor,
                    currentCursor: pageCursor
                )
                expandThreadTimelineProjectionForRemoteOlderMessages(
                    threadId: threadId,
                    addedCount: orderedOlderMessages.count
                )
                debugSyncLog("thread/turns/list older merge thread=\(threadId) decodedMessages=\(olderMessages.count) newMessages=\(orderedOlderMessages.count) totalMessages=\(merged.count) hasNextCursor=\(hasNextCursor)")
                messagesByThread[threadId] = merged
                persistMessages()
                updateCurrentOutput(for: threadId)
                return
            }
        } catch is CancellationError {
            return
        } catch {
            if consumeUnsupportedTurnPagination(error, attemptedMethod: "thread/turns/list") {
                return
            }
            noteThreadHistoryRemoteRevealFailed(threadId: threadId)
            olderHistoryLoadErrorByThreadID[threadId] = "Couldn't load earlier messages. Tap to retry."
            refreshThreadTimelineState(for: threadId)
            debugSyncLog("failed to load older history page for thread=\(threadId): \(error.localizedDescription)")
        }
    }

    // Only the first paginated hydration seeds the older cursor. Later fresh pages
    // must not revive "Load earlier" after the user already reached the start.
    func updateOlderThreadHistoryCursorFromInitialPage(threadId: String, cursor: JSONValue, isFreshInitialLoad: Bool) {
        guard isFreshInitialLoad else {
            return
        }
        if hasAuthoritativeLocalHistoryStart(threadId: threadId) {
            clearOlderThreadHistoryCursor(threadId: threadId)
            return
        }
        if cursorHasValue(cursor) {
            if exhaustedOlderThreadHistoryCursorByThreadID[threadId] == cursor {
                clearOlderThreadHistoryCursor(threadId: threadId, clearExhaustedCursor: false)
                return
            }
            threadsWithAuthoritativeLocalHistoryStart.remove(threadId)
            updateOlderThreadHistoryCursor(threadId: threadId, cursor: cursor)
        } else {
            markThreadLocalHistoryStartAuthoritative(threadId, clearRemoteCursor: true)
        }
    }

    func clearOlderThreadHistoryCursor(
        threadId: String,
        persistState: Bool = true,
        clearExhaustedCursor: Bool = true
    ) {
        olderThreadHistoryCursorByThreadID.removeValue(forKey: threadId)
        olderHistoryLoadErrorByThreadID.removeValue(forKey: threadId)
        if clearExhaustedCursor {
            exhaustedOlderThreadHistoryCursorByThreadID.removeValue(forKey: threadId)
        }
        if persistState {
            persistThreadHistoryPaginationState()
        }
    }

    // Remote older pages prepend rows, so the render window must expand with the successful page.
    private func expandThreadTimelineProjectionForRemoteOlderMessages(threadId: String, addedCount: Int) {
        guard addedCount > 0 else {
            return
        }
        let currentLimit = threadTimelineProjectionLimitByThreadID[threadId]
            ?? TurnTimelineProjectionPolicy.initialMessageLimit
        threadTimelineProjectionLimitByThreadID[threadId] = currentLimit + addedCount
    }

    // Older pages are prepended chronologically; dedupe items without dropping partial turns.
    private func olderHistoryMessagesFilteredAndOrderedBeforeExisting(
        _ olderMessages: [CodexMessage],
        existingMessages: [CodexMessage]
    ) -> [CodexMessage] {
        let existingItemIDs = Set(existingMessages.compactMap { Self.normalizedHistoryIdentifier($0.itemId) })
        let existingMessageKeys = Set(existingMessages.map(Self.historyMessageKey(for:)))
        let filtered = olderMessages.filter { message in
            if let itemID = Self.normalizedHistoryIdentifier(message.itemId),
               existingItemIDs.contains(itemID) {
                return false
            }
            return !existingMessageKeys.contains(Self.historyMessageKey(for: message))
        }

        guard let firstExistingOrder = existingMessages.map(\.orderIndex).min() else {
            return filtered
        }

        var ordered = filtered
        let startOrder = firstExistingOrder - ordered.count
        for index in ordered.indices {
            ordered[index].orderIndex = startOrder + index
        }
        return ordered
    }

    private func updateOlderThreadHistoryCursor(threadId: String, cursor: JSONValue) {
        if cursorHasValue(cursor) {
            exhaustedOlderThreadHistoryCursorByThreadID.removeValue(forKey: threadId)
            olderThreadHistoryCursorByThreadID[threadId] = cursor
            persistThreadHistoryPaginationState()
        } else {
            clearOlderThreadHistoryCursor(threadId: threadId)
        }
    }

    // A nil cursor on an older-page response is authoritative: the server says there is no earlier page.
    private func updateOlderCursorOrMarkStart(threadId: String, nextCursor: JSONValue, currentCursor: JSONValue? = nil) {
        if cursorHasValue(nextCursor) {
            if let currentCursor, nextCursor == currentCursor {
                markOlderThreadHistoryCursorExhausted(threadId: threadId, cursor: currentCursor)
                return
            }
            updateOlderThreadHistoryCursor(threadId: threadId, cursor: nextCursor)
        } else {
            markThreadLocalHistoryStartAuthoritative(threadId, clearRemoteCursor: true)
        }
    }

    // Duplicate or empty pages must still make forward progress; an unchanged cursor would loop forever.
    private func finishOlderPageWithoutNewRows(threadId: String, nextCursor: JSONValue, currentCursor: JSONValue) {
        updateOlderCursorOrMarkStart(
            threadId: threadId,
            nextCursor: nextCursor,
            currentCursor: currentCursor
        )
    }

    private func markOlderThreadHistoryCursorExhausted(threadId: String, cursor: JSONValue) {
        olderThreadHistoryCursorByThreadID.removeValue(forKey: threadId)
        olderHistoryLoadErrorByThreadID.removeValue(forKey: threadId)
        exhaustedOlderThreadHistoryCursorByThreadID[threadId] = cursor
        persistThreadHistoryPaginationState()
    }
}
