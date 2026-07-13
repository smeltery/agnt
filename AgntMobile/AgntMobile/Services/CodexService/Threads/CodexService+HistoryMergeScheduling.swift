// FILE: CodexService+HistoryMergeScheduling.swift
// Purpose: Off-main history merge scheduling and recent-window policy.
// Layer: Service
// Exports: CodexService history merge scheduling helpers
// Depends on: CodexMessage

import Foundation

enum RunningThreadHistoryCatchupPolicy {
    // Running-thread reopen only needs the latest transcript tail to catch up the UI.
    nonisolated static let recentMergeWindow = 160
    nonisolated static let cancellationCheckInterval = 32
}

extension CodexService {
    nonisolated static func shouldPreferRecentHistoryWindow(
        existingCount: Int,
        historyCount: Int,
        windowSize: Int = RunningThreadHistoryCatchupPolicy.recentMergeWindow
    ) -> Bool {
        let normalizedWindowSize = max(1, windowSize)
        guard existingCount > normalizedWindowSize,
              historyCount > normalizedWindowSize else {
            return false
        }

        // Only trust the local prefix when it is already deep enough to cover the
        // server prefix we are about to skip. Otherwise fall back to canonical merge.
        return existingCount >= (historyCount - normalizedWindowSize)
    }

    // Runs history reconciliation off the main actor and cancels the worker if the caller goes away.
    func mergeHistoryMessagesOffMainActor(
        existing: [CodexMessage],
        history: [CodexMessage],
        activeThreadIDs: Set<String>,
        runningThreadIDs: Set<String>,
        preferRecentWindow: Bool
    ) async throws -> [CodexMessage] {
        let mergeTask = Task.detached(priority: .userInitiated) { () throws -> [CodexMessage] in
            if preferRecentWindow {
                return try Self.mergeRecentHistoryWindow(
                    existing,
                    history,
                    activeThreadIDs: activeThreadIDs,
                    runningThreadIDs: runningThreadIDs,
                    windowSize: RunningThreadHistoryCatchupPolicy.recentMergeWindow
                )
            }

            return try Self.mergeHistoryMessages(
                existing,
                history,
                activeThreadIDs: activeThreadIDs,
                runningThreadIDs: runningThreadIDs
            )
        }

        return try await withTaskCancellationHandler {
            try await mergeTask.value
        } onCancel: {
            mergeTask.cancel()
        }
    }
}
