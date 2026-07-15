// FILE: TurnViewModel+GitBranchAlerts.swift
// Purpose: Handles git branch/worktree preflight alerts and deferred alert actions.
// Layer: View Model Extension
// Exports: TurnViewModel git sync alert operations

import Foundation

private struct GitBranchAlertState {
    let currentBranch: String
    let defaultBranch: String
    let isDirty: Bool
    let localOnlyCommitCount: Int
    let dirtyFiles: [GitChangedFile]

    private var onDefaultBranch: Bool {
        !currentBranch.isEmpty && currentBranch == defaultBranch
    }

    func alert(for operation: TurnViewModel.GitBranchUserOperation) -> TurnGitSyncAlert? {
        switch operation {
        case .create(let branchName):
            if isDirty {
                return TurnGitSyncAlert(
                    title: "Bring local changes to '\(branchName)'?",
                    message: newBranchDirtyAlertMessage(branchName: branchName),
                    buttons: [
                        TurnGitSyncAlertButton(title: "Cancel", role: .cancel, action: .dismissOnly),
                        TurnGitSyncAlertButton(
                            title: "Carry to New Branch",
                            role: nil,
                            action: .continueGitBranchOperation
                        ),
                        TurnGitSyncAlertButton(
                            title: "Commit, Create & Switch",
                            role: nil,
                            action: .commitAndContinueGitBranchOperation
                        )
                    ]
                )
            }

            if onDefaultBranch && localOnlyCommitCount > 0 {
                let commitLabel = localOnlyCommitCount == 1 ? "1 local commit" : "\(localOnlyCommitCount) local commits"
                var message = "\(defaultBranch) already has \(commitLabel) that are not on the remote. Creating '\(branchName)' now starts the new branch from the current HEAD, but those commits stay in \(defaultBranch)'s history."
                if isDirty {
                    message += " Uncommitted changes also stay in this working copy and will follow onto the new branch after checkout."
                }
                return TurnGitSyncAlert(
                    title: "Local commits stay on \(defaultBranch)",
                    message: message,
                    buttons: [
                        TurnGitSyncAlertButton(title: "Cancel", role: .cancel, action: .dismissOnly),
                        TurnGitSyncAlertButton(title: "Create Anyway", role: nil, action: .continueGitBranchOperation)
                    ]
                )
            }

            return nil

        case .createWorktree(let branchName, let baseBranch, let changeTransfer):
            return worktreeAlert(
                titleNoun: "'\(branchName)'",
                worktreeNoun: "the new worktree",
                baseBranch: baseBranch,
                changeTransfer: changeTransfer,
                createMessage: "Creating '\(branchName)' can %@ local changes only from the current branch. Switch the base branch to '\(currentBranch)' or clean up local changes before creating the worktree."
            )

        case .createManagedWorktree(let baseBranch, let changeTransfer):
            return worktreeAlert(
                titleNoun: "a managed worktree",
                worktreeNoun: "the managed worktree",
                baseBranch: baseBranch,
                changeTransfer: changeTransfer,
                createMessage: "Creating a managed worktree can %@ local changes only from the current branch. Switch the base branch to '\(currentBranch)' or clean up local changes before creating the worktree."
            )

        case .switchTo(let branchName):
            _ = branchName
            return nil
        }
    }

    // Reuses the same branch/base-branch warnings for standard and managed worktree creation.
    private func worktreeAlert(
        titleNoun: String,
        worktreeNoun: String,
        baseBranch: String,
        changeTransfer: GitWorktreeChangeTransferMode,
        createMessage: String
    ) -> TurnGitSyncAlert? {
        if isDirty && changeTransfer != .none && currentBranch != baseBranch {
            let transferVerb = changeTransfer.transferVerb ?? "move"
            return TurnGitSyncAlert(
                title: "\(transferVerb.capitalized) local changes from the current branch",
                message: createMessage.replacingOccurrences(of: "%@", with: transferVerb),
                action: .dismissOnly
            )
        }

        if onDefaultBranch && currentBranch == baseBranch && localOnlyCommitCount > 0 {
            let commitLabel = localOnlyCommitCount == 1 ? "1 local commit" : "\(localOnlyCommitCount) local commits"
            let dirtySuffix: String
            if isDirty, changeTransfer == .move {
                dirtySuffix = " Local changes will move into \(worktreeNoun); ignored files stay here."
            } else if isDirty, changeTransfer == .copy {
                dirtySuffix = " Local changes will also be copied into \(worktreeNoun); ignored files stay here."
            } else {
                dirtySuffix = ""
            }
            return TurnGitSyncAlert(
                title: "Local commits stay on \(defaultBranch)",
                message: "\(defaultBranch) already has \(commitLabel) that are not on the remote. Creating \(titleNoun) from \(baseBranch) starts from the current HEAD, but those commits stay in \(defaultBranch)'s history too.\(dirtySuffix)",
                buttons: [
                    TurnGitSyncAlertButton(title: "Cancel", role: .cancel, action: .dismissOnly),
                    TurnGitSyncAlertButton(title: "Create Anyway", role: nil, action: .continueGitBranchOperation)
                ]
            )
        }

        return nil
    }

