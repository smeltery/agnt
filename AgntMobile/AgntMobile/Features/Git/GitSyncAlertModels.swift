// FILE: GitSyncAlertModels.swift
// Purpose: Alert models for git sync and branch/worktree confirmation flows.
// Layer: Model
// Exports: TurnGitSyncAlert, TurnGitSyncAlertButton, TurnGitSyncAlertButtonRole, TurnGitSyncAlertAction
// Depends on: Foundation

import Foundation

struct TurnGitSyncAlert: Identifiable {
    let id = UUID()
    let title: String
    let message: String
    let buttons: [TurnGitSyncAlertButton]

    init(title: String, message: String, action: TurnGitSyncAlertAction) {
        self.title = title
        self.message = message
        self.buttons = TurnGitSyncAlertButton.defaultButtons(for: action)
    }

    init(title: String, message: String, buttons: [TurnGitSyncAlertButton]) {
        self.title = title
        self.message = message
        self.buttons = buttons
    }
}

struct TurnGitSyncAlertButton: Identifiable, Sendable {
    let id = UUID()
    let title: String
    let role: TurnGitSyncAlertButtonRole?
    let action: TurnGitSyncAlertAction

    // Keeps alert construction declarative while centralizing the button/action wiring.
    static func defaultButtons(for action: TurnGitSyncAlertAction) -> [TurnGitSyncAlertButton] {
        switch action {
        case .dismissOnly:
            return [
                TurnGitSyncAlertButton(title: "OK", role: .cancel, action: .dismissOnly)
            ]
        case .pullRebase:
            return [
                TurnGitSyncAlertButton(title: "Cancel", role: .cancel, action: .dismissOnly),
                TurnGitSyncAlertButton(title: "Pull & Rebase", role: nil, action: .pullRebase)
            ]
        case .continueGitBranchOperation:
            return [
                TurnGitSyncAlertButton(title: "Cancel", role: .cancel, action: .dismissOnly),
                TurnGitSyncAlertButton(title: "Continue", role: nil, action: .continueGitBranchOperation)
            ]
        case .commitAndContinueGitBranchOperation:
            return [
                TurnGitSyncAlertButton(title: "Cancel", role: .cancel, action: .dismissOnly),
                TurnGitSyncAlertButton(title: "Commit & Continue", role: nil, action: .commitAndContinueGitBranchOperation)
            ]
        case .discardRuntimeChanges:
            return [
                TurnGitSyncAlertButton(title: "Cancel", role: .cancel, action: .dismissOnly),
                TurnGitSyncAlertButton(title: "Discard Local Changes", role: .destructive, action: .discardRuntimeChanges)
            ]
        }
    }
}

enum TurnGitSyncAlertButtonRole: Sendable {
    case cancel
    case destructive
}

enum TurnGitSyncAlertAction: Equatable, Sendable {
    case dismissOnly
    case pullRebase
    case continueGitBranchOperation
    case commitAndContinueGitBranchOperation
    case discardRuntimeChanges
}
