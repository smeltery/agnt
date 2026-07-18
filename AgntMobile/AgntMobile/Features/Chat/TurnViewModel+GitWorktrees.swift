// FILE: TurnViewModel+GitWorktrees.swift
// Purpose: Isolates git worktree creation, routing, and optimistic cache updates.
// Layer: View Model Extension
// Exports: TurnViewModel git worktree operations

import Foundation

extension TurnViewModel {
    func requestCreateGitWorktree(
        named rawName: String,
        fromBaseBranch rawBaseBranch: String,
        changeTransfer: GitWorktreeChangeTransferMode = .move,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?,
        onOpenWorktree: @escaping (GitCreateWorktreeResult) -> Void
    ) {
        let branchName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        let baseBranch = rawBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branchName.isEmpty, !baseBranch.isEmpty else { return }

        let operation = GitBranchUserOperation.createWorktree(
            branchName: branchName,
            baseBranch: baseBranch,
            changeTransfer: changeTransfer
        )
        if let alert = gitBranchAlert(for: operation) {
            enqueuePendingGitBranchOperation(
                operation,
                alert: alert,
                pendingWorktreeOpenHandler: onOpenWorktree
            )
            return
        }

        createGitWorktree(
            named: branchName,
            fromBaseBranch: baseBranch,
            changeTransfer: changeTransfer,
            codex: codex,
            workingDirectory: workingDirectory,
            threadID: threadID,
            activeTurnID: activeTurnID,
            onOpenWorktree: onOpenWorktree
        )
    }

    func requestCreateManagedGitWorktree(
        fromBaseBranch rawBaseBranch: String,
        changeTransfer: GitWorktreeChangeTransferMode = .move,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?,
        onOpenWorktree: @escaping (GitCreateManagedWorktreeResult) -> Void
    ) {
        let baseBranch = rawBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !baseBranch.isEmpty else { return }

        let operation = GitBranchUserOperation.createManagedWorktree(
            baseBranch: baseBranch,
            changeTransfer: changeTransfer
        )
        if let alert = gitBranchAlert(for: operation) {
            enqueuePendingGitBranchOperation(
                operation,
                alert: alert,
                pendingManagedGitWorktreeOpenHandler: onOpenWorktree
            )
            return
        }

        createManagedGitWorktree(
            fromBaseBranch: baseBranch,
            changeTransfer: changeTransfer,
            codex: codex,
            workingDirectory: workingDirectory,
            threadID: threadID,
            activeTurnID: activeTurnID,
            onOpenWorktree: onOpenWorktree
        )
    }

    func selectGitBaseBranch(_ branch: String) {
        selectedGitBaseBranch = branch
    }

    // Creates a managed worktree, then lets the caller route into the resulting thread.
    func createGitWorktree(
        named rawName: String,
        fromBaseBranch rawBaseBranch: String,
        changeTransfer: GitWorktreeChangeTransferMode = .move,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?,
        onOpenWorktree: @escaping (GitCreateWorktreeResult) -> Void
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard activeTurnID == nil,
                  !codex.runningThreadIDs.contains(threadID),
                  !self.isRunningGitAction,
                  !self.isSwitchingGitBranch,
                  !self.isCreatingGitWorktree else { return }

            let branchName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
            let baseBranch = rawBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !branchName.isEmpty, !baseBranch.isEmpty else { return }

            self.isCreatingGitWorktree = true
            defer { self.isCreatingGitWorktree = false }

            let gitService = GitActionsService(codex: codex, workingDirectory: workingDirectory)
            do {
                let result = try await gitService.createWorktree(
                    name: branchName,
                    baseBranch: baseBranch,
                    changeTransfer: changeTransfer
                )
                let resolvedBranch = result.branch.trimmingCharacters(in: .whitespacesAndNewlines)
                let resolvedWorktreePath = result.worktreePath.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !resolvedBranch.isEmpty, !resolvedWorktreePath.isEmpty else {
                    throw GitActionsError.invalidResponse
                }

                availableGitBranchTargets = Array(Set(availableGitBranchTargets + [resolvedBranch])).sorted()
                gitWorktreePathsByBranch[resolvedBranch] = resolvedWorktreePath
                gitBranchesCheckedOutElsewhere.insert(resolvedBranch)
                onOpenWorktree(result)
            } catch let error as GitActionsError {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Worktree Creation Failed",
                    message: error.errorDescription ?? "Could not create worktree.",
                    action: .dismissOnly
                )
            } catch {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Worktree Creation Failed",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    // Creates a detached managed worktree, then lets the caller route into the resulting thread.
    func createManagedGitWorktree(
        fromBaseBranch rawBaseBranch: String,
        changeTransfer: GitWorktreeChangeTransferMode = .move,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?,
        onOpenWorktree: @escaping (GitCreateManagedWorktreeResult) -> Void
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard activeTurnID == nil,
                  !codex.runningThreadIDs.contains(threadID),
                  !self.isRunningGitAction,
                  !self.isSwitchingGitBranch,
                  !self.isCreatingGitWorktree else { return }

            let baseBranch = rawBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !baseBranch.isEmpty else { return }

            self.isCreatingGitWorktree = true
            defer { self.isCreatingGitWorktree = false }

            let gitService = GitActionsService(codex: codex, workingDirectory: workingDirectory)
            do {
                let result = try await gitService.createManagedWorktree(
                    baseBranch: baseBranch,
                    changeTransfer: changeTransfer
                )
                let resolvedWorktreePath = result.worktreePath.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !resolvedWorktreePath.isEmpty else {
                    throw GitActionsError.invalidResponse
                }

                onOpenWorktree(result)
            } catch let error as GitActionsError {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Worktree Creation Failed",
                    message: error.errorDescription ?? "Could not create worktree.",
                    action: .dismissOnly
                )
            } catch {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Worktree Creation Failed",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    func worktreePathForCheckedOutElsewhereBranch(_ branch: String) -> String? {
        let trimmedBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBranch.isEmpty,
              gitBranchesCheckedOutElsewhere.contains(trimmedBranch) else {
            return nil
        }

        return gitWorktreePathsByBranch[trimmedBranch]
    }

    // Removes a failed managed worktree from the optimistic local branch cache until the next refresh arrives.
    func forgetGitWorktree(branch: String, worktreePath: String?) {
        let trimmedBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBranch.isEmpty else { return }

        availableGitBranchTargets.removeAll { $0 == trimmedBranch }
        gitBranchesCheckedOutElsewhere.remove(trimmedBranch)

        let trimmedPath = worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmedPath, !trimmedPath.isEmpty {
            let normalizedPath = TurnWorktreeRouting.comparableProjectPath(trimmedPath)
            if let existingPath = gitWorktreePathsByBranch[trimmedBranch],
               TurnWorktreeRouting.comparableProjectPath(existingPath) != normalizedPath {
                return
            }
        }

        gitWorktreePathsByBranch.removeValue(forKey: trimmedBranch)
    }
}
