// FILE: TurnViewModel+Git.swift
// Purpose: Git state and action availability helpers for TurnViewModel.
// Layer: View Model

import Foundation

extension TurnViewModel {
    enum GitBranchUserOperation: Equatable {
        case create(String)
        case switchTo(String)
        case createWorktree(
            branchName: String,
            baseBranch: String,
            changeTransfer: GitWorktreeChangeTransferMode
        )
        case createManagedWorktree(
            baseBranch: String,
            changeTransfer: GitWorktreeChangeTransferMode
        )
    }
    var isRunningGitAction: Bool { runningGitAction != nil }
    var gitSyncState: String? { gitRepoSync?.state }
    var isGitRepositoryInitialized: Bool { gitRepoSync?.isGitRepository == true }
    var disabledGitActions: Set<TurnGitActionKind> {
        var disabledActions: Set<TurnGitActionKind> = []
        if !canCreatePullRequest {
            disabledActions.insert(.createPR)
        }
        if !canCommitPushCreatePullRequest {
            disabledActions.insert(.commitPushCreatePR)
        }
        if gitRepoSync?.canPush != true {
            disabledActions.insert(.push)
        }
        if gitRepoSync?.hasPushRemote != true || !(gitRepoSync?.isDirty == true || gitRepoSync?.canPush == true) {
            disabledActions.insert(.commitAndPush)
        }
        if !canUpdateRepositoryFromRemote {
            disabledActions.insert(.syncNow)
        }
        return disabledActions
    }
    var canUpdateRepositoryFromRemote: Bool {
        guard let repoSync = gitRepoSync, repoSync.isGitRepository else {
            return false
        }

        // Normal Update is only for fast-forwardable remote work. Diverged branches
        // stay disabled here so the user must choose an explicit rebase/merge path.
        return ["behind_only", "dirty_and_behind"].contains(repoSync.state)
    }
    // Keeps PR creation tied to live Git state instead of chat-local remembered branch state.
    var createPullRequestValidationMessage: String? {
        guard let repoSync = gitRepoSync else {
            return "Git status is still loading. Wait a moment and retry."
        }

        let branch = (repoSync.currentBranch ?? currentGitBranch).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branch.isEmpty else {
            return "No current branch found."
        }

        let defaultBranch = gitDefaultBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !defaultBranch.isEmpty else {
            return "Could not determine the repository default branch."
        }

        guard branch != defaultBranch else {
            return "Switch to a feature branch before creating a PR."
        }

        guard !repoSync.isDirty else {
            return "Commit local changes before creating a PR."
        }

        guard repoSync.hasPushRemote else {
            return "Add a Git remote before creating a PR."
        }

        guard repoSync.behindCount == 0 else {
            return "Pull remote changes before creating a PR."
        }

        return nil
    }
    var canCreatePullRequest: Bool { createPullRequestValidationMessage == nil }
    var canCommitPushCreatePullRequest: Bool {
        guard let repoSync = gitRepoSync, repoSync.isGitRepository else {
            return false
        }

        let branch = (repoSync.currentBranch ?? currentGitBranch).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branch.isEmpty,
              !gitDefaultBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              repoSync.hasPushRemote,
              repoSync.behindCount == 0
        else {
            return false
        }

        return repoSync.isDirty || repoSync.aheadCount > 0 || !repoSync.isPublishedToRemote
    }
    var localSelectableGitDefaultBranch: String? {
        agntSelectableDefaultBranch(
            defaultBranch: gitDefaultBranch,
            availableGitBranchTargets: availableGitBranchTargets
        )
    }
    var shouldShowDiscardRuntimeChangesAndSync: Bool {
        guard let sync = gitRepoSync else { return false }
        let dangerousStates = ["dirty", "dirty_and_behind", "diverged"]
        return dangerousStates.contains(sync.state) || (sync.isDirty && sync.state == "no_upstream")
    }

    // Keeps git mutations scoped to an explicitly bound local repo. Repo-level
    // write actions can opt out of the idle-turn gate; branch/worktree routing keeps it.
    func canRunGitAction(
        isConnected: Bool,
        isThreadRunning: Bool,
        hasGitWorkingDirectory: Bool,
        requiresIdleThread: Bool = true
    ) -> Bool {
        isConnected
            && hasGitWorkingDirectory
            && (!requiresIdleThread || !isThreadRunning)
            && !isRunningGitAction
            && !isSwitchingGitBranch
            && !isCreatingGitWorktree
    }

}
