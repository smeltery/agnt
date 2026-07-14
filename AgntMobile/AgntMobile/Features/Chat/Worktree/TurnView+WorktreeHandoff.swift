// FILE: TurnView+WorktreeHandoff.swift
// Purpose: Owns worktree handoff and fork orchestration for the turn screen.
// Layer: View Coordination
// Exports: TurnView worktree handoff helpers
// Depends on: SwiftUI, CodexService, TurnViewModel, WorktreeFlowCoordinator

import SwiftUI

extension TurnView {
    // Reuses the same running-thread gate as Stop/Git actions so worktree handoff never races a live run.
    func isWorktreeHandoffAvailable(
        isThreadRunning: Bool,
        gitWorkingDirectory: String?
    ) -> Bool {
        viewModel.isGitRepositoryInitialized && canRunGitAction(
            isThreadRunning: isThreadRunning,
            gitWorkingDirectory: gitWorkingDirectory
        )
    }

    // Centralizes the toolbar/composer availability rule so both entry points stay aligned.
    func canHandOffToWorktree(
        isThreadRunning: Bool,
        gitWorkingDirectory: String?
    ) -> Bool {
        isWorktreeHandoffAvailable(
            isThreadRunning: isThreadRunning,
            gitWorkingDirectory: gitWorkingDirectory
        ) && !viewModel.isCreatingGitWorktree
    }

