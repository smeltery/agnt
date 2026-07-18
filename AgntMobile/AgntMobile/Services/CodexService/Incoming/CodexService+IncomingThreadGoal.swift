// FILE: CodexService+IncomingThreadGoal.swift
// Purpose: Handles incoming thread goal notifications.
// Layer: Service
// Exports: CodexService thread goal notification handlers
// Depends on: CodexService, CodexThreadGoal

import Foundation

extension CodexService {
    func handleThreadGoalUpdated(_ paramsObject: IncomingParamsObject?) {
        guard let goal = CodexThreadGoal(object: paramsObject?["goal"]?.objectValue) else {
            return
        }
        goalByThreadID[goal.threadId] = goal
    }

    func handleThreadGoalCleared(_ paramsObject: IncomingParamsObject?) {
        guard let threadId = paramsObject?["threadId"]?.stringValue, !threadId.isEmpty else {
            return
        }
        goalByThreadID.removeValue(forKey: threadId)
    }
}
