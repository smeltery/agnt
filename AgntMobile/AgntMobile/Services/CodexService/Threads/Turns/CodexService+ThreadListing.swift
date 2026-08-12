// FILE: CodexService+ThreadListing.swift
// Purpose: Thread list fetch and pagination helpers.
// Layer: Service

import Foundation

extension CodexService {
    // Reuses an in-flight thread/list request for matching caps so launch sync and sidebar refresh share one RPC.
    func fetchCoalescedServerThreads(limit: Int, archived: Bool = false) async throws -> [CodexThread] {
        let key = "\(archived ? "archived" : "active"):\(limit)"
        if let existingFetch = threadListFetchTaskByLimit[key] {
            return try await existingFetch.task.value
        }

        let fetchID = UUID()
        let task = Task { @MainActor in
            defer {
                if threadListFetchTaskByLimit[key]?.id == fetchID {
                    threadListFetchTaskByLimit[key] = nil
                }
            }
            return try await fetchServerThreads(limit: limit, archived: archived)
        }
        threadListFetchTaskByLimit[key] = (id: fetchID, task: task)

        return try await task.value
    }

    func fetchServerThreads(
        limit: Int? = nil,
        archived: Bool = false,
        onPage: ((_ page: [CodexThread], _ accumulatedThreads: [CodexThread]) -> Void)? = nil
    ) async throws -> [CodexThread] {
        var allThreads: [CodexThread] = []
        var nextCursor: JSONValue = .null
        var hasRequestedFirstPage = false

        repeat {
            var params: RPCObject = [
                // Avoid the server's narrower default sourceKinds so multi-project history
                // includes threads started from the app-server flow as well.
                "sourceKinds": .array(threadListSourceKinds.map(JSONValue.string)),
                // The app-server defaults to created_at, which can exclude an old thread
                // with recent activity from this capped sidebar window.
                "sortKey": .string("updated_at"),
                "cursor": nextCursor,
            ]
            if let limit {
                params["limit"] = .integer(limit)
            }
            if archived {
                params["archived"] = .bool(true)
            }

            let response = try await sendRequest(method: "thread/list", params: .object(params))

            guard let resultObject = response.result?.objectValue else {
                throw CodexServiceError.invalidResponse("thread/list response missing payload")
            }

            let page =
                resultObject["data"]?.arrayValue
                ?? resultObject["items"]?.arrayValue
                ?? resultObject["threads"]?.arrayValue
            guard let page else {
                throw CodexServiceError.invalidResponse("thread/list response missing data array")
            }

            let decodedPage = page.compactMap { decodeModel(CodexThread.self, from: $0) }
            allThreads.append(contentsOf: decodedPage)
            onPage?(decodedPage, allThreads)
            nextCursor = nextThreadListCursor(from: resultObject)
            hasRequestedFirstPage = true
        } while shouldContinueThreadListPagination(
            nextCursor: nextCursor,
            limit: limit,
            hasRequestedFirstPage: hasRequestedFirstPage
        )

        return allThreads
    }

    // Requests all user-facing thread sources instead of relying on the server default.
    private var threadListSourceKinds: [String] {
        [
            "cli",
            "vscode",
            "appServer",
            "exec",
            "unknown",
        ]
    }

    // Accepts both modern and legacy cursor field names from thread/list responses.
    private func nextThreadListCursor(from resultObject: RPCObject) -> JSONValue {
        if let nextCursor = resultObject["nextCursor"] {
            return nextCursor
        }
        if let nextCursor = resultObject["next_cursor"] {
            return nextCursor
        }
        return .null
    }

    // Paginates until the server reports no cursor or the caller requested a capped page.
    private func shouldContinueThreadListPagination(
        nextCursor: JSONValue,
        limit: Int?,
        hasRequestedFirstPage: Bool
    ) -> Bool {
        guard hasRequestedFirstPage, limit == nil else {
            return false
        }

        switch nextCursor {
        case .null:
            return false
        case let .string(value):
            return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default:
            return true
        }
    }
}
