// FILE: CodexService+BackgroundRunGrace.swift
// Purpose: iOS background task grace window for running turns.
// Layer: Service

import Foundation
import UIKit

private final class BackgroundTaskIdentifierBox: @unchecked Sendable {
    var taskID: UIBackgroundTaskIdentifier = .invalid
}

extension CodexService {
    // Starts or ends the iOS grace window that lets a just-backgrounded run finish cleanly.
    func updateBackgroundRunGraceTask() {
        guard !isAppInForeground else {
            backgroundTurnGraceExpiredUntilForeground = false
            endBackgroundRunGraceTask(reason: "foreground")
            return
        }

        guard hasAnyRunningTurn else {
            endBackgroundRunGraceTask(reason: "idle")
            return
        }

        guard !backgroundTurnGraceExpiredUntilForeground else {
            return
        }

        guard backgroundTurnGraceTaskID == .invalid else {
            return
        }

        let taskBox = BackgroundTaskIdentifierBox()
        let taskID = UIApplication.shared.beginBackgroundTask(withName: "CodexRunGrace") { [weak self, taskBox] in
            let expiredTaskID = taskBox.taskID
            guard expiredTaskID != .invalid else {
                return
            }

            // UIKit expects the task to end inside the expiration handler, before
            // we hop back into CodexService's MainActor-isolated state.
            UIApplication.shared.endBackgroundTask(expiredTaskID)
            Task { @MainActor [weak self] in
                self?.recordBackgroundRunGraceTaskExpired(taskID: expiredTaskID)
            }
        }

        guard taskID != .invalid else {
            debugSyncLog("background run grace task unavailable")
            return
        }

        taskBox.taskID = taskID
        backgroundTurnGraceTaskID = taskID
        debugSyncLog("background run grace task started")
    }

    func recordBackgroundRunGraceTaskExpired(taskID: UIBackgroundTaskIdentifier) {
        guard backgroundTurnGraceTaskID == taskID else {
            return
        }

        backgroundTurnGraceTaskID = .invalid
        backgroundTurnGraceExpiredUntilForeground = true
        debugSyncLog("background run grace task ended reason=expired")
    }

    func endBackgroundRunGraceTask(reason: String) {
        guard backgroundTurnGraceTaskID != .invalid else {
            return
        }

        let taskID = backgroundTurnGraceTaskID
        backgroundTurnGraceTaskID = .invalid
        UIApplication.shared.endBackgroundTask(taskID)
        debugSyncLog("background run grace task ended reason=\(reason)")
    }
}
