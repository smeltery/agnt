// FILE: CodexService+ThreadReconciliation.swift
// Purpose: Server-authoritative thread reconciliation and missing-thread cleanup.
// Layer: Service

import Foundation

extension CodexService {
    func reconcileLocalThreadsWithServer(
        _ serverThreads: [CodexThread],
        serverArchivedThreads: [CodexThread] = []
    ) {
        let localByID = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0) })
        let persistedArchivedIDs = locallyArchivedThreadIDs
        let persistedDeletedIDs = locallyDeletedThreadIDs

        var merged: [String: CodexThread] = [:]

        // Merge active server threads.
        for serverThread in serverThreads {
            if persistedDeletedIDs.contains(serverThread.id) {
                continue
            }

            var liveThread = serverThread

            if let localThread = localByID[liveThread.id] {
                liveThread = mergedThread(liveThread, with: localThread, treatAsServerState: true)
                liveThread.syncState = localThread.syncState
            } else if persistedArchivedIDs.contains(liveThread.id) {
                liveThread.syncState = .archivedLocal
            } else {
                liveThread.syncState = .live
            }

            merged[liveThread.id] = liveThread
        }

        // Merge server-archived threads (from thread/list?archived=true).
        for serverThread in serverArchivedThreads {
            if persistedDeletedIDs.contains(serverThread.id) {
                continue
            }
            guard merged[serverThread.id] == nil else {
                continue
            }

            var archivedThread = serverThread
            if let localThread = localByID[archivedThread.id] {
                archivedThread = mergedThread(archivedThread, with: localThread, treatAsServerState: true)
            }
            archivedThread.syncState = .archivedLocal

            // Persist the archived state so it survives future reconciliations.
            addLocallyArchivedThreadID(archivedThread.id)
            merged[archivedThread.id] = archivedThread
        }

        // Keep local-only threads as-is; a missing entry in thread/list can be
        // caused by server-side pagination or temporary visibility mismatch.
        // We archive only on explicit "thread not found" from thread/read/turn/start.
        for localThread in threads where merged[localThread.id] == nil {
            if persistedDeletedIDs.contains(localThread.id) {
                continue
            }
            merged[localThread.id] = localThread
        }

        snapshotOnlyPinnedThreadIDs = injectPinnedSnapshotThreads(
            into: &merged,
            deletedThreadIDs: persistedDeletedIDs
        )

        threads = sortThreads(Array(merged.values))
        assistantRevertStateCacheByThread.removeAll()
        refreshBusyRepoRootsAndDependentTimelineStates()
        // Full reconciliation — always refresh all threads even if busy-roots already hit some.
        refreshAllThreadTimelineStates()

        if activeThreadId == nil {
            activeThreadId = firstLiveThreadID()
        }

        if pendingNotificationOpenThreadID != nil {
            // A successful thread/list refresh gives us fresh server truth, so retry
            // any deferred push deep-link without forcing another list round-trip.
            Task { @MainActor [weak self] in
                _ = await self?.routePendingNotificationOpenIfPossible(refreshIfNeeded: false)
            }
        }
    }

    func handleMissingThread(_ threadId: String) {
        clearRunningState(for: threadId)
        clearOutcomeBadge(for: threadId)

        if let index = threadIndex(for: threadId) {
            threads[index].syncState = .archivedLocal
        } else {
            threads.append(CodexThread(id: threadId, title: CodexThread.defaultDisplayTitle, syncState: .archivedLocal))
            threads = sortThreads(threads)
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
            if activeTurnId == turnId {
                activeTurnId = nil
            }
        }
        threadIdByTurnID = threadIdByTurnID.filter { $0.value != threadId }

        if var messages = messagesByThread[threadId] {
            var didMutate = false
            for index in messages.indices where messages[index].isStreaming {
                messages[index].isStreaming = false
                didMutate = true
            }
            if didMutate {
                messagesByThread[threadId] = messages
                persistMessages()
                updateCurrentOutput(for: threadId)
            }
        }

        removeThreadTimelineState(for: threadId)

        debugSyncLog("thread archived locally: \(threadId)")
    }
}
