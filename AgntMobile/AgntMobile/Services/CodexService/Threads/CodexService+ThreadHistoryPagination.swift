// FILE: CodexService+ThreadHistoryPagination.swift
// Purpose: Owns paginated thread history fetch, cursor state, and older-message reveal helpers.
// Layer: Service extension
// Exports: CodexService thread history pagination APIs
// Depends on: CodexService transport, CodexMessage history merge helpers, JSONValue

import Foundation

enum TurnTimelineProjectionPolicy {
    // Long chats can contain thousands of persisted rows. Reveal them through a bounded
    // render window while remote turn pages extend the backing cache as needed.
    static let initialMessageLimit = 80
    static let messagePageSize = 40
    static let eagerHydrationMessageLimit = 400
}

enum ThreadHistoryHydrationPolicy {
    // Huge desktop transcripts can make thread/read stall before the bridge can compact the payload.
    // Match Litter's cursor-driven paging: hydrate a tiny recent window, then prepend on demand.
    static let requestTimeoutNanoseconds: UInt64 = 30_000_000_000
    static let initialPageSoftTimeoutNanoseconds: UInt64 = 8_000_000_000
    static let initialTurnPageSize = 20
    static let olderTurnPageSize = 5
    static let duplicateOlderPageSkipLimit = 12
}

struct ThreadTurnsHistoryPage {
    let turns: [JSONValue]
    let nextCursor: JSONValue
    let isProvisionalJsonlFallback: Bool
}

extension CodexService {
    // Fetches one cursor page from Codex app-server and keeps the response shape tolerant.
    func fetchThreadTurnsHistoryPage(
        threadId: String,
        limit: Int,
        cursor: JSONValue?,
        timeoutNanoseconds: UInt64,
        requireCanonical: Bool = false
    ) async throws -> ThreadTurnsHistoryPage {
        var params: RPCObject = [
            "threadId": .string(threadId),
            "limit": .integer(limit),
            "sortDirection": .string("desc"),
        ]
        if let cursor, cursorHasValue(cursor) {
            params["cursor"] = cursor
        }
        if requireCanonical {
            params["agntRequireCanonical"] = .bool(true)
        }

        let response = try await sendRequest(
            method: "thread/turns/list",
            params: .object(params),
            timeoutNanoseconds: timeoutNanoseconds
        )

        guard let resultObject = response.result?.objectValue else {
            throw CodexServiceError.invalidResponse("thread/turns/list response missing payload")
        }
        let turns =
            resultObject["data"]?.arrayValue
            ?? resultObject["items"]?.arrayValue
            ?? resultObject["turns"]?.arrayValue
        guard let turns else {
            throw CodexServiceError.invalidResponse("thread/turns/list response missing data array")
        }

        return ThreadTurnsHistoryPage(
            turns: turns,
            nextCursor: threadTurnsListCursor(from: resultObject),
            isProvisionalJsonlFallback: resultObject["agntJsonlFallback"]?.boolValue == true
        )
    }

    // Starts with Litter-sized pages so long chats always expose older history through a real cursor.
    func fetchInitialThreadTurnsHistoryPage(
        threadId: String,
        requireCanonical: Bool = false
    ) async throws -> ThreadTurnsHistoryPage {
        let startedAt = Date()
        let page = try await fetchThreadTurnsHistoryPage(
            threadId: threadId,
            limit: ThreadHistoryHydrationPolicy.initialTurnPageSize,
            cursor: nil,
            timeoutNanoseconds: ThreadHistoryHydrationPolicy.initialPageSoftTimeoutNanoseconds,
            requireCanonical: requireCanonical
        )
        let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        debugSyncLog("thread/turns/list initial thread=\(threadId) limit=\(ThreadHistoryHydrationPolicy.initialTurnPageSize) turns=\(page.turns.count) provisional=\(page.isProvisionalJsonlFallback) hasNextCursor=\(cursorHasValue(page.nextCursor)) elapsedMs=\(elapsedMs)")
        return page
    }

    // Legacy fallback for old runtimes that cannot page turns; still bounded by the chat-open timeout.
    func fetchLegacyThreadHistoryObject(threadId: String) async throws -> RPCObject {
        let response = try await sendRequest(
            method: "thread/read",
            params: .object([
                "threadId": .string(threadId),
                "includeTurns": .bool(true),
            ]),
            timeoutNanoseconds: ThreadHistoryHydrationPolicy.requestTimeoutNanoseconds
        )

        guard let threadObject = response.result?.objectValue?["thread"]?.objectValue else {
            throw CodexServiceError.invalidResponse("thread/read response missing thread payload")
        }
        return threadObject
    }

