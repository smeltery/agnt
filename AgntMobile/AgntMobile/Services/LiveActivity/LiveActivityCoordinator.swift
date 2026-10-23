// FILE: LiveActivityCoordinator.swift
// Purpose: Owns the aggregate agnt Live Activity shown on the Lock Screen and
//          Dynamic Island. Tracks multiple off-screen conversations with coarse
//          running/review state using local ActivityKit updates only.
// Layer: App / Services

import ActivityKit
import Foundation
import UIKit

@MainActor
final class LiveActivityCoordinator {
    static let shared = LiveActivityCoordinator()

    private struct Outcome {
        let title: String
        let createdAt: Date
    }

    private init() {}

    private static let maxDisplayedConversations = 3

    private var expirationTask: Task<Void, Never>?
    private var current: Activity<AgntActivityAttributes>?
    private var runningTitlesByThread: [String: String] = [:]
    private var runningStartedAtByThread: [String: Date] = [:]
    private var completedOutcomesByThread: [String: Outcome] = [:]
    private var failedOutcomesByThread: [String: Outcome] = [:]

    private var activitiesEnabled: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    private func isWatching(_ threadId: String, isActiveChat: Bool) -> Bool {
        isActiveChat && UIApplication.shared.applicationState == .active
    }

    func turnStarted(threadId: String, title: String, isActiveChat: Bool) {
        guard activitiesEnabled else { return }

        completedOutcomesByThread.removeValue(forKey: threadId)
        failedOutcomesByThread.removeValue(forKey: threadId)

        if isWatching(threadId, isActiveChat: isActiveChat) {
            runningTitlesByThread.removeValue(forKey: threadId)
            runningStartedAtByThread.removeValue(forKey: threadId)
            applyCurrentSnapshot()
            return
        }

        runningTitlesByThread[threadId] = normalizedTitle(title)
        if runningStartedAtByThread[threadId] == nil {
            runningStartedAtByThread[threadId] = Date()
        }
        applyCurrentSnapshot()
    }

    func turnEnded(threadId: String, failed: Bool, title: String) {
        runningTitlesByThread.removeValue(forKey: threadId)
        runningStartedAtByThread.removeValue(forKey: threadId)

        if failed {
            failedOutcomesByThread[threadId] = Outcome(title: title, createdAt: Date())
            completedOutcomesByThread.removeValue(forKey: threadId)
        } else {
            completedOutcomesByThread[threadId] = Outcome(title: title, createdAt: Date())
            failedOutcomesByThread.removeValue(forKey: threadId)
        }
        applyCurrentSnapshot()
    }

    func clearRunning(threadId: String) {
        runningTitlesByThread.removeValue(forKey: threadId)
        runningStartedAtByThread.removeValue(forKey: threadId)
        applyCurrentSnapshot()
    }

    func dismissIfViewing(threadId: String?) {
        guard let threadId else {
            applyCurrentSnapshot()
            return
        }
        runningTitlesByThread.removeValue(forKey: threadId)
        runningStartedAtByThread.removeValue(forKey: threadId)
        completedOutcomesByThread.removeValue(forKey: threadId)
        failedOutcomesByThread.removeValue(forKey: threadId)
        applyCurrentSnapshot()
    }

