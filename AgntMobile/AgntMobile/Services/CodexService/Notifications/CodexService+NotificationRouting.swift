// FILE: CodexService+NotificationRouting.swift
// Purpose: Routes notification taps to live threads and handles missing-thread fallbacks.
// Layer: Service
// Exports: CodexService notification routing helpers
// Depends on: CodexService thread list and display preparation

import Foundation

extension CodexService {
    // Keeps push-tap intent alive across reconnect so cold-launch opens can resolve later.
    @discardableResult
    func routePendingNotificationOpenIfPossible(refreshIfNeeded: Bool = true) async -> Bool {
        guard let pendingThreadId = pendingNotificationOpenThreadID?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !pendingThreadId.isEmpty else {
            return false
        }

        if hasNotificationRoutingCandidate(threadId: pendingThreadId) {
            missingNotificationThreadPrompt = nil
            if await prepareThreadForDisplay(threadId: pendingThreadId) {
                if pendingNotificationOpenThreadID == pendingThreadId {
                    pendingNotificationOpenThreadID = nil
                }
                return true
            }
            if hasNotificationRoutingCandidate(threadId: pendingThreadId) {
                return false
            }
        }

        guard isConnected else {
            return false
        }

        let didRefreshThreads: Bool
        if refreshIfNeeded {
            didRefreshThreads = await refreshThreadsForNotificationRouting()
        } else {
            didRefreshThreads = true
        }

        guard hasNotificationRoutingCandidate(threadId: pendingThreadId) else {
            guard didRefreshThreads else {
                return false
            }
            return finalizeMissingNotificationRouteIfNeeded(
                threadId: pendingThreadId,
                isAuthoritativeMissingResult: isNotificationRouteKnownMissing(threadId: pendingThreadId)
            )
        }

        missingNotificationThreadPrompt = nil
        if await prepareThreadForDisplay(threadId: pendingThreadId) {
            if pendingNotificationOpenThreadID == pendingThreadId {
                pendingNotificationOpenThreadID = nil
            }
            return true
        }

        if !hasNotificationRoutingCandidate(threadId: pendingThreadId), didRefreshThreads {
            return finalizeMissingNotificationRouteIfNeeded(
                threadId: pendingThreadId,
                isAuthoritativeMissingResult: isNotificationRouteKnownMissing(threadId: pendingThreadId)
            )
        }

        return false
    }
}

private extension CodexService {
    // Only live threads can satisfy a notification open; archived placeholders mean the server rejected it.
    func hasNotificationRoutingCandidate(threadId: String) -> Bool {
        guard let thread = thread(for: threadId) else {
            return false
        }

        return thread.syncState != .archivedLocal
    }

    // `thread/list` can omit still-live threads, so only an explicit archived placeholder is authoritative.
    func isNotificationRouteKnownMissing(threadId: String) -> Bool {
        thread(for: threadId)?.syncState == .archivedLocal
    }

    // Consumes the pending deep-link only after a fresh thread refresh confirms the target is gone.
    func finalizeMissingNotificationRouteIfNeeded(
        threadId: String,
        isAuthoritativeMissingResult: Bool
    ) -> Bool {
        guard isAuthoritativeMissingResult else {
            return false
        }

        if pendingNotificationOpenThreadID == threadId {
            pendingNotificationOpenThreadID = nil
        }
        if activeThreadId == nil || activeThreadId == threadId {
            activeThreadId = firstLiveThreadID()
        }
        missingNotificationThreadPrompt = CodexMissingNotificationThreadPrompt(threadId: threadId)
        return false
    }

    // Refreshes the thread list before routing a notification tap to a thread created on another client.
    func refreshThreadsForNotificationRouting() async -> Bool {
        guard isConnected else {
            return false
        }

        do {
            try await listThreads()
            return true
        } catch {
            debugRuntimeLog("thread refresh for notification routing failed: \(error.localizedDescription)")
            return false
        }
    }
}