    // Exposed to the turn screen when either local projection or server cursor can reveal older rows.
    func canLoadOlderThreadHistory(threadId: String) -> Bool {
        (hasRemoteOlderThreadHistoryCursor(threadId: threadId)
            && !hasKnownLocalHistoryStart(threadId: threadId))
            || hasLocallyProjectedEarlierThreadHistory(threadId: threadId)
    }

    func hasRemoteOlderThreadHistoryCursor(threadId: String) -> Bool {
        cursorHasValue(olderThreadHistoryCursorByThreadID[threadId])
    }

    func hasAuthoritativeLocalHistoryStart(threadId: String) -> Bool {
        threadsWithAuthoritativeLocalHistoryStart.contains(threadId)
    }

    func hasKnownLocalHistoryStart(threadId: String) -> Bool {
        hasAuthoritativeLocalHistoryStart(threadId: threadId)
    }

    // Call only when the source proves the local cache includes the first turn.
    func markThreadLocalHistoryStartAuthoritative(_ threadId: String, clearRemoteCursor: Bool = false) {
        threadsWithAuthoritativeLocalHistoryStart.insert(threadId)
        exhaustedOlderThreadHistoryCursorByThreadID.removeValue(forKey: threadId)
        if clearRemoteCursor {
            clearOlderThreadHistoryCursor(threadId: threadId, persistState: false)
        }
        persistThreadHistoryPaginationState()
    }

    func isLoadingOlderThreadHistory(threadId: String) -> Bool {
        loadingOlderThreadHistoryIDs.contains(threadId)
    }

    // Treats resume metadata and first-turn hydration as separate milestones.
    func hasSatisfiedInitialThreadHistoryLoad(threadId: String) -> Bool {
        !supportsTurnPagination || initialTurnsLoadedByThreadID.contains(threadId)
    }

    func hasLocallyProjectedEarlierThreadHistory(threadId: String) -> Bool {
        let currentLimit = threadTimelineProjectionLimitByThreadID[threadId]
            ?? TurnTimelineProjectionPolicy.initialMessageLimit
        return (messagesByThread[threadId]?.count ?? 0) > currentLimit
    }

    // Expands the render snapshot window whenever the user asks to reveal older rows.
    func noteThreadHistoryRevealRequested(threadId: String, pageSize: Int) {
        let normalizedPageSize = max(1, pageSize)
        let currentLimit = threadTimelineProjectionLimitByThreadID[threadId]
            ?? TurnTimelineProjectionPolicy.initialMessageLimit
        let nextLimit = currentLimit + normalizedPageSize
        let totalMessages = messagesByThread[threadId]?.count ?? 0
        guard totalMessages > currentLimit else {
            if totalMessages > 0,
               hasKnownLocalHistoryStart(threadId: threadId)
                || localCacheStartsAtThreadCreation(
                    threadId: threadId,
                    existingMessages: messagesByThread[threadId] ?? []
                ) {
                markThreadLocalHistoryStartAuthoritative(threadId, clearRemoteCursor: true)
                debugSyncLog("thread history local start reached thread=\(threadId) limit=\(currentLimit) total=\(totalMessages); hiding older button")
            } else {
                debugSyncLog("thread history local reveal skipped thread=\(threadId) limit=\(currentLimit) total=\(totalMessages)")
            }
            refreshThreadTimelineState(for: threadId)
            return
        }
        threadTimelineProjectionLimitByThreadID[threadId] = nextLimit
        olderHistoryLoadErrorByThreadID.removeValue(forKey: threadId)
        if nextLimit >= totalMessages {
            if hasKnownLocalHistoryStart(threadId: threadId)
                || localCacheStartsAtThreadCreation(
                    threadId: threadId,
                    existingMessages: messagesByThread[threadId] ?? []
                ) {
                markThreadLocalHistoryStartAuthoritative(threadId, clearRemoteCursor: true)
                debugSyncLog("thread history local start reached thread=\(threadId) limit=\(nextLimit) total=\(totalMessages); hiding older button")
            }
        }
        debugSyncLog("thread history local reveal thread=\(threadId) fromLimit=\(currentLimit) toLimit=\(nextLimit) total=\(totalMessages)")

        if totalMessages > currentLimit {
            noteMessagesChanged(for: threadId)
            refreshThreadTimelineState(for: threadId)
        }
    }

    func noteThreadHistoryRevealRequested(threadId: String) {
        noteThreadHistoryRevealRequested(
            threadId: threadId,
            pageSize: TurnTimelineProjectionPolicy.messagePageSize
        )
    }

