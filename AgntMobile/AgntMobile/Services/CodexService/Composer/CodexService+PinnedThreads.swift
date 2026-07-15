// FILE: CodexService+PinnedThreads.swift
// Purpose: Persists and restores locally pinned thread snapshots.
// Layer: Service extension
// Exports: CodexService pinned thread helpers
// Depends on: Foundation, CodexThread

import Foundation

extension CodexService {
    // Keeps local-only sidebar pins durable across thread/list refreshes and app relaunches.
    func pinThread(_ threadId: String) {
        guard let pinnedRootThreadID = pinnedRootThreadID(for: threadId),
              let snapshotThreads = snapshotThreadsForPinnedRoot(pinnedRootThreadID),
              !snapshotThreads.isEmpty else {
            return
        }

        pinnedThreadIDs.removeAll { $0 == pinnedRootThreadID }
        pinnedThreadIDs.insert(pinnedRootThreadID, at: 0)
        pinnedThreadSnapshotsByRootID[pinnedRootThreadID] = snapshotThreads
        persistPinnedThreadState()
    }

    func unpinThread(_ threadId: String) {
        guard let pinnedRootThreadID = pinnedRootThreadID(for: threadId) ?? normalizedForkThreadID(threadId) else {
            return
        }

        let previousIDs = pinnedThreadIDs
        let hadSnapshot = pinnedThreadSnapshotsByRootID[pinnedRootThreadID] != nil
        pinnedThreadIDs.removeAll { $0 == pinnedRootThreadID }
        pinnedThreadSnapshotsByRootID.removeValue(forKey: pinnedRootThreadID)
        guard pinnedThreadIDs != previousIDs || hadSnapshot else {
            return
        }

        persistPinnedThreadState()
    }

    func isThreadPinned(_ threadId: String?) -> Bool {
        guard let pinnedRootThreadID = pinnedRootThreadID(for: threadId) else {
            return false
        }

        return pinnedThreadIDs.contains(pinnedRootThreadID)
    }

    func isThreadInPinnedSnapshot(_ threadId: String?) -> Bool {
        guard let normalizedThreadId = normalizedForkThreadID(threadId) else {
            return false
        }

        return pinnedThreadSnapshotsByRootID.values.contains { threads in
            threads.contains(where: { $0.id == normalizedThreadId })
        }
    }

    // Keeps pinned snapshots fresh as live thread metadata changes, without depending on server pagination.
    func refreshPinnedThreadSnapshots() {
        guard !pinnedThreadIDs.isEmpty else {
            if !pinnedThreadSnapshotsByRootID.isEmpty {
                pinnedThreadSnapshotsByRootID.removeAll()
                persistPinnedThreadState()
            }
            return
        }

        var nextSnapshots = pinnedThreadSnapshotsByRootID
        var didMutate = false

        for rootThreadID in pinnedThreadIDs {
            if let snapshotThreads = snapshotThreadsForPinnedRoot(rootThreadID),
               !snapshotThreads.isEmpty,
               nextSnapshots[rootThreadID] != snapshotThreads {
                nextSnapshots[rootThreadID] = snapshotThreads
                didMutate = true
            }
        }

        let validRootIDs = Set(pinnedThreadIDs)
        let filteredSnapshots = nextSnapshots.filter { validRootIDs.contains($0.key) }
        if filteredSnapshots != pinnedThreadSnapshotsByRootID || didMutate {
            pinnedThreadSnapshotsByRootID = filteredSnapshots
            persistPinnedThreadState()
        }
    }

    // Restores a locally pinned chat by asking the runtime to resume it when the user opens the row.
    @discardableResult
    func restorePinnedThreadIfNeeded(threadId: String) async throws -> CodexThread? {
        guard snapshotOnlyPinnedThreadIDs.contains(threadId) else {
            return thread(for: threadId)
        }

        let preferredProjectPath = thread(for: threadId)?.gitWorkingDirectory
            ?? snapshotThread(threadId: threadId)?.gitWorkingDirectory
        let resumedThread = try await ensureThreadResumed(
            threadId: threadId,
            force: true,
            preferredProjectPath: preferredProjectPath
        )
        let resolvedThread = thread(for: threadId) ?? resumedThread
        if resolvedThread != nil {
            snapshotOnlyPinnedThreadIDs.remove(threadId)
            _ = try? await loadThreadHistoryIfNeeded(threadId: threadId, forceRefresh: true)
        }
        return resolvedThread
    }

    // Re-injects pinned local snapshots when the paginated thread list omits older bookmarked chats.
    @discardableResult
    func injectPinnedSnapshotThreads(
        into mergedThreadsByID: inout [String: CodexThread],
        deletedThreadIDs: Set<String>
    ) -> Set<String> {
        guard !pinnedThreadIDs.isEmpty else {
            return []
        }

        var injectedThreadIDs: Set<String> = []
        let archivedThreadIDs = locallyArchivedThreadIDs

        for rootThreadID in pinnedThreadIDs {
            guard let snapshotThreads = pinnedThreadSnapshotsByRootID[rootThreadID] else {
                continue
            }

            for snapshotThread in snapshotThreads {
                guard !deletedThreadIDs.contains(snapshotThread.id),
                      mergedThreadsByID[snapshotThread.id] == nil else {
                    continue
                }

                var restoredThread = snapshotThread
                restoredThread.syncState = archivedThreadIDs.contains(restoredThread.id)
                    ? .archivedLocal
                    : snapshotThread.syncState
                mergedThreadsByID[restoredThread.id] = restoredThread
                injectedThreadIDs.insert(restoredThread.id)
            }
        }

        return injectedThreadIDs
    }

