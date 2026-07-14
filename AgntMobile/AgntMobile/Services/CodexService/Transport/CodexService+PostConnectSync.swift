// FILE: CodexService+PostConnectSync.swift
// Purpose: Post-connect thread catchup and runtime option refresh scheduling.
// Layer: Service

import Foundation

extension CodexService {
    func schedulePostConnectSyncPass(preferredThreadId: String? = nil) {
        postConnectSyncTask?.cancel()
        isBootstrappingConnectionSync = true

        let syncToken = UUID()
        postConnectSyncToken = syncToken
        let preferredThreadId = preferredThreadId
        postConnectSyncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.postConnectSyncToken == syncToken {
                    self.isBootstrappingConnectionSync = false
                    self.postConnectSyncTask = nil
                    self.postConnectSyncToken = nil
                }
            }
            await self.performPostConnectSyncPass(preferredThreadId: preferredThreadId)
        }
    }

    // Paint chats first; runtime metadata is useful composer chrome but must
    // never block thread sync on bridges where model/list is slow.
    func performPostConnectSyncPass(preferredThreadId: String? = nil) async {
        try? await listThreads()
        if await routePendingNotificationOpenIfPossible(refreshIfNeeded: false) {
            scheduleRuntimeOptionRefresh()
            return
        }
        let resolvedPreferredThreadId = normalizedInterruptIdentifier(preferredThreadId)
        if let resolvedPreferredThreadId {
            activeThreadId = resolvedPreferredThreadId
        }
        if let threadId = activeThreadId
            ?? resolvedPreferredThreadId
            ?? firstLiveThreadID() {
            let catchupOutcome = await catchUpRunningThreadIfNeeded(
                threadId: threadId,
                shouldForceResume: true
            )
            if catchupOutcome.isRunning {
                if !catchupOutcome.didRunForcedResume {
                    requestImmediateActiveThreadSync(threadId: threadId)
                }
                if activeThreadId == threadId {
                    currentOutput = messages(for: threadId)
                        .reversed()
                        .first(where: { $0.role == .assistant && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })?
                        .text ?? ""
                }
            } else if shouldDeferHeavyDisplayHydration(threadId: threadId) {
                markThreadNeedingCanonicalHistoryReconcile(
                    threadId,
                    requestImmediateSync: activeThreadId == threadId
                )
            }
        }
        scheduleRuntimeOptionRefresh()
    }

    // Checks optional plan-mode metadata after the socket is usable so reconnect is not gated by it.
    func schedulePlanCollaborationModeProbe() {
        Task { @MainActor [weak self] in
            guard let self, self.isConnected, self.isInitialized else { return }
            let runtimeReportedPlanSupport = await self.runtimeSupportsPlanCollaborationMode()
            self.debugRuntimeLog("collaborationMode/list plan=\(runtimeReportedPlanSupport)")
            if !runtimeReportedPlanSupport {
                self.debugRuntimeLog(
                    "collaborationMode/list did not report plan; will still attempt collaborationMode until runtime rejects it"
                )
            }
        }
    }

    // Keep model/reasoning metadata off the critical reconnect path. Some bridge
    // runtimes can answer chats while model/list is still slow or unavailable.
    func scheduleRuntimeOptionRefresh() {
        pendingRuntimeOptionRefresh = true
        flushPendingRuntimeOptionRefreshIfPossible(delayNanoseconds: 1_000_000_000)
    }

    // Runs a queued runtime metadata refresh once thread hydration is no longer busy.
    func flushPendingRuntimeOptionRefreshIfPossible(delayNanoseconds: UInt64 = 0) {
        guard pendingRuntimeOptionRefresh,
              runtimeOptionRefreshTask == nil,
              isConnected,
              isInitialized,
              !isLoadingThreads else {
            return
        }

        pendingRuntimeOptionRefresh = false
        let refreshToken = UUID()
        runtimeOptionRefreshToken = refreshToken
        runtimeOptionRefreshTask = Task { @MainActor [weak self] in
            if delayNanoseconds > 0 {
                do {
                    try await Task.sleep(nanoseconds: delayNanoseconds)
                } catch {
                    return
                }
            }
            guard !Task.isCancelled else { return }
            guard let self else { return }
            guard self.runtimeOptionRefreshToken == refreshToken else { return }
            defer {
                if self.runtimeOptionRefreshToken == refreshToken {
                    self.runtimeOptionRefreshTask = nil
                    self.runtimeOptionRefreshToken = nil
                }
            }
            guard self.isConnected, self.isInitialized else { return }
            guard !self.isLoadingThreads else {
                self.pendingRuntimeOptionRefresh = true
                return
            }
            try? await self.listModels()
            if self.runtimeOptionRefreshToken == refreshToken {
                self.pendingRuntimeOptionRefresh = false
            }
        }
    }

}