    // Rolls back an optimistic remote reveal when the server page did not arrive.
    func noteThreadHistoryRemoteRevealFailed(threadId: String) {
        let loadedCount = messagesByThread[threadId]?.count ?? 0
        let currentLimit = threadTimelineProjectionLimitByThreadID[threadId]
            ?? TurnTimelineProjectionPolicy.initialMessageLimit
        guard currentLimit > loadedCount else {
            return
        }

        threadTimelineProjectionLimitByThreadID[threadId] = max(
            TurnTimelineProjectionPolicy.initialMessageLimit,
            loadedCount
        )
        noteMessagesChanged(for: threadId)
        refreshThreadTimelineState(for: threadId)
    }

    // Fails open after a chat-load timeout but leaves a retryable reconcile trail behind.
    func markThreadHistoryDeferredAfterTimeout(threadId: String) {
        markThreadHistoryDeferred(
            threadId: threadId,
            activeErrorMessage: "Couldn't load this chat yet. Retrying in the background."
        )
    }

    // Empty first pages are suspicious for existing chats; keep retrying until
    // the bridge returns authoritative history or the thread is proven blank.
    func markThreadHistoryDeferredAfterEmptyPage(threadId: String) {
        markThreadHistoryDeferred(
            threadId: threadId,
            activeErrorMessage: "Couldn't verify this chat's history yet. Retrying in the background."
        )
    }

    func markThreadHistoryDeferredAfterUnavailablePage(threadId: String) {
        markThreadHistoryDeferred(
            threadId: threadId,
            activeErrorMessage: "Couldn't retrieve this chat's history yet. Retrying in the background."
        )
    }

    private func markThreadHistoryDeferred(threadId: String, activeErrorMessage: String) {
        let hasCachedMessages = !(messagesByThread[threadId]?.isEmpty ?? true)
        if hasCachedMessages {
            hydratedThreadIDs.insert(threadId)
            initialTurnsLoadedByThreadID.insert(threadId)
        }
        if activeThreadId == threadId, !hasCachedMessages {
            lastErrorMessage = activeErrorMessage
        } else {
            olderHistoryLoadErrorByThreadID[threadId] = "Couldn't load earlier messages. Tap to retry."
        }
        markThreadNeedingCanonicalHistoryReconcile(threadId)
        refreshThreadTimelineState(for: threadId)
    }

    func clearDeferredThreadHistoryErrorIfNeeded(threadId: String) {
        olderHistoryLoadErrorByThreadID.removeValue(forKey: threadId)
        if activeThreadId == threadId,
           lastErrorMessage?.hasSuffix("Retrying in the background.") == true {
            lastErrorMessage = nil
        }
    }

    // Embedded legacy snapshots may contain full history; render only the first window, then reveal locally.
    func updateThreadTimelineProjectionForEmbeddedHistory(threadId: String, decodedMessageCount: Int) {
        threadTimelineProjectionLimitByThreadID[threadId] = max(
            threadTimelineProjectionLimitByThreadID[threadId] ?? 0,
            TurnTimelineProjectionPolicy.initialMessageLimit
        )
    }

    // First paginated pages can be larger than the default render window when a turn has many items.
    func seedThreadTimelineProjectionForPaginatedHistory(threadId: String, decodedMessageCount: Int) {
        threadTimelineProjectionLimitByThreadID[threadId] = max(
            threadTimelineProjectionLimitByThreadID[threadId] ?? 0,
            TurnTimelineProjectionPolicy.initialMessageLimit,
            decodedMessageCount
        )
    }

    // Descending pages arrive newest-first; the history decoder expects chronological turn order.
    func chronologicalTurnsFromDescendingPage(_ turns: [JSONValue]) -> [JSONValue] {
        Array(turns.reversed())
    }

    // Accepts both generated app-server field names and older list-style aliases.
    private func threadTurnsListCursor(from resultObject: RPCObject) -> JSONValue {
        if let nextCursor = resultObject["nextCursor"] {
            return nextCursor
        }
        if let nextCursor = resultObject["next_cursor"] {
            return nextCursor
        }
        return .null
    }

    func cursorHasValue(_ cursor: JSONValue?) -> Bool {
        guard let cursor else {
            return false
        }
        switch cursor {
        case .null:
            return false
        case .string(let value):
            return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default:
            return false
        }
    }

