// FILE: CodexService+MessageHistory.swift
// Purpose: Owns per-thread display, hydration, running-state, and history reconciliation helpers.
// Layer: Service
// Exports: CodexService thread history helpers
// Depends on: CodexMessage, JSONValue

import Foundation
import UIKit

enum CanonicalHistoryReconcileRetryPolicy {
    static let initialDelayNanoseconds: UInt64 = 1_500_000_000
    static let maximumDelayNanoseconds: UInt64 = 60_000_000_000

    // Giant histories can take tens of seconds per attempt. Exponential spacing
    // keeps recovery persistent without hammering the bridge forever.
    static func delayNanoseconds(forAttempt attempt: Int) -> UInt64 {
        var delay = initialDelayNanoseconds
        for _ in 1..<max(1, min(attempt, 7)) {
            delay = min(delay * 2, maximumDelayNanoseconds)
        }
        return delay
    }
}

enum StreamingDeltaCoalescingPolicy {
    // One display-frame worth of buffering keeps streaming lively while reducing UI invalidations.
    static let flushDelayNanoseconds: UInt64 = 16_000_000
    // Assistant prose gets one quick first paint, then a calmer cadence once text is visible.
    static let assistantInitialFlushDelayNanoseconds: UInt64 = 50_000_000
    static let assistantStreamingFlushDelayNanoseconds: UInt64 = 80_000_000
    static let assistantLargeStreamingFlushDelayNanoseconds: UInt64 = 100_000_000
    static let interactionFlushDelayNanoseconds: UInt64 = 80_000_000
    static let assistantLargePendingDeltaByteCount = 12_000
    static let assistantLargeVisibleTextByteCount = 32_000
}

extension Array where Element == CodexMessage {
    func messageIndexByID() -> [String: Int] {
        var result: [String: Int] = [:]
        result.reserveCapacity(count)
        for (index, message) in enumerated() {
            result[message.id] = index
        }
        return result
    }
}

extension CodexService {
    enum ThreadHistoryLoadOutcome: Equatable {
        case alreadyHydrated
        case notMaterialized
        case skippedForRunningThread
        case loadedCanonicalHistory
        case loadedRecentWindow
        case loadedPaginatedWindow
        case loadedProvisionalPaginatedWindow
        case deferredAfterTimeout
        case deferredAfterEmptyPage
        case deferredAfterUnavailablePage

        var didCompleteCanonicalReconcile: Bool {
            self == .loadedCanonicalHistory
        }

        var needsCanonicalRetry: Bool {
            self == .loadedRecentWindow
                || self == .loadedProvisionalPaginatedWindow
                || self == .skippedForRunningThread
                || self == .deferredAfterTimeout
                || self == .deferredAfterEmptyPage
                || self == .deferredAfterUnavailablePage
        }
    }

    enum ThreadDisplayPhase: Equatable {
        case loading
        case empty
        case ready
    }

    // Returns the full persisted timeline for a single thread.
    func messages(for threadId: String) -> [CodexMessage] {
        messagesByThread[threadId] ?? []
    }

    // Centralizes first-open display state so reconnect jitter does not bounce
    // an existing chat between loading and the empty placeholder.
    func threadDisplayPhase(threadId: String) -> ThreadDisplayPhase {
        threadDisplayPhase(
            threadId: threadId,
            hasVisibleMessages: !messages(for: threadId).isEmpty,
            isThreadRunning: threadHasActiveOrRunningTurn(threadId)
        )
    }

    // Variant for active SwiftUI views that already hold a per-thread render snapshot.
    // It avoids subscribing that view to the global messagesByThread dictionary.
    func threadDisplayPhase(
        threadId: String,
        hasVisibleMessages: Bool,
        isThreadRunning: Bool
    ) -> ThreadDisplayPhase {
        if hasVisibleMessages || isThreadRunning {
            return .ready
        }

        if loadingThreadIDs.contains(threadId) {
            return .loading
        }

        let shouldShowBlankComposer = shouldShowImmediateEmptyPlaceholder(
            threadId: threadId,
            hasVisibleMessages: hasVisibleMessages,
            isThreadRunning: isThreadRunning
        )
        if supportsTurnPagination,
           !initialTurnsLoadedByThreadID.contains(threadId),
           !shouldShowBlankComposer {
            return .loading
        }

        if shouldSkipInitialDisplayHydration(
            threadId: threadId,
            hasVisibleMessages: hasVisibleMessages,
            isThreadRunning: isThreadRunning
        ) || shouldShowBlankComposer {
            return .empty
        }

        if !hydratedThreadIDs.contains(threadId) {
            return .loading
        }

        return .empty
    }

    // Treats placeholder-only chats as intentionally blank so the UI does not flash
    // a loading state before the thread-open preparation path can confirm the skip.
    func shouldShowImmediateEmptyPlaceholder(threadId: String) -> Bool {
        shouldShowImmediateEmptyPlaceholder(
            threadId: threadId,
            hasVisibleMessages: !messages(for: threadId).isEmpty,
            isThreadRunning: threadHasActiveOrRunningTurn(threadId)
        )
    }

    func shouldShowImmediateEmptyPlaceholder(
        threadId: String,
        hasVisibleMessages: Bool,
        isThreadRunning: Bool
    ) -> Bool {
        guard !isThreadRunning,
              !hasVisibleMessages,
              let thread = thread(for: threadId),
              thread.syncState == .live else {
            return false
        }

        let preview = thread.preview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard preview.isEmpty else {
            return false
        }

        // Keep a brand-new blank chat on the empty composer even if a hydration
        // race briefly toggled the thread into a loading state behind the scenes.
        return thread.displayTitle == CodexThread.defaultDisplayTitle
    }

    // Treat an empty paginated response as provisional when local evidence says
    // this thread should already have visible history.
    func shouldDeferEmptyThreadHistoryPage(
        threadId: String,
        loadedViaPagination: Bool
    ) -> Bool {
        let hasPendingSourceReplacement = pendingCanonicalSourceReplacementThreadIDs.contains(threadId)
        guard loadedViaPagination || hasPendingSourceReplacement else {
            return false
        }

        if hasPendingSourceReplacement {
            return true
        }

        if messagesByThread[threadId]?.isEmpty == false {
            return true
        }

        let preview = (thread(for: threadId)?.preview ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return !preview.isEmpty
    }

    // A freshly started thread has metadata but no server history until the
    // first user message materializes it. Treat that as an empty composer state.
    func shouldTreatAsEmptyUnmaterializedThreadHistory(
        _ error: CodexServiceError,
        threadId: String,
        markHydratedWhenNotMaterialized: Bool
    ) -> Bool {
        guard case .rpcError(let rpcError) = error else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("not materialized")
                && message.contains("before first user message")
                && shouldShowImmediateEmptyPlaceholder(
                    threadId: threadId,
                    hasVisibleMessages: !messages(for: threadId).isEmpty,
                    isThreadRunning: threadHasActiveOrRunningTurn(threadId)
                ) else {
            return false
        }

        if markHydratedWhenNotMaterialized
            && !deferHydratedMarkForNotMaterializedThreadIDs.contains(threadId) {
            hydratedThreadIDs.insert(threadId)
        }
        if activeThreadId == threadId {
            lastErrorMessage = nil
        }
        refreshThreadTimelineState(for: threadId)
        return true
    }
}