    private func persistPinnedThreadState() {
        let uniquePinnedThreadIDs = Array(NSOrderedSet(array: pinnedThreadIDs)) as? [String] ?? pinnedThreadIDs
        pinnedThreadIDs = uniquePinnedThreadIDs

        guard !uniquePinnedThreadIDs.isEmpty else {
            pinnedThreadSnapshotsByRootID.removeAll()
            defaults.removeObject(forKey: macScopedDefaultsKey(Self.pinnedThreadIDsDefaultsKey))
            defaults.removeObject(forKey: macScopedDefaultsKey(Self.pinnedThreadSnapshotsDefaultsKey))
            return
        }

        guard let encodedPinnedThreadIDs = try? encoder.encode(uniquePinnedThreadIDs) else {
            return
        }

        defaults.set(encodedPinnedThreadIDs, forKey: macScopedDefaultsKey(Self.pinnedThreadIDsDefaultsKey))

        let filteredSnapshots = pinnedThreadSnapshotsByRootID.filter { uniquePinnedThreadIDs.contains($0.key) }
        pinnedThreadSnapshotsByRootID = filteredSnapshots
        guard let encodedSnapshots = try? encoder.encode(filteredSnapshots) else {
            return
        }

        defaults.set(encodedSnapshots, forKey: macScopedDefaultsKey(Self.pinnedThreadSnapshotsDefaultsKey))
    }

    private func pinnedRootThreadID(for threadId: String?) -> String? {
        guard let normalizedThreadId = normalizedForkThreadID(threadId) else {
            return nil
        }

        if pinnedThreadIDs.contains(normalizedThreadId) {
            return normalizedThreadId
        }

        if let liveThread = thread(for: normalizedThreadId) {
            return rootThreadID(for: liveThread, snapshotThreadsByID: [:])
        }

        for (snapshotRootThreadID, snapshotThreads) in pinnedThreadSnapshotsByRootID {
            if snapshotThreads.contains(where: { $0.id == normalizedThreadId }) {
                let snapshotThreadsByID = Dictionary(uniqueKeysWithValues: snapshotThreads.map { ($0.id, $0) })
                if let snapshotThread = snapshotThreadsByID[normalizedThreadId] {
                    return rootThreadID(for: snapshotThread, snapshotThreadsByID: snapshotThreadsByID) ?? snapshotRootThreadID
                }
                return snapshotRootThreadID
            }
        }

        return nil
    }

    private func rootThreadID(for thread: CodexThread, snapshotThreadsByID: [String: CodexThread]) -> String? {
        var currentThread = thread
        var visitedThreadIDs: Set<String> = [thread.id]

        while let parentThreadID = currentThread.parentThreadId,
              !visitedThreadIDs.contains(parentThreadID) {
            if let liveParentThread = self.thread(for: parentThreadID) {
                currentThread = liveParentThread
                visitedThreadIDs.insert(parentThreadID)
                continue
            }

            if let snapshotParentThread = snapshotThreadsByID[parentThreadID] {
                currentThread = snapshotParentThread
                visitedThreadIDs.insert(parentThreadID)
                continue
            }

            return currentThread.id
        }

        return currentThread.id
    }

    private func snapshotThreadsForPinnedRoot(_ rootThreadID: String) -> [CodexThread]? {
        let normalizedRootThreadID = normalizedForkThreadID(rootThreadID) ?? rootThreadID
        let subtreeThreadIDs = subtreeThreadIDs(for: normalizedRootThreadID)
        if !subtreeThreadIDs.isEmpty {
            let subtreeThreadIDSet = Set(subtreeThreadIDs)
            let subtreeThreads = threads.filter { subtreeThreadIDSet.contains($0.id) }
            if !subtreeThreads.isEmpty {
                return subtreeThreads
            }
        }

        if let currentThread = thread(for: normalizedRootThreadID) {
            return [currentThread]
        }

        return pinnedThreadSnapshotsByRootID[normalizedRootThreadID]
    }

    private func snapshotThread(threadId: String) -> CodexThread? {
        guard let pinnedRootThreadID = pinnedRootThreadID(for: threadId),
              let snapshotThreads = pinnedThreadSnapshotsByRootID[pinnedRootThreadID] else {
            return nil
        }

        return snapshotThreads.first(where: { $0.id == threadId })
    }

    private func subtreeThreadIDs(for rootThreadID: String) -> [String] {
        let descendants = descendantThreadIDs(for: rootThreadID)
        return descendants.isEmpty ? [rootThreadID] : [rootThreadID] + descendants
    }

    private func descendantThreadIDs(for rootThreadID: String) -> [String] {
        var queue = [rootThreadID]
        var visitedThreadIDs: Set<String> = []
        var descendants: [String] = []

        while !queue.isEmpty {
            let currentThreadID = queue.removeFirst()
            for thread in threads where thread.parentThreadId == currentThreadID && !visitedThreadIDs.contains(thread.id) {
                visitedThreadIDs.insert(thread.id)
                descendants.append(thread.id)
                queue.append(thread.id)
            }
        }

        return descendants
    }
}
