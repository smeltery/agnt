// FILE: CodexService+Sync.swift
// Purpose: Near-real-time sync loop and server-authoritative thread reconciliation.
// Layer: Service
// Exports: CodexService sync APIs
// Depends on: CodexThread, CodexServiceError

import Foundation

import Foundation

extension CodexService {
    struct RunningThreadCatchupOutcome: Equatable {
        let didRefreshTurnState: Bool
        let isRunning: Bool
        let didRunForcedResume: Bool
    }

    func startSyncLoop() {
        guard canRunRealtimeSyncLoop else {
            stopSyncLoop()
            return
        }

        stopSyncLoop()
        debugSyncLog("sync loop start")

        // Foreground polling is intentionally more aggressive so desktop-authored changes
        // feel closer to live on iPhone even when Codex.app itself doesn't push updates.
        let listIntervalForegroundNs: UInt64 = 10_000_000_000
        let listIntervalBackgroundNs: UInt64 = 75_000_000_000
        let historyIntervalForegroundNs: UInt64 = 3_000_000_000
        let historyIntervalForegroundMirroredNs: UInt64 = 1_000_000_000
        let historyIntervalBackgroundIdleNs: UInt64 = 90_000_000_000
        let historyIntervalBackgroundRunningNs: UInt64 = 12_000_000_000
        let watchIntervalForegroundNs: UInt64 = 2_000_000_000
        let watchIntervalBackgroundNs: UInt64 = 15_000_000_000

        threadListSyncTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.syncThreadsList()
                await self.refreshInactiveRunningBadgeThreads()
                let interval = self.isAppInForeground ? listIntervalForegroundNs : listIntervalBackgroundNs
                try? await Task.sleep(nanoseconds: interval)
            }
        }

        activeThreadSyncTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                if let threadId = self.activeThreadId {
                    let hasActiveOrRunningTurn = self.threadHasActiveOrRunningTurn(threadId)
                    let wantsMirroredRunningCatchup = self.shouldPrioritizeMirroredRunningCatchup(threadId)
                    await self.syncActiveThreadState(threadId: threadId)
                    let interval: UInt64
                    if self.isAppInForeground {
                        interval = wantsMirroredRunningCatchup
                            ? historyIntervalForegroundMirroredNs
                            : historyIntervalForegroundNs
                    } else if hasActiveOrRunningTurn {
                        interval = historyIntervalBackgroundRunningNs
                    } else {
                        interval = historyIntervalBackgroundIdleNs
                    }
                    try? await Task.sleep(nanoseconds: interval)
                    continue
                }
                let interval = self.isAppInForeground ? historyIntervalForegroundNs : historyIntervalBackgroundIdleNs
                try? await Task.sleep(nanoseconds: interval)
            }
        }

        runningThreadWatchSyncTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.refreshInactiveRunningBadgeThreads()
                let interval = self.isAppInForeground ? watchIntervalForegroundNs : watchIntervalBackgroundNs
                try? await Task.sleep(nanoseconds: interval)
            }
        }

        requestImmediateSync(threadId: activeThreadId)
    }

    func stopSyncLoop() {
        threadListSyncTask?.cancel()
        threadListSyncTask = nil

        activeThreadSyncTask?.cancel()
        activeThreadSyncTask = nil

        runningThreadWatchSyncTask?.cancel()
        runningThreadWatchSyncTask = nil
    }

    func setForegroundState(_ isForeground: Bool) {
        guard isAppInForeground != isForeground else {
            return
        }

        isAppInForeground = isForeground
        if isForeground {
            if isConnected && isInitialized {
                startWebSocketKeepAliveLoop()
                startSyncLoop()
                requestImmediateSync(threadId: activeThreadId)
                // Re-check bridge-managed state when the app becomes active again.
                Task { @MainActor [weak self] in
                    await self?.refreshBridgeManagedState(allowAvailableBridgeUpdatePrompt: true)
                }
            } else {
                stopWebSocketKeepAliveLoop()
                stopSyncLoop()
            }
        } else {
            stopWebSocketKeepAliveLoop()
            if isConnected && isInitialized {
                startSyncLoop()
                requestImmediateSync(threadId: activeThreadId)
            } else {
                stopSyncLoop()
            }
        }
        updateBackgroundRunGraceTask()
    }

    func requestImmediateSync(threadId: String? = nil) {
        guard canRunRealtimeSyncLoop else {
            return
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.syncThreadsList()
            await self.refreshInactiveRunningBadgeThreads()
            if let threadId = threadId ?? self.activeThreadId {
                await self.syncActiveThreadState(threadId: threadId)
            }
        }
    }

    // Thread opening should refresh the visible chat, not refetch the full sidebar list.
    func requestImmediateActiveThreadSync(threadId: String? = nil) {
        guard canRunRealtimeSyncLoop else {
            return
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            if let threadId = threadId ?? self.activeThreadId {
                await self.syncActiveThreadState(threadId: threadId)
            }
        }
    }

    func syncThreadsList() async {
        guard isConnected, isInitialized else {
            return
        }

        do {
            let activeThreads = try await fetchCoalescedServerThreads(limit: recentActiveThreadListLimit)

            // Also fetch server-archived threads so they survive app restarts.
            var archivedThreads: [CodexThread] = []
            do {
                archivedThreads = try await fetchCoalescedServerThreads(
                    limit: recentArchivedThreadListLimit,
                    archived: true
                )
            } catch {
                debugSyncLog("thread/list archived fetch failed (non-fatal): \(error.localizedDescription)")
            }

            reconcileLocalThreadsWithServer(activeThreads, serverArchivedThreads: archivedThreads)
            debugSyncLog("sync thread/list active=\(activeThreads.count) archived=\(archivedThreads.count) local=\(threads.count)")
        } catch {
            presentConnectionErrorIfNeeded(error)
        }
    }

    func syncThreadHistory(threadId: String, force: Bool = false) async {
        guard isConnected, isInitialized else {
            return
        }

        if thread(for: threadId)?.syncState == .archivedLocal {
            return
        }

        do {
            try await loadThreadHistoryIfNeeded(threadId: threadId, forceRefresh: force)
        } catch {
            if shouldTreatAsThreadNotFound(error) {
                // Do not archive on background sync alone.
                // Some servers can temporarily fail thread/read for fresh or stale listeners.
                // We archive only after an explicit turn/start send failure confirms missing thread.
                debugSyncLog("sync thread/read reported missing thread=\(threadId); waiting for send-time confirmation")
                return
            }
            presentConnectionErrorIfNeeded(error)
        }
    }
}
