// FILE: CodexService+ThreadHistoryPagination.swift
// Purpose: Initial-page paginated thread history fetch via thread/turns/list with thread/read fallback.
// Layer: Service extension
// Exports: CodexService thread history pagination helpers
// Depends on: CodexService transport, JSONValue

import Foundation

enum TurnTimelineProjectionPolicy {
    // Long chats can contain thousands of persisted rows. Reveal them through a bounded
    // render window while remote turn pages extend the backing cache as needed.
    static let initialMessageLimit = 80
    static let messagePageSize = 40
}

enum ThreadHistoryHydrationPolicy {
    // Match the bridge's adaptive pager budget: hydrate a tiny recent window then expand on demand.
    static let initialTurnPageSize = 10
}

struct ThreadTurnsHistoryPage {
    let turns: [JSONValue]
    let nextCursor: JSONValue
}

extension CodexService {
    // Fetches one paginated page from the bridge. The bridge's adaptive pager intercepts
    // thread/turns/list and may aggregate multiple Codex pages into one response.
    func fetchInitialThreadTurnsHistoryPage(threadId: String) async throws -> ThreadTurnsHistoryPage {
        let params: RPCObject = [
            "threadId": .string(threadId),
            "limit": .integer(ThreadHistoryHydrationPolicy.initialTurnPageSize),
            "sortDirection": .string("desc"),
        ]
        let response = try await sendRequest(
            method: "thread/turns/list",
            params: .object(params)
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
            nextCursor: threadTurnsListCursor(from: resultObject)
        )
    }

    // Wraps the descending-page response into a thread-shaped object so the existing
    // thread/read decoder (decodeMessagesFromThreadRead) can consume it without changes.
    func threadObjectFromPaginatedHistoryPage(threadId: String, page: ThreadTurnsHistoryPage) -> RPCObject {
        [
            "id": .string(threadId),
            "turns": .array(Array(page.turns.reversed())),
        ]
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
}
