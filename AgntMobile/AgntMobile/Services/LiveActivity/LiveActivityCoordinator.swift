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

    func turnEnded(threadId: String, failed: Bool) {
        guard let title = runningTitlesByThread[threadId] else {
            return
        }
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

    func dismissIfViewing(threadId: String?) {
        guard let threadId else { return }
        runningTitlesByThread.removeValue(forKey: threadId)
        runningStartedAtByThread.removeValue(forKey: threadId)
        completedOutcomesByThread.removeValue(forKey: threadId)
        failedOutcomesByThread.removeValue(forKey: threadId)
        applyCurrentSnapshot()
    }

    func endAll() {
        runningTitlesByThread.removeAll()
        runningStartedAtByThread.removeAll()
        completedOutcomesByThread.removeAll()
        failedOutcomesByThread.removeAll()
        endCurrent(dismissalPolicy: .immediate)
    }

    private func applyCurrentSnapshot() {
        let state = makeContentState()
        if state.isEmpty {
            endCurrent(dismissalPolicy: .immediate)
            return
        }

        let content = ActivityContent(state: state, staleDate: nil)
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

    private func makeContentState() -> AgntActivityAttributes.ContentState {
        let running = runningTitlesByThread
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
            updatedAt: Date()
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