    func handleWorktreeHandoffTap(currentThread: CodexThread) {
        if currentThread.isManagedWorktreeProject {
            Task { @MainActor in
                do {
                    let move = try await WorktreeFlowCoordinator.handoffThreadToLocal(
                        thread: currentThread,
                        codex: codex
                    )
                    viewModel.refreshGitBranchTargets(
                        codex: codex,
                        workingDirectory: move.projectPath,
                        threadID: thread.id
                    )
                } catch {
                    viewModel.gitSyncAlert = TurnGitSyncAlert(
                        title: "Local Handoff Failed",
                        message: error.localizedDescription.isEmpty
                            ? "Could not hand off the thread back to Local."
                            : error.localizedDescription,
                        action: .dismissOnly
                    )
                }
            }
            return
        }

        guard let associatedWorktreePath = codex.associatedManagedWorktreePath(for: thread.id) else {
            isShowingWorktreeHandoff = true
            return
        }

        Task { @MainActor in
            viewModel.isCreatingGitWorktree = true
            defer { viewModel.isCreatingGitWorktree = false }

            do {
                let outcome = try await WorktreeFlowCoordinator.handoffThreadToWorktree(
                    threadID: thread.id,
                    sourceProjectPath: currentThread.gitWorkingDirectory,
                    associatedWorktreePath: associatedWorktreePath,
                    codex: codex
                )

                switch outcome {
                case .moved(let move):
                    viewModel.refreshGitBranchTargets(
                        codex: codex,
                        workingDirectory: move.projectPath,
                        threadID: thread.id
                    )
                case .missingAssociatedWorktree:
                    isShowingWorktreeHandoff = true
                }
            } catch {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: "Worktree Handoff Failed",
                    message: error.localizedDescription.isEmpty
                        ? "Could not hand off the thread to the new worktree."
                        : error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    // Shares the same default base branch between the toolbar overlay and the empty-thread Local menu.
    var preferredWorktreeBaseBranch: String {
        let currentBranch = viewModel.currentGitBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        if !currentBranch.isEmpty {
            return currentBranch
        }

        let selectedBaseBranch = viewModel.selectedGitBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        if !selectedBaseBranch.isEmpty {
            return selectedBaseBranch
        }
        return viewModel.gitDefaultBranch
    }

    // Creates a named worktree, then rebinds this same chat to that checkout.
    func submitWorktreeHandoff(
        branchName: String,
        baseBranch: String,
        gitWorkingDirectory: String?,
        activeTurnID: String?
    ) {
        viewModel.requestCreateGitWorktree(
            named: branchName,
            fromBaseBranch: baseBranch,
            changeTransfer: .none,
            codex: codex,
            workingDirectory: gitWorkingDirectory,
            threadID: thread.id,
            activeTurnID: activeTurnID,
            onOpenWorktree: { result in
                guard !result.alreadyExisted else {
                    viewModel.gitSyncAlert = TurnGitSyncAlert(
                        title: "Branch Already Exists",
                        message: "A worktree for '\(result.branch)' already exists. Choose a different name.",
                        action: .dismissOnly
                    )
                    return
                }

                Task { @MainActor in
                    do {
                        let outcome = try await WorktreeFlowCoordinator.handoffThreadToWorktree(
                            threadID: thread.id,
                            sourceProjectPath: gitWorkingDirectory,
                            associatedWorktreePath: result.worktreePath,
                            codex: codex
                        )

                        if case .moved(let move) = outcome {
                            isShowingWorktreeHandoff = false
                            viewModel.refreshGitBranchTargets(
                                codex: codex,
                                workingDirectory: move.projectPath,
                                threadID: thread.id
                            )
                        }
                    } catch {
                        viewModel.gitSyncAlert = TurnGitSyncAlert(
                            title: "Worktree Handoff Failed",
                            message: error.localizedDescription.isEmpty
                                ? "Could not hand off the thread to the new worktree."
                                : error.localizedDescription,
                            action: .dismissOnly
                        )
                    }
                }
            }
        )
    }

    // Forks the current conversation into the Local checkout when possible.
    func startLocalFork() {
        Task { @MainActor in
            guard !isForkingThread else { return }
            let sourceThread = currentResolvedThread
            guard WorktreeFlowCoordinator.localForkProjectPath(
                for: sourceThread,
                localCheckoutPath: viewModel.gitLocalCheckoutPath
            ) != nil else {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: "Local Fork Unavailable",
                    message: sourceThread.isManagedWorktreeProject
                        ? "Could not resolve the Local checkout for this worktree thread."
                        : "Could not resolve the local project path for this thread.",
                    action: .dismissOnly
                )
                return
            }
            isForkingThread = true
            defer { isForkingThread = false }

            do {
                let forkedThread = try await WorktreeFlowCoordinator.forkThreadToLocal(
                    sourceThread: sourceThread,
                    localCheckoutPath: viewModel.gitLocalCheckoutPath,
                    codex: codex
                )
                openThread(forkedThread.id)
            } catch {
                if let message = codex.userFacingTurnErrorMessageForFooter(from: error),
                   codex.lastErrorMessage?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true {
                    codex.lastErrorMessage = message
                }
            }
        }
    }

    // Creates a named worktree, then forks the conversation into that checkout.
    func submitForkIntoNewWorktree(
        branchName: String,
        baseBranch: String,
        gitWorkingDirectory: String?,
        activeTurnID: String?
    ) {
        viewModel.requestCreateGitWorktree(
            named: branchName,
            fromBaseBranch: baseBranch,
            changeTransfer: .none,
            codex: codex,
            workingDirectory: gitWorkingDirectory,
            threadID: thread.id,
            activeTurnID: activeTurnID,
            onOpenWorktree: { result in
                guard !result.alreadyExisted else {
                    viewModel.gitSyncAlert = TurnGitSyncAlert(
                        title: "Branch Already Exists",
                        message: "A worktree for '\(result.branch)' already exists. Choose a different name.",
                        action: .dismissOnly
                    )
                    return
                }

                isForkingThread = true
                Task { @MainActor in
                    defer { isForkingThread = false }

                    do {
                        let forkedThread = try await codex.forkThreadIfReady(
                            from: thread.id,
                            target: .projectPath(result.worktreePath)
                        )
                        isShowingForkWorktree = false
                        openThread(forkedThread.id)
                    } catch {
                        viewModel.gitSyncAlert = TurnGitSyncAlert(
                            title: "Worktree Fork Failed",
                            message: error.localizedDescription.isEmpty
                                ? "Could not fork the thread into the new worktree."
                                : error.localizedDescription,
                            action: .dismissOnly
                        )
                    }
                }
            }
        )
    }
}