    private func dirtyBranchAlertMessage(intro: String) -> String {
        guard !dirtyFiles.isEmpty else {
            return intro
        }

        let previewFiles = dirtyFiles.prefix(3).map(\.path)
        let fileLines = previewFiles.map { "• \($0)" }.joined(separator: "\n")
        let remainingCount = dirtyFiles.count - previewFiles.count
        let overflowLine = remainingCount > 0 ? "\n• +\(remainingCount) more files" : ""

        return "\(intro)\n\nFiles with local changes:\n\(fileLines)\(overflowLine)"
    }

    private func newBranchDirtyAlertMessage(branchName: String) -> String {
        let sourceBranch = currentBranch.isEmpty ? "the current branch" : currentBranch
        var intro = "You're creating '\(branchName)' from \(sourceBranch). Carry your local changes onto the new branch, or commit first and then create + switch."

        if !defaultBranch.isEmpty,
           sourceBranch == defaultBranch,
           localOnlyCommitCount > 0 {
            let commitLabel = localOnlyCommitCount == 1 ? "1 local commit" : "\(localOnlyCommitCount) local commits"
            intro = "\(defaultBranch) already has \(commitLabel) that are not on the remote. Those commits stay on \(defaultBranch)'s history. " + intro
        }

        return dirtyBranchAlertMessage(intro: intro)
    }
}

// Packages the deferred operation and its callbacks so alert-confirmed actions can resume from one place.
private struct PendingGitBranchOperationState {
    let operation: TurnViewModel.GitBranchUserOperation?
    let worktreeOpenHandler: ((GitCreateWorktreeResult) -> Void)?
    let managedWorktreeOpenHandler: ((GitCreateManagedWorktreeResult) -> Void)?
}

extension TurnViewModel {
    func dismissGitSyncAlert() {
        clearPendingGitBranchOperationState()
    }

    func confirmGitSyncAlertAction(
        _ alertAction: TurnGitSyncAlertAction,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?
    ) {
        let pendingOperationState = capturePendingGitBranchOperationState()
        clearPendingGitBranchOperationState()

        switch alertAction {
        case .dismissOnly:
            return
        case .pullRebase:
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard activeTurnID == nil,
                      !codex.runningThreadIDs.contains(threadID),
                      !self.isRunningGitAction,
                      !self.isSwitchingGitBranch else { return }

                self.runningGitAction = .syncNow
                defer { self.runningGitAction = nil }

                let gitService = GitActionsService(codex: codex, workingDirectory: workingDirectory)
                do {
                    let result = try await gitService.pull()
                    if let status = result.status {
                        applyGitRepoSync(status)
                    }
                } catch {
                    gitSyncAlert = TurnGitSyncAlert(
                        title: "Pull Failed",
                        message: error.localizedDescription,
                        action: .dismissOnly
                    )
                }
            }
        case .continueGitBranchOperation:
            continueGitBranchOperation(
                pendingOperationState,
                codex: codex,
                workingDirectory: workingDirectory,
                threadID: threadID,
                activeTurnID: activeTurnID
            )
        case .commitAndContinueGitBranchOperation:
            guard pendingOperationState.operation != nil else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard activeTurnID == nil,
                      !codex.runningThreadIDs.contains(threadID),
                      !self.isRunningGitAction,
                      !self.isSwitchingGitBranch,
                      !self.isCreatingGitWorktree else { return }

                self.runningGitAction = .commit
                defer { self.runningGitAction = nil }

                let gitService = GitActionsService(codex: codex, workingDirectory: workingDirectory)
                do {
                    _ = try await gitService.commit(message: "WIP before switching branches")
                    if let statusAfter = try? await gitService.status() {
                        applyGitRepoSync(statusAfter)
                    }

                    continueGitBranchOperation(
                        pendingOperationState,
                        codex: codex,
                        workingDirectory: workingDirectory,
                        threadID: threadID,
                        activeTurnID: activeTurnID
                    )
                } catch {
                    gitSyncAlert = TurnGitSyncAlert(
                        title: "Commit Failed",
                        message: error.localizedDescription,
                        action: .dismissOnly
                    )
                }
            }
        case .discardRuntimeChanges:
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard activeTurnID == nil,
                      !codex.runningThreadIDs.contains(threadID),
                      !self.isRunningGitAction,
                      !self.isSwitchingGitBranch,
                      !self.isCreatingGitWorktree else { return }

