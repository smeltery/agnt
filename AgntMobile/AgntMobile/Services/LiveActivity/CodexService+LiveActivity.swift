// FILE: CodexService+LiveActivity.swift
// Purpose: Bridges CodexService turn state to the Live Activity coordinator.
//          Translates a per-thread "turn active" edge into start/end calls and
//          resolves a display title from the thread list. Kept separate from the
//          transport so CodexService stays lean.
// Layer: App / Services

import Foundation

extension CodexService {
    // Reflects a turn becoming active/inactive in the Lock Screen Live Activity.
    // Provider-agnostic: only the thread title and a coarse failed flag cross over.
    func syncLiveActivity(threadId: String, turnActive: Bool) {
        if turnActive {
            LiveActivityCoordinator.shared.turnStarted(
                threadId: threadId,
                title: liveActivityTitle(for: threadId)
            )
        } else {
            LiveActivityCoordinator.shared.turnEnded(
                threadId: threadId,
                failed: failedThreadIDs.contains(threadId)
            )
        }
    }

    private func liveActivityTitle(for threadId: String) -> String {
        guard let thread = threads.first(where: { $0.id == threadId }) else {
            return "agnt"
        }
        return thread.title ?? thread.name ?? "agnt"
    }
}
