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
import UIKit

@MainActor
final class LiveActivityCoordinator {
    static let shared = LiveActivityCoordinator()

    private init() {}

    // At most one activity at a time: agnt mirrors a single foreground run.
    private var current: Activity<AgntActivityAttributes>?
    private var currentThreadId: String?
    // Pending end-after-linger; cancelled when a new turn supersedes the outcome.
    private var finishTask: Task<Void, Never>?

    // How long the finished state stays on screen before the activity dismisses.
    private let terminalLingerSeconds: UInt64 = 4

    private var activitiesEnabled: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    // A chat the user is actively watching needs no Lock Screen mirror.
    private func isWatching(_ threadId: String, isActiveChat: Bool) -> Bool {
        isActiveChat && UIApplication.shared.applicationState == .active
    }

    // Begins (or refocuses) the activity for a running turn.
    // `isActiveChat` is true when `threadId` is the thread currently on screen.
    func turnStarted(threadId: String, title: String, isActiveChat: Bool) {
        guard activitiesEnabled else { return }

        // Don't surface a Live Activity for the chat the user is looking at.
        if isWatching(threadId, isActiveChat: isActiveChat) {
            if currentThreadId == threadId { endCurrent(dismissalPolicy: .immediate) }
            return
        }

        // A new turn supersedes any pending terminal dismissal.
        cancelFinish()

        let state = AgntActivityAttributes.ContentState(
            phase: .running,
            detail: "Working…",
            updatedAt: Date()
        )

        // Reuse the existing activity for the same thread (incl. one still
        // lingering on its terminal state) instead of flickering a new one.
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
        let content = ActivityContent(state: state, staleDate: nil)

        // Keep `current` set during the linger so a follow-up turn on the same
        // thread can cancel the dismissal and reuse the activity.
        cancelFinish()
        let linger = terminalLingerSeconds
        finishTask = Task { [weak self] in
            await activity.update(content)
            try? await Task.sleep(nanoseconds: linger * 1_000_000_000)
            if Task.isCancelled { return }
            await activity.end(content, dismissalPolicy: .immediate)
            guard let self else { return }
            if self.currentThreadId == threadId {
                self.current = nil
                self.currentThreadId = nil
            }
            self.finishTask = nil
        }
    }

    // The user opened/returned to a chat — drop its Lock Screen mirror.
    func dismissIfViewing(threadId: String?) {
        guard let threadId, currentThreadId == threadId else { return }
        endCurrent(dismissalPolicy: .immediate)
    }

    // Tears down any live activity (e.g. on disconnect / sign-out).
    func endAll() {
        endCurrent(dismissalPolicy: .immediate)
    }

    private func cancelFinish() {
        finishTask?.cancel()
        finishTask = nil
    }

    private func endCurrent(dismissalPolicy: ActivityUIDismissalPolicy) {
        cancelFinish()
        guard let activity = current else { return }
        current = nil
        currentThreadId = nil
        Task { await activity.end(nil, dismissalPolicy: dismissalPolicy) }
    }
}
