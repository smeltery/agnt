// FILE: TurnViewModel+GitBranchWorktree.swift
// Purpose: Isolates branch/worktree routing and preflight flows from the main TurnViewModel file.
// Layer: View Model Extension
// Exports: TurnViewModel git branch/worktree operations

import Foundation


extension TurnViewModel {
    func refreshGitBranchTargets(codex: CodexService, workingDirectory: String?, threadID: String) {
        guard !isLoadingGitBranchTargets else { return }
        isLoadingGitBranchTargets = true

        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.isLoadingGitBranchTargets = false }

            let gitService = GitActionsService(codex: codex, workingDirectory: workingDirectory)
            do {
                let result = try await gitService.branchesWithStatus()
                applyGitBranchTargets(result)
                if let status = result.status {
                    applyObservedGitRepoSync(
                        status,
                        codex: codex,
                        workingDirectory: workingDirectory,
                        threadID: threadID
                    )
                }
            } catch {
                // Silently fail — branches will just be empty.
            }
        }
    }

    // Adds preflight confirmations for dirty checkouts and the special case of local commits already on main.
    func requestCreateGitBranch(
        named rawName: String,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?
    ) {
        let branchName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branchName.isEmpty else { return }

        let operation = GitBranchUserOperation.create(branchName)
        if let alert = gitBranchAlert(for: operation) {
            enqueuePendingGitBranchOperation(operation, alert: alert)
            return
        }

        createGitBranch(
            named: branchName,
            codex: codex,
            workingDirectory: workingDirectory,
            threadID: threadID,
            activeTurnID: activeTurnID
        )
    }

    // Creates a new branch, checks it out, and refreshes the visible branch targets.
    func createGitBranch(
        named rawName: String,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard activeTurnID == nil,
                  !codex.runningThreadIDs.contains(threadID),
                  !self.isRunningGitAction,
                  !self.isSwitchingGitBranch else { return }

            let branchName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !branchName.isEmpty else { return }

            self.isSwitchingGitBranch = true
            defer { self.isSwitchingGitBranch = false }

            let gitService = GitActionsService(codex: codex, workingDirectory: workingDirectory)
            do {
                let createResult = try await gitService.createBranch(name: branchName)
                currentGitBranch = createResult.branch
                if let status = createResult.status {
                    applyGitRepoSync(status)
                }
            } catch let error as GitActionsError {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Branch Creation Failed",
                    message: error.errorDescription ?? "Could not create branch.",
                    action: .dismissOnly
                )
                return
            } catch {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Branch Creation Failed",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
                return
            }

            do {
                let branchesResult = try await gitService.branchesWithStatus()
                applyGitBranchTargets(branchesResult)
                if let status = branchesResult.status {
                    applyGitRepoSync(status)
                }
            } catch {
                // The branch may already be created and checked out; keep the optimistic local state.
                availableGitBranchTargets = Array(Set(availableGitBranchTargets + [branchName])).sorted()
            }
        }
    }

    // Debounces repo status refreshes so live file-change streams can update the topbar safely.
    func scheduleGitStatusRefresh(codex: CodexService, workingDirectory: String?, threadID: String) {
        gitStatusRefreshTask?.cancel()
        gitStatusRefreshTask = Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                try await Task.sleep(nanoseconds: gitStatusRefreshDebounceNanoseconds)
            } catch {
                return
            }

            let gitService = GitActionsService(codex: codex, workingDirectory: workingDirectory)
            do {
                let result = try await gitService.status()
                applyObservedGitRepoSync(
                    result,
                    codex: codex,
                    workingDirectory: workingDirectory,
                    threadID: threadID
                )
            } catch {
                // Non-fatal: the next lifecycle refresh/manual action can recover the badge.
            }
        }
    }

    func requestSwitchGitBranch(
        to branch: String,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?
    ) {
        let trimmedBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBranch.isEmpty else { return }

        if gitBranchesCheckedOutElsewhere.contains(trimmedBranch) {
            gitSyncAlert = TurnGitSyncAlert(
                title: "Branch Switch Failed",
                message: "Cannot switch branches: this branch is already open in another worktree.",
                action: .dismissOnly
            )
            return
        }

        let operation = GitBranchUserOperation.switchTo(trimmedBranch)
        if let alert = gitBranchAlert(for: operation) {
            pendingGitBranchOperation = operation
            gitSyncAlert = alert
            return
        }

        switchGitBranch(
            to: trimmedBranch,
            codex: codex,
            workingDirectory: workingDirectory,
            threadID: threadID,
            activeTurnID: activeTurnID
        )
    }

    func switchGitBranch(
        to branch: String,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard activeTurnID == nil,
                  !codex.runningThreadIDs.contains(threadID),
                  !self.isRunningGitAction,
                  !self.isSwitchingGitBranch else { return }

            if gitBranchesCheckedOutElsewhere.contains(branch) {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Branch Switch Failed",
                    message: "Cannot switch branches: this branch is already open in another worktree.",
                    action: .dismissOnly
                )
                return
            }

            self.isSwitchingGitBranch = true
            defer { self.isSwitchingGitBranch = false }

            let gitService = GitActionsService(codex: codex, workingDirectory: workingDirectory)
            do {
                let result = try await gitService.checkout(branch: branch)
                currentGitBranch = result.currentBranch
                if let status = result.status {
                    applyGitRepoSync(status)
                }
            } catch let error as GitActionsError {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Branch Switch Failed",
                    message: error.errorDescription ?? "Could not switch branch.",
                    action: .dismissOnly
                )
            } catch {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Branch Switch Failed",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    func applyGitRepoSync(_ result: GitRepoSyncResult) {
        gitRepoSync = result
        guard result.isGitRepository else {
            currentGitBranch = ""
            availableGitBranchTargets = []
            gitBranchesCheckedOutElsewhere = []
            gitWorktreePathsByBranch = [:]
            gitLocalCheckoutPath = nil
            gitDefaultBranch = ""
            selectedGitBaseBranch = ""
            return
        }

        if let branch = result.currentBranch, !branch.isEmpty {
            currentGitBranch = branch
        }
    }

    // Keeps repo totals fresh and resets the per-chat sidebar badge after a manual push.
    func handleSuccessfulPush(
        _ result: GitPushResult,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String
    ) {
        if let status = result.status {
            applyGitRepoSync(status)
        }

        codex.appendHiddenPushResetMarkers(
            threadId: threadID,
            workingDirectory: workingDirectory,
            branch: result.branch,
            remote: result.remote
        )
    }

    // Mirrors push side effects for bridge-orchestrated stacked Git actions.
    func handleSuccessfulStackedGitAction(
        _ result: GitStackedActionResult,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String
    ) {
        if let status = result.status {
            applyGitRepoSync(status)
        }

        guard let push = result.push else { return }
        codex.appendHiddenPushResetMarkers(
            threadId: threadID,
            workingDirectory: workingDirectory,
            branch: push.branch,
            remote: push.remote
        )
    }

    // Applies branch metadata without overwriting an explicit PR base the user already chose.
    func applyGitBranchTargets(_ result: GitBranchesWithStatusResult) {
        availableGitBranchTargets = result.branches
        gitBranchesCheckedOutElsewhere = result.branchesCheckedOutElsewhere
        gitWorktreePathsByBranch = result.worktreePathByBranch
        gitLocalCheckoutPath = CodexThreadStartProjectBinding.normalizedProjectPath(result.localCheckoutPath)
        if let current = result.currentBranch, !current.isEmpty {
            currentGitBranch = current
        }
        if let defaultBranch = result.defaultBranch, !defaultBranch.isEmpty {
            gitDefaultBranch = defaultBranch
            let currentSelectedBaseBranch = selectedGitBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
            let localDefaultBranch = agntSelectableDefaultBranch(
                defaultBranch: defaultBranch,
                availableGitBranchTargets: result.branches
            ) ?? ""
            let isValidSelectedBaseBranch = currentSelectedBaseBranch.isEmpty
                || result.branches.contains(currentSelectedBaseBranch)

            if !isValidSelectedBaseBranch {
                selectedGitBaseBranch = localDefaultBranch
            } else if currentSelectedBaseBranch.isEmpty {
                selectedGitBaseBranch = localDefaultBranch
            }
        }
    }
}

private extension TurnViewModel {
    func applyObservedGitRepoSync(
        _ result: GitRepoSyncResult,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String
    ) {
        let previousSync = gitRepoSync
        applyGitRepoSync(result)

        guard let previousSync else {
            return
        }

        let branchStayedStable = previousSync.currentBranch == result.currentBranch
        let didClearAheadQueue = previousSync.aheadCount > 0 && result.aheadCount == 0
        guard branchStayedStable, didClearAheadQueue else {
            return
        }

        codex.appendHiddenPushResetMarkers(
            threadId: threadID,
            workingDirectory: workingDirectory,
            branch: result.currentBranch ?? "",
            remote: trackingRemoteName(from: result.trackingBranch)
        )
    }

    func trackingRemoteName(from trackingBranch: String?) -> String? {
        guard let trackingBranch else {
            return nil
        }

        let trimmed = trackingBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        return trimmed.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init)
    }

}
