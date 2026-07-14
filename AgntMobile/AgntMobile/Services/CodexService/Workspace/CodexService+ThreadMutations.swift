// FILE: CodexService+ThreadMutations.swift
// Purpose: User-driven thread archive, delete, rename, and subtree mutation APIs.
// Layer: Service

import Foundation

extension CodexService {
    func archiveThread(_ threadId: String) {
        let subtreeThreadIDs = collectSubtreeThreadIDs(for: threadId)
        for subtreeThreadID in subtreeThreadIDs {
            setThreadArchivedLocally(subtreeThreadID, isArchived: true)
        }

        debugSyncLog("thread archived by user: \(threadId) (cascaded \(max(0, subtreeThreadIDs.count - 1)) children)")
        sendThreadArchiveRPC(threadId: threadId, unarchive: false)
    }

    // Archives every active thread in a sidebar project group so the folder disappears from the live list.
    func archiveThreadGroup(threadIDs: [String]) -> [String] {
        let rootThreadIDs = collectRootThreadIDs(from: threadIDs)
        for threadID in rootThreadIDs {
            archiveThread(threadID)
        }

        debugSyncLog("thread group archived by user: roots=\(rootThreadIDs.count)")
        return rootThreadIDs
    }

    func unarchiveThread(_ threadId: String) {
        let subtreeThreadIDs = collectSubtreeThreadIDs(for: threadId)
        for subtreeThreadID in subtreeThreadIDs {
            setThreadArchivedLocally(subtreeThreadID, isArchived: false)
        }

        debugSyncLog("thread unarchived by user: \(threadId) (cascaded \(max(0, subtreeThreadIDs.count - 1)) children)")
        sendThreadArchiveRPC(threadId: threadId, unarchive: true)
    }

    func deleteThread(_ threadId: String) {
        // Child threads still exist as standalone server conversations, so deleting a parent
        // should archive descendants locally instead of permanently hiding them as deleted.
        let descendants = collectDescendantThreadIDs(for: threadId)
        for childId in descendants {
            setThreadArchivedLocally(childId, isArchived: true)
        }

        removeThreadLocally(threadId, persistAsDeleted: true)
        debugSyncLog("thread deleted by user: \(threadId) (cascaded \(descendants.count) children)")
        sendThreadArchiveRPC(threadId: threadId, unarchive: false)
    }

    func deleteThreadLocally(_ threadId: String) {
        // Match deleteThread's local behavior without mutating the paired desktop runtime.
        let descendants = collectDescendantThreadIDs(for: threadId)
        for childId in descendants {
            setThreadArchivedLocally(childId, isArchived: true)
        }

        removeThreadLocally(threadId, persistAsDeleted: true)
        debugSyncLog("thread deleted locally by user: \(threadId) (cascaded \(descendants.count) children)")
    }

    func renameThread(_ threadId: String, name: String) {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        // Optimistic local update.
        if let index = threadIndex(for: threadId) {
            threads[index].name = trimmedName
            threads[index].title = trimmedName
        }
        persistThreadRename(trimmedName, for: threadId)
        debugSyncLog("thread renamed by user: \(threadId) → \(trimmedName)")
        sendThreadNameSetRPC(threadId: threadId, name: trimmedName)
    }

    // Applies an automatic first-turn title only while the current title still matches the expected seed.
    @discardableResult
    func applyAutomaticThreadTitle(
        _ title: String,
        for threadId: String,
        replacing allowedCurrentTitles: Set<String>
    ) -> Bool {
        let trimmedName = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty,
              let index = threadIndex(for: threadId) else {
            return false
        }

        let currentName = threads[index].name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentTitle = threads[index].title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentDisplayTitle = threads[index].displayTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let persistedName = persistedThreadRename(for: threadId)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedAllowed = Set(allowedCurrentTitles.map(Self.normalizedAutomaticTitleComparisonValue))

        let currentCandidates = [persistedName, currentName, currentTitle, currentDisplayTitle]
            .compactMap { $0 }
            .map(Self.normalizedAutomaticTitleComparisonValue)
            .filter { !$0.isEmpty }
        let defaultTitle = Self.normalizedAutomaticTitleComparisonValue(CodexThread.defaultDisplayTitle)
        let legacyTitle = Self.normalizedAutomaticTitleComparisonValue("Conversation")
        let canReplace = currentCandidates.isEmpty
            || currentCandidates.allSatisfy { candidate in
                normalizedAllowed.contains(candidate)
                    || candidate == defaultTitle
                    || candidate == legacyTitle
            }

        guard canReplace else {
            debugSyncLog("automatic thread title skipped after user rename: \(threadId)")
            return false
        }

        threads[index].name = trimmedName
        threads[index].title = trimmedName
        persistThreadRename(trimmedName, for: threadId)
        debugSyncLog("thread renamed automatically: \(threadId) → \(trimmedName)")
        sendThreadNameSetRPC(threadId: threadId, name: trimmedName)
        return true
    }