    func endAll() {
        expirationTask?.cancel()
        expirationTask = nil
        runningTitlesByThread.removeAll()
        runningStartedAtByThread.removeAll()
        completedOutcomesByThread.removeAll()
        failedOutcomesByThread.removeAll()
        let activities = Activity<AgntActivityAttributes>.activities
        current = nil
        Task {
            for activity in activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    private func applyCurrentSnapshot() {
        let now = Date()
        completedOutcomesByThread = completedOutcomesByThread.filter {
            $0.value.createdAt.addingTimeInterval(LiveActivityExpiration.completedLifetime) > now
        }
        failedOutcomesByThread = failedOutcomesByThread.filter {
            $0.value.createdAt.addingTimeInterval(LiveActivityExpiration.failedLifetime) > now
        }
        completedOutcomesByThread = Dictionary(uniqueKeysWithValues: completedOutcomesByThread
            .sorted { $0.value.createdAt > $1.value.createdAt }
            .prefix(Self.maxDisplayedConversations).map { ($0.key, $0.value) })
        failedOutcomesByThread = Dictionary(uniqueKeysWithValues: failedOutcomesByThread
            .sorted { $0.value.createdAt > $1.value.createdAt }
            .prefix(Self.maxDisplayedConversations).map { ($0.key, $0.value) })
        let expiration = LiveActivityExpiration(
            runningStartedAt: Array(runningStartedAtByThread.values),
            completedAt: completedOutcomesByThread.values.map(\.createdAt),
            failedAt: failedOutcomesByThread.values.map(\.createdAt),
            now: now
        )
        expirationTask?.cancel()
        expirationTask = nil
        let state = makeContentState(now: now)
        if state.isEmpty {
            endCurrent(dismissalPolicy: .immediate)
            return
        }

        if let deadline = expiration.nextRefreshDate {
            expirationTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: UInt64(max(0, deadline.timeIntervalSinceNow) * 1_000_000_000))
                } catch { return }
                guard !Task.isCancelled else { return }
                self?.applyCurrentSnapshot()
            }
        }
        let content = ActivityContent(state: state, staleDate: expiration.staleDate)
        if let current {
            Task { await current.update(content) }
            return
        }

        do {
            current = try Activity.request(
                attributes: AgntActivityAttributes(title: "agnt", startedAt: Date()),
                content: content
            )
        } catch {
            current = nil
        }
    }

    private func makeContentState(now: Date) -> AgntActivityAttributes.ContentState {
        // Retain the original start time until the run ends so repeated active
        // events cannot revive a row that has reached its display lifetime.
        let running = runningTitlesByThread
            .filter { threadId, _ in
                guard let startedAt = runningStartedAtByThread[threadId] else { return false }
                return startedAt.addingTimeInterval(LiveActivityExpiration.runningLifetime) > now
            }
            .map { threadId, title in
                AgntActivityConversation(
                    id: threadId,
                    title: title,
                    detail: "Working...",
                    phase: .running,
                    runningStartedAt: runningStartedAtByThread[threadId]
                )
            }
            .sorted { lhs, rhs in
                if lhs.runningStartedAt != rhs.runningStartedAt {
                    return (lhs.runningStartedAt ?? .distantPast) < (rhs.runningStartedAt ?? .distantPast)
                }
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            }
            .prefix(Self.maxDisplayedConversations)

        let failed = failedOutcomesByThread
            .sorted { $0.value.createdAt > $1.value.createdAt }
            .prefix(Self.maxDisplayedConversations)
            .map { threadId, outcome in
                AgntActivityConversation(
                    id: threadId,
                    title: outcome.title,
                    detail: "Needs review",
                    phase: .failed,
                    runningStartedAt: nil
                )
            }

        let completed = completedOutcomesByThread
            .sorted { $0.value.createdAt > $1.value.createdAt }
            .prefix(Self.maxDisplayedConversations)
            .map { threadId, outcome in
                AgntActivityConversation(
                    id: threadId,
                    title: outcome.title,
                    detail: "Ready",
                    phase: .completed,
                    runningStartedAt: nil
                )
            }

        return AgntActivityAttributes.ContentState(
            runningConversations: Array(running),
            completedConversations: completed,
            failedConversations: failed,
            updatedAt: now
        )
    }

    private func endCurrent(dismissalPolicy: ActivityUIDismissalPolicy) {
        guard let activity = current else { return }
        current = nil
        Task { await activity.end(nil, dismissalPolicy: dismissalPolicy) }
    }

    private func normalizedTitle(_ title: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "agnt" : trimmed
    }
}
