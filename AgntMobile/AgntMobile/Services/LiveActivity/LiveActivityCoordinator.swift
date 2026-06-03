// FILE: LiveActivityCoordinator.swift
// Purpose: Owns the single in-flight agnt Live Activity. Starts it when a turn
//          begins, updates it across turns, and ends it (after a short linger on
//          the terminal state) when the turn finishes. Local ActivityKit updates
//          only — no push token, no network.
// Layer: App / Services
//
// Provider-agnostic: the coordinator is handed a thread title and a coarse
// running/failed signal. It never sees provider identity, session ids, or prompt
// text, so nothing provider-specific or bearer-like can reach the Lock Screen.

import ActivityKit
import Foundation

@MainActor
final class LiveActivityCoordinator {
    static let shared = LiveActivityCoordinator()

    private init() {}

    // At most one activity at a time: agnt mirrors a single foreground run.
    private var current: Activity<AgntActivityAttributes>?
    private var currentThreadId: String?

    // How long the finished state stays on screen before the activity dismisses.
    private let terminalLingerSeconds: UInt64 = 4

    private var activitiesEnabled: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    // Begins (or refocuses) the activity for a running turn.
    func turnStarted(threadId: String, title: String) {
        guard activitiesEnabled else { return }

        let state = AgntActivityAttributes.ContentState(
            phase: .running,
            detail: "Working…",
            updatedAt: Date()
        )

        if let current, currentThreadId == threadId {
            let content = ActivityContent(state: state, staleDate: nil)
            Task { await current.update(content) }
            return
        }

        // A different thread took focus — retire the old activity first.
        endCurrent(dismissalPolicy: .immediate)

        let attributes = AgntActivityAttributes(
            threadTitle: title.isEmpty ? "agnt" : title,
            startedAt: Date()
        )

        do {
            current = try Activity.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: nil)
            )
            currentThreadId = threadId
        } catch {
            current = nil
            currentThreadId = nil
        }
    }

    // Resolves the activity for a finished turn, lingering briefly on the outcome.
    func turnEnded(threadId: String, failed: Bool) {
        guard let activity = current, currentThreadId == threadId else { return }

        let state = AgntActivityAttributes.ContentState(
            phase: failed ? .failed : .completed,
            detail: failed ? "Stopped" : "Done",
            updatedAt: Date()
        )

        current = nil
        currentThreadId = nil

        let content = ActivityContent(state: state, staleDate: nil)
        let linger = terminalLingerSeconds
        Task {
            await activity.update(content)
            try? await Task.sleep(nanoseconds: linger * 1_000_000_000)
            await activity.end(content, dismissalPolicy: .immediate)
        }
    }

    // Tears down any live activity (e.g. on disconnect / sign-out).
    func endAll() {
        endCurrent(dismissalPolicy: .immediate)
    }

    private func endCurrent(dismissalPolicy: ActivityUIDismissalPolicy) {
        guard let activity = current else { return }
        current = nil
        currentThreadId = nil
        Task { await activity.end(nil, dismissalPolicy: dismissalPolicy) }
    }
}