    private static func normalizedAutomaticTitleComparisonValue(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func sendThreadNameSetRPC(threadId: String, name: String) {
        guard isConnected, webSocketConnection != nil || webSocketTask != nil else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await self.sendRequest(
                    method: "thread/name/set",
                    params: .object([
                        "thread_id": .string(threadId),
                        "name": .string(name),
                    ])
                )
                self.debugSyncLog("thread/name/set RPC success: \(threadId)")
            } catch {
                self.debugSyncLog("thread/name/set RPC failed (non-fatal): \(error.localizedDescription)")
            }
        }
    }

    // Removes every thread in a sidebar group without issuing per-thread RPC mutations.
    func deleteLocalThreadGroup(threadIDs: [String]) -> [String] {
        let rootThreadIDs = collectRootThreadIDs(from: threadIDs)
        let subtreeThreadIDs = rootThreadIDs.flatMap { collectSubtreeThreadIDs(for: $0) }
        for threadID in Array(Set(subtreeThreadIDs)).sorted() {
            removeThreadLocally(threadID, persistAsDeleted: true)
        }

        debugSyncLog("thread group deleted locally: roots=\(rootThreadIDs.count)")
        return rootThreadIDs
    }

    /// BFS over `parentThreadId` links to collect all transitive child thread IDs.
    /// Uses a visited set to guard against hypothetical circular references.
    private func collectDescendantThreadIDs(for parentId: String) -> [String] {
        var queue = [parentId]
        var visited = Set<String>()
        var descendants: [String] = []
        while !queue.isEmpty {
            let current = queue.removeFirst()
            for thread in threads where thread.parentThreadId == current && !visited.contains(thread.id) {
                visited.insert(thread.id)
                descendants.append(thread.id)
                queue.append(thread.id)
            }
        }
        return descendants
    }

    // Applies archive state consistently across parent/child subtrees without duplicating row-state cleanup.
    private func setThreadArchivedLocally(_ threadId: String, isArchived: Bool) {
        clearRunningState(for: threadId)
        removeThreadTimelineState(for: threadId)
        clearOutcomeBadge(for: threadId)

        if let index = threadIndex(for: threadId) {
            threads[index].syncState = isArchived ? .archivedLocal : .live
        }

        hydratedThreadIDs.remove(threadId)
        resumedThreadIDs.remove(threadId)

        if let turnId = activeTurnID(for: threadId) {
            setActiveTurnID(nil, for: threadId)
            threadIdByTurnID.removeValue(forKey: turnId)
            if activeTurnId == turnId { activeTurnId = nil }
        }
        threadIdByTurnID = threadIdByTurnID.filter { $0.value != threadId }

        if isArchived {
            addLocallyArchivedThreadID(threadId)
            if pinnedThreadIDs.contains(threadId) {
                unpinThread(threadId)
            }
        } else {
            removeLocallyArchivedThreadID(threadId)
        }
    }

    // Returns the root thread plus all descendants so subtree operations can stay deterministic.
    private func collectSubtreeThreadIDs(for rootId: String) -> [String] {
        [rootId] + collectDescendantThreadIDs(for: rootId)
    }

    // Filters project/group selections down to roots so subtree operations do not double-process descendants.
    private func collectRootThreadIDs(from threadIDs: [String]) -> [String] {
        let uniqueThreadIDs = Array(Set(threadIDs))
        let threadIDSet = Set(uniqueThreadIDs)

        return uniqueThreadIDs
            .filter { threadId in
                guard let parentThreadId = thread(for: threadId)?.parentThreadId else {
                    return true
                }
                return !threadIDSet.contains(parentThreadId)
            }
            .sorted()
    }

    // Centralizes local-only thread cleanup so repo-group deletion can reuse it safely.
    private func removeThreadLocally(_ threadId: String, persistAsDeleted: Bool, persistMessages: Bool = true) {
        clearRunningState(for: threadId)
        removeThreadTimelineState(for: threadId)
        clearOutcomeBadge(for: threadId)
        persistThreadRename(nil, for: threadId)

        // Drop local-only runtime overrides once a chat is fully removed from the device.
        clearThreadReasoningEffortOverride(for: threadId)
        clearThreadServiceTierOverride(for: threadId)

        threads.removeAll { $0.id == threadId }
        messagesByThread.removeValue(forKey: threadId)
        if persistMessages {
            persistCurrentMacMessages()
        }

        hydratedThreadIDs.remove(threadId)
        loadingThreadIDs.remove(threadId)
        resumedThreadIDs.remove(threadId)
        streamingSystemMessageByItemID = streamingSystemMessageByItemID.filter { key, _ in
            !key.hasPrefix("\(threadId)|item:")
        }

        if let turnId = activeTurnID(for: threadId) {
            setActiveTurnID(nil, for: threadId)
            threadIdByTurnID.removeValue(forKey: turnId)
            if activeTurnId == turnId { activeTurnId = nil }
        }
        threadIdByTurnID = threadIdByTurnID.filter { $0.value != threadId }

        if activeThreadId == threadId { activeThreadId = nil }

        removeLocallyArchivedThreadID(threadId)
        if pinnedThreadIDs.contains(threadId) {
            unpinThread(threadId)
        }
        if persistAsDeleted {
            addLocallyDeletedThreadID(threadId)
        }
    }
}