    // Persists only cursor and "known start" metadata; the render window itself remains transient UI state.
    func persistThreadHistoryPaginationState() {
        let threadIDs = Set(olderThreadHistoryCursorByThreadID.keys)
            .union(threadsWithAuthoritativeLocalHistoryStart)
            .union(exhaustedOlderThreadHistoryCursorByThreadID.keys)
        let stateByThreadID = threadIDs.reduce(into: [String: CodexThreadHistoryPaginationState]()) { partial, threadId in
            let cursor = olderThreadHistoryCursorByThreadID[threadId]
            let exhaustedCursor = exhaustedOlderThreadHistoryCursorByThreadID[threadId]
            let hasCursor = cursorHasValue(cursor)
            let hasExhaustedCursor = cursorHasValue(exhaustedCursor)
            let hasAuthoritativeStart = threadsWithAuthoritativeLocalHistoryStart.contains(threadId)
            guard hasCursor || hasExhaustedCursor || hasAuthoritativeStart else {
                return
            }
            partial[threadId] = CodexThreadHistoryPaginationState(
                olderCursor: hasCursor ? cursor : nil,
                exhaustedOlderCursor: hasExhaustedCursor ? exhaustedCursor : nil,
                hasAuthoritativeLocalHistoryStart: hasAuthoritativeStart
            )
        }

        guard !stateByThreadID.isEmpty else {
            defaults.removeObject(forKey: Self.threadHistoryPaginationStateDefaultsKey)
            return
        }
        guard let data = try? encoder.encode(stateByThreadID) else {
            return
        }
        defaults.set(data, forKey: Self.threadHistoryPaginationStateDefaultsKey)
    }

    // One-time migration for transcripts saved before cursor-backed history existed.
    func shouldTrustExistingCacheAsPrePaginationFullHistory(
        threadId: String,
        existingMessages: [CodexMessage],
        paginatedMessages: [CodexMessage],
        hadInitialTurnsLoadedBeforeRefresh: Bool,
        hadAuthoritativeLocalStartBeforeRefresh: Bool
    ) -> Bool {
        guard !hadInitialTurnsLoadedBeforeRefresh,
              !hadAuthoritativeLocalStartBeforeRefresh,
              !paginatedMessages.isEmpty,
              existingMessages.count > paginatedMessages.count else {
            return false
        }

        let existingItemIDs = Set(existingMessages.compactMap { Self.normalizedHistoryIdentifier($0.itemId) })
        let existingKeys = Set(existingMessages.map(Self.historyMessageKey(for:)))
        let exactOverlapCount = paginatedMessages.reduce(into: 0) { count, message in
            if let itemID = Self.normalizedHistoryIdentifier(message.itemId),
               existingItemIDs.contains(itemID) {
                count += 1
                return
            }
            if existingKeys.contains(Self.historyMessageKey(for: message)) {
                count += 1
            }
        }
        let localStartsAtThreadCreation = localCacheStartsAtThreadCreation(
            threadId: threadId,
            existingMessages: existingMessages
        )
        let localHasSubstantialPrefix = existingMessages.count >= max(
            TurnTimelineProjectionPolicy.initialMessageLimit,
            paginatedMessages.count * 2
        )

        return localStartsAtThreadCreation
            && localHasSubstantialPrefix
            && exactOverlapCount > 0
    }

    // A persisted cache whose oldest row is at the thread creation time came from a full-history load.
    private func localCacheStartsAtThreadCreation(threadId: String, existingMessages: [CodexMessage]) -> Bool {
        guard let threadCreatedAt = thread(for: threadId)?.createdAt,
              CodexTimestampParser.isTrustworthyServerDate(threadCreatedAt),
              let oldestMessageDate = existingMessages.map(\.createdAt).min(),
              CodexTimestampParser.isTrustworthyServerDate(oldestMessageDate) else {
            return false
        }

        return oldestMessageDate <= threadCreatedAt.addingTimeInterval(180)
    }

    // Recognizes the mobile-side timeout used to avoid permanently blocking chat opening.
    func shouldDeferThreadHistoryAfterTimeout(_ error: CodexServiceError) -> Bool {
        guard case .invalidInput(let message) = error else {
            return false
        }
        return (
            message.localizedCaseInsensitiveContains("thread/read")
                || message.localizedCaseInsensitiveContains("thread/turns/list")
        )
            && message.localizedCaseInsensitiveContains("timed out")
    }

    func shouldDeferThreadHistoryAfterBridgeFailure(_ error: CodexServiceError) -> Bool {
        guard case .rpcError(let rpcError) = error else {
            return false
        }
        return rpcError.data?.objectValue?["errorCode"]?.stringValue == "thread_turns_list_failed"
    }
}
