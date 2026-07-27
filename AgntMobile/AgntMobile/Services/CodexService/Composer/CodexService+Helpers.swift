// FILE: CodexService+Helpers.swift
// Purpose: Shared utility helpers for model decoding and thread bookkeeping.
// Layer: Service
// Exports: CodexService helpers
// Depends on: Foundation

import Foundation

extension CodexService {
    // Rebuilds service-owned thread lookup caches whenever the sorted thread list changes.
    func rebuildThreadLookupCaches() {
        threadByID = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0) })
        threadIndexByID = Dictionary(
            uniqueKeysWithValues: threads.enumerated().map { index, thread in
                (thread.id, index)
            }
        )
        firstLiveThreadIDCache = threads.first(where: { $0.syncState == .live })?.id
        refreshSubagentIdentityDirectoryFromThreads()
    }

    // Shared O(1) thread lookup for hot paths that only need thread metadata.
    func thread(for threadId: String) -> CodexThread? {
        threadByID[threadId]
    }

    // Shared O(1) index lookup for thread mutations that stay inside the main array.
    func threadIndex(for threadId: String) -> Int? {
        threadIndexByID[threadId]
    }

    // Keeps the default "open the latest live conversation" lookup out of repeated array scans.
    func firstLiveThreadID() -> String? {
        firstLiveThreadIDCache
    }

    func resolveThreadID(_ preferredThreadID: String?) async throws -> String {
        if let preferredThreadID, !preferredThreadID.isEmpty {
            return preferredThreadID
        }

        if let activeThreadId, !activeThreadId.isEmpty {
            return activeThreadId
        }

        let newThread = try await startThread()
        return newThread.id
    }

    func upsertThread(_ incomingThread: CodexThread, treatAsServerState: Bool = false) {
        let existingThread = self.thread(for: incomingThread.id)
        var resolvedThread = mergedThread(
            incomingThread,
            with: existingThread,
            treatAsServerState: treatAsServerState
        )
        if resolvedThread.forkedFromThreadId == nil {
            resolvedThread.forkedFromThreadId = persistedForkOrigin(for: resolvedThread.id)
        }
        applyPersistedThreadRename(to: &resolvedThread)
        rememberForkOriginIfNeeded(sourceThreadId: resolvedThread.forkedFromThreadId, forkedThreadId: resolvedThread.id)
        let derivedIdentity = resolvedThread.derivedSubagentIdentity
        upsertSubagentIdentity(
            threadId: resolvedThread.id,
            agentId: resolvedThread.agentId,
            nickname: resolvedThread.agentNickname ?? derivedIdentity?.nickname,
            role: resolvedThread.agentRole ?? derivedIdentity?.role
        )

        if let existingIndex = threadIndex(for: incomingThread.id) {
            threads[existingIndex] = resolvedThread
        } else {
            threads.append(resolvedThread)
        }

        threads = sortThreads(threads)

        if shouldRefreshDeferredHydrationForServerUpdate(
            incomingThread: resolvedThread,
            existingThread: existingThread,
            treatAsServerState: treatAsServerState
        ) {
            markThreadNeedingCanonicalHistoryReconcile(
                resolvedThread.id,
                requestImmediateSync: activeThreadId == resolvedThread.id
            )
        }
    }

    // Preserves locally discovered child-thread identity while newer server payloads trickle in.
    func mergedThread(
        _ incoming: CodexThread,
        with existing: CodexThread?,
        treatAsServerState: Bool = false
    ) -> CodexThread {
        guard let existing else {
            return applyingAuthoritativeProjectPath(
                to: incoming,
                treatAsServerState: treatAsServerState
            )
        }

        var merged = incoming
        if merged.title == nil { merged.title = existing.title }
        if merged.name == nil { merged.name = existing.name }
        if merged.preview == nil { merged.preview = existing.preview }
        if merged.createdAt == nil { merged.createdAt = existing.createdAt }
        if merged.updatedAt == nil { merged.updatedAt = existing.updatedAt }
        if merged.cwd == nil { merged.cwd = existing.normalizedProjectPath }
        if merged.worktreeOriginPath == nil { merged.worktreeOriginPath = existing.normalizedWorktreeOriginPath }
        merged.metadata = mergedThreadMetadata(
            serverMetadata: merged.metadata,
            localMetadata: existing.metadata
        )
        if merged.forkedFromThreadId == nil { merged.forkedFromThreadId = existing.forkedFromThreadId }
        if merged.threadSource == nil { merged.threadSource = existing.threadSource }
        if merged.parentThreadId == nil { merged.parentThreadId = existing.parentThreadId }
        if merged.agentId == nil { merged.agentId = existing.agentId }
        if merged.agentNickname == nil { merged.agentNickname = existing.agentNickname }
        if merged.agentRole == nil { merged.agentRole = existing.agentRole }
        if merged.model == nil { merged.model = existing.model }
        if merged.modelProvider == nil { merged.modelProvider = existing.modelProvider }
        return applyingAuthoritativeProjectPath(
            to: merged,
            treatAsServerState: treatAsServerState
        )
    }

    // Persists fork ancestry outside transient thread payloads so sidebar badges survive reconnects.
    func rememberForkOriginIfNeeded(sourceThreadId: String?, forkedThreadId: String) {
        guard let normalizedSourceThreadId = normalizedForkThreadID(sourceThreadId),
              let normalizedForkedThreadId = normalizedForkThreadID(forkedThreadId) else {
            return
        }

        guard forkedFromThreadIDByThreadID[normalizedForkedThreadId] != normalizedSourceThreadId else {
            return
        }

        forkedFromThreadIDByThreadID[normalizedForkedThreadId] = normalizedSourceThreadId
        persistForkOrigins()
    }

    func persistedForkOrigin(for threadId: String?) -> String? {
        guard let normalizedThreadId = normalizedForkThreadID(threadId) else {
            return nil
        }

        return normalizedForkThreadID(forkedFromThreadIDByThreadID[normalizedThreadId])
    }

    private func persistForkOrigins() {
        guard let encoded = try? encoder.encode(forkedFromThreadIDByThreadID) else {
            return
        }

        defaults.set(encoded, forKey: macScopedDefaultsKey(Self.forkedThreadOriginsDefaultsKey))
    }

    // Re-arms one canonical refresh when thread/list shows newer server metadata for a large active chat.
    func shouldRefreshDeferredHydrationForServerUpdate(
        incomingThread: CodexThread,
        existingThread: CodexThread?,
        treatAsServerState: Bool
    ) -> Bool {
        guard treatAsServerState,
              activeThreadId == incomingThread.id,
              threadsWithSatisfiedDeferredHistoryHydration.contains(incomingThread.id),
              shouldDeferHeavyDisplayHydration(threadId: incomingThread.id),
              let existingThread else {
            return false
        }

        if let incomingUpdatedAt = incomingThread.updatedAt,
           let existingUpdatedAt = existingThread.updatedAt,
           incomingUpdatedAt > existingUpdatedAt {
            return true
        }

        if existingThread.preview != incomingThread.preview,
           incomingThread.preview?.isEmpty == false {
            return true
        }

        return false
    }

    // Keeps user-renamed thread titles durable even when thread/list returns only the server fallback title.
    func persistThreadRename(_ name: String?, for threadId: String) {
        guard let normalizedThreadId = normalizedForkThreadID(threadId) else {
            return
        }

        let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmedName.isEmpty {
            renamedThreadNameByThreadID.removeValue(forKey: normalizedThreadId)
        } else {
            renamedThreadNameByThreadID[normalizedThreadId] = trimmedName
        }

        guard let encoded = try? encoder.encode(renamedThreadNameByThreadID) else {
            return
        }

        defaults.set(encoded, forKey: macScopedDefaultsKey(Self.renamedThreadNamesDefaultsKey))
    }

    func persistedThreadRename(for threadId: String?) -> String? {
        guard let normalizedThreadId = normalizedForkThreadID(threadId) else {
            return nil
        }

        return normalizedPersistedThreadName(renamedThreadNameByThreadID[normalizedThreadId])
    }

    private func applyPersistedThreadRename(to thread: inout CodexThread) {
        guard let persistedName = persistedThreadRename(for: thread.id) else {
            return
        }

        thread.name = persistedName
        thread.title = persistedName
    }


    func normalizedForkThreadID(_ value: String?) -> String? {
        guard let value else {
            return nil
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func normalizedPersistedThreadName(_ value: String?) -> String? {
        guard let value else {
            return nil
        }

        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func sortThreads(_ value: [CodexThread]) -> [CodexThread] {
        value.sorted { lhs, rhs in
            let lhsDate = lhs.updatedAt ?? lhs.createdAt ?? Date.distantPast
            let rhsDate = rhs.updatedAt ?? rhs.createdAt ?? Date.distantPast
            return lhsDate > rhsDate
        }
    }

    func decodeModel<T: Decodable>(_ type: T.Type, from value: JSONValue) -> T? {
        guard let data = try? encoder.encode(value) else {
            return nil
        }

        return try? decoder.decode(type, from: data)
    }

    func extractTurnID(from value: JSONValue?) -> String? {
        guard let object = value?.objectValue else {
            return nil
        }

        if let turnId = object["turn"]?.objectValue?["id"]?.stringValue {
            return turnId
        }
        if let turnId = object["turnId"]?.stringValue {
            return turnId
        }
        if let turnId = object["turn_id"]?.stringValue {
            return turnId
        }

        guard let fallbackId = object["id"]?.stringValue else {
            return nil
        }

        // Avoid misclassifying item payload ids as turn ids.
        let looksLikeItemPayload = object["type"] != nil
            || object["item"] != nil
            || object["content"] != nil
            || object["output"] != nil
        if looksLikeItemPayload {
            return nil
        }

        return fallbackId
    }

}