                self.runningGitAction = .discardRuntimeChangesAndSync
                defer { self.runningGitAction = nil }

                let gitService = GitActionsService(codex: codex, workingDirectory: workingDirectory)
                do {
                    let result = try await gitService.resetToRemote()
                    if let status = result.status {
                        applyGitRepoSync(status)
                    }
                } catch {
                    gitSyncAlert = TurnGitSyncAlert(
                        title: "Discard Failed",
                        message: error.localizedDescription,
                        action: .dismissOnly
                    )
                }
            }
        }
    }

    func gitBranchAlert(for operation: GitBranchUserOperation) -> TurnGitSyncAlert? {
        let alertState = GitBranchAlertState(
            currentBranch: currentGitBranch.trimmingCharacters(in: .whitespacesAndNewlines),
            defaultBranch: gitDefaultBranch.trimmingCharacters(in: .whitespacesAndNewlines),
            isDirty: gitRepoSync?.isDirty ?? false,
            localOnlyCommitCount: gitRepoSync?.localOnlyCommitCount ?? 0,
            dirtyFiles: gitRepoSync?.files ?? []
        )
        return alertState.alert(for: operation)
    }


    // Runs the deferred branch/worktree action after an alert-confirmed preflight step.
    private func continueGitBranchOperation(
        _ pendingOperationState: PendingGitBranchOperationState,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?
    ) {
        guard let pendingBranchOperation = pendingOperationState.operation else { return }

        switch pendingBranchOperation {
        case .create(let branchName):
            createGitBranch(
                named: branchName,
                codex: codex,
                workingDirectory: workingDirectory,
                threadID: threadID,
                activeTurnID: activeTurnID
            )
        case .switchTo(let branchName):
            switchGitBranch(
                to: branchName,
                codex: codex,
                workingDirectory: workingDirectory,
                threadID: threadID,
                activeTurnID: activeTurnID
            )
        case .createWorktree(let branchName, let baseBranch, let changeTransfer):
            guard let pendingWorktreeOpenHandler = pendingOperationState.worktreeOpenHandler else { return }
            createGitWorktree(
                named: branchName,
                fromBaseBranch: baseBranch,
                changeTransfer: changeTransfer,
                codex: codex,
                workingDirectory: workingDirectory,
                threadID: threadID,
                activeTurnID: activeTurnID,
                onOpenWorktree: pendingWorktreeOpenHandler
            )
        case .createManagedWorktree(let baseBranch, let changeTransfer):
            guard let pendingManagedGitWorktreeOpenHandler = pendingOperationState.managedWorktreeOpenHandler else { return }
            createManagedGitWorktree(
                fromBaseBranch: baseBranch,
                changeTransfer: changeTransfer,
                codex: codex,
                workingDirectory: workingDirectory,
                threadID: threadID,
                activeTurnID: activeTurnID,
                onOpenWorktree: pendingManagedGitWorktreeOpenHandler
            )
        }
    }

    func enqueuePendingGitBranchOperation(
        _ operation: GitBranchUserOperation,
        alert: TurnGitSyncAlert,
        pendingWorktreeOpenHandler: ((GitCreateWorktreeResult) -> Void)? = nil,
        pendingManagedGitWorktreeOpenHandler: ((GitCreateManagedWorktreeResult) -> Void)? = nil
    ) {
        pendingGitBranchOperation = operation
        self.pendingGitWorktreeOpenHandler = pendingWorktreeOpenHandler
        self.pendingManagedGitWorktreeOpenHandler = pendingManagedGitWorktreeOpenHandler
        gitSyncAlert = alert
    }

    private func capturePendingGitBranchOperationState() -> PendingGitBranchOperationState {
        PendingGitBranchOperationState(
            operation: pendingGitBranchOperation,
            worktreeOpenHandler: pendingGitWorktreeOpenHandler,
            managedWorktreeOpenHandler: pendingManagedGitWorktreeOpenHandler
        )
    }

    private func clearPendingGitBranchOperationState() {
        gitSyncAlert = nil
        pendingGitBranchOperation = nil
        pendingGitWorktreeOpenHandler = nil
        pendingManagedGitWorktreeOpenHandler = nil
    }
}
