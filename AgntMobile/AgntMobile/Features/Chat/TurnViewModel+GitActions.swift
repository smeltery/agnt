// FILE: TurnViewModel+GitActions.swift
// Purpose: Isolates git action orchestration from the main TurnViewModel file.
// Layer: View Model Extension
// Exports: TurnViewModel git actions

import SwiftUI

extension TurnViewModel {
    func triggerGitAction(
        _ action: TurnGitActionKind,
        codex: CodexService,
        workingDirectory: String?,
        threadID: String,
        activeTurnID: String?
    ) {
        guard !isRunningGitAction else { return }
        runningGitAction = action
        gitActionLoadingTitle = action.loadingTitle(repoSync: gitRepoSync)

        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.runningGitAction = nil
                self.gitActionLoadingTitle = nil
                self.inlineCommitAndPushPhase = nil
            }

            let gitService = GitActionsService(codex: codex, workingDirectory: workingDirectory)
            let gitWriterModel = codex.gitWriterModelIdentifier()

            do {
                switch action {
                case .initialize:
                    let result = try await gitService.initializeRepository()
                    if let status = result.status {
                        applyGitRepoSync(status)
                    }
                    let branchesResult = try? await gitService.branchesWithStatus()
                    if let branchesResult {
                        applyGitBranchTargets(branchesResult)
                    }

                case .syncNow:
                    let result = try await gitService.status()
                    applyGitRepoSync(result)
                    if result.state == "behind_only" {
                        let pullResult = try await gitService.pull()
                        if let status = pullResult.status {
                            applyGitRepoSync(status)
                        }
                    } else if result.state == "dirty_and_behind" {
                        gitSyncAlert = TurnGitSyncAlert(
                            title: "Local changes need attention",
                            message: "You have local changes and the remote branch moved ahead. Pull with rebase only if you're ready to reconcile those changes.",
                            action: .pullRebase
                        )
                    }

                case .commit:
                    let result = try await runStackedGitAction(
                        .commit,
                        gitService: gitService,
                        model: gitWriterModel,
                        codex: codex
                    )
                    if let status = result.status { applyGitRepoSync(status) }

                case .push:
                    let result = try await runStackedGitAction(
                        .push,
                        gitService: gitService,
                        model: gitWriterModel,
                        codex: codex
                    )
                    handleSuccessfulStackedGitAction(
                        result,
                        codex: codex,
                        workingDirectory: workingDirectory,
                        threadID: threadID
                    )

                case .commitAndPush:
                    guard gitRepoSync?.hasPushRemote == true else {
                        throw GitActionsError.bridgeError(
                            code: "no_remote",
                            message: "Add a Git remote before using Commit & Push."
                        )
                    }
                    let result = try await runStackedGitAction(
                        .commitAndPush,
                        gitService: gitService,
                        model: gitWriterModel,
                        codex: codex
                    )
                    handleSuccessfulStackedGitAction(result, codex: codex, workingDirectory: workingDirectory, threadID: threadID)

                case .commitPushCreatePR:
                    let result = try await runStackedGitAction(
                        .commitPushCreatePR,
                        gitService: gitService,
                        model: gitWriterModel,
                        codex: codex
                    )
                    handleSuccessfulStackedGitAction(result, codex: codex, workingDirectory: workingDirectory, threadID: threadID)
                    if let urlString = result.pullRequest.url, let url = URL(string: urlString) {
                        await UIApplication.shared.open(url)
                    }

                case .createPR:
                    if let validationMessage = createPullRequestValidationMessage {
                        throw GitActionsError.bridgeError(code: "pull_request_unavailable", message: validationMessage)
                    }
                    let result = try await runStackedGitAction(
                        .createPR,
                        gitService: gitService,
                        model: gitWriterModel,
                        codex: codex
                    )
                    handleSuccessfulStackedGitAction(result, codex: codex, workingDirectory: workingDirectory, threadID: threadID)
                    if let urlString = result.pullRequest.url, let url = URL(string: urlString) {
                        await UIApplication.shared.open(url)
                    }

                case .discardRuntimeChangesAndSync:
                    let unpushedCommitWarning: String
                    if let repoSync = gitRepoSync, repoSync.aheadCount > 0 {
                        let commitLabel = repoSync.aheadCount == 1 ? "1 local commit" : "\(repoSync.aheadCount) local commits"
                        unpushedCommitWarning = " This also deletes \(commitLabel) that have not been pushed."
                    } else {
                        unpushedCommitWarning = ""
                    }
                    gitSyncAlert = TurnGitSyncAlert(
                        title: "Discard local changes?",
                        message: "This resets the current branch to match the remote and removes local uncommitted changes.\(unpushedCommitWarning) This cannot be undone from the app.",
                        buttons: [
                            TurnGitSyncAlertButton(title: "Cancel", role: .cancel, action: .dismissOnly),
                            TurnGitSyncAlertButton(title: "Discard Changes", role: .destructive, action: .discardRuntimeChanges)
                        ]
                    )
                }
            } catch let error as GitActionsError {
                switch error {
                case .bridgeError(let code, _) where code == "nothing_to_commit":
                    isShowingNothingToCommitAlert = true
                default:
                    gitSyncAlert = TurnGitSyncAlert(
                        title: "Git Error",
                        message: error.errorDescription ?? "Operation failed.",
                        action: .dismissOnly
                    )
                }
            } catch {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Git Error",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    func inlineCommitAndPush(codex: CodexService, workingDirectory: String?, threadID: String) {
        guard !isRunningGitAction else { return }
        runningGitAction = .commitAndPush
        gitActionLoadingTitle = TurnGitActionKind.commitAndPush.loadingTitle(repoSync: gitRepoSync)
        inlineCommitAndPushPhase = .committing

        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.runningGitAction = nil
                self.gitActionLoadingTitle = nil
                self.inlineCommitAndPushPhase = nil
            }

            let gitService = GitActionsService(codex: codex, workingDirectory: workingDirectory)
            let gitWriterModel = codex.gitWriterModelIdentifier()
            do {
                _ = try await gitService.commit(
                    message: await generatedGitCommitMessageOrNil(
                        gitService: gitService,
                        model: gitWriterModel
                    )
                )
                inlineCommitAndPushPhase = .pushing
                let pushResult = try await gitService.push()
                handleSuccessfulPush(
                    pushResult,
                    codex: codex,
                    workingDirectory: workingDirectory,
                    threadID: threadID
                )
            } catch let error as GitActionsError {
                switch error {
                case .bridgeError(let code, _) where code == "nothing_to_commit":
                    isShowingNothingToCommitAlert = true
                default:
                    gitSyncAlert = TurnGitSyncAlert(
                        title: "Git Error",
                        message: error.errorDescription ?? "Operation failed.",
                        action: .dismissOnly
                    )
                }
            } catch {
                gitSyncAlert = TurnGitSyncAlert(
                    title: "Git Error",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }

    // Centralizes the mobile-to-bridge mapping for stacked Git publishing actions.
    private func runStackedGitAction(
        _ action: TurnGitActionKind,
        gitService: GitActionsService,
        model: String?,
        codex: CodexService
    ) async throws -> GitStackedActionResult {
        guard let actionIdentifier = action.stackedActionIdentifier else {
            throw GitActionsError.bridgeError(code: "invalid_git_action", message: "Unsupported Git action.")
        }

        let trimmedDefaultBranch = gitDefaultBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        let baseBranch = trimmedDefaultBranch.isEmpty ? nil : trimmedDefaultBranch
        let branch = (gitRepoSync?.currentBranch ?? currentGitBranch).trimmingCharacters(in: .whitespacesAndNewlines)
        let shouldCreateFeatureBranch = action == .commitPushCreatePR && (baseBranch.map { branch == $0 } ?? false)
        let commitMessage: String?
        if action == .commit || action == .commitAndPush || action == .commitPushCreatePR {
            gitActionLoadingTitle = "Preparing commit..."
            commitMessage = await generatedGitCommitMessageOrNil(gitService: gitService, model: model)
        } else {
            commitMessage = nil
        }
        gitActionLoadingTitle = action.loadingTitle(repoSync: gitRepoSync)

        // Subscribe to bridge progress so the inline composer pill can mirror commit/push phases.
        let progressId = UUID().uuidString
        codex.registerGitStackedActionProgressHandler(progressId: progressId) { [weak self] phase, status in
            guard let self else { return }
            guard status == "started" else {
                if status == "completed", phase == "push" {
                    self.inlineCommitAndPushPhase = nil
                }
                return
            }
            switch phase {
            case "commit":
                self.inlineCommitAndPushPhase = .committing
            case "push":
                self.inlineCommitAndPushPhase = .pushing
            default:
                break
            }
        }
        defer {
            codex.unregisterGitStackedActionProgressHandler(progressId: progressId)
        }

        return try await gitService.runStackedAction(
            action: actionIdentifier,
            commitMessage: commitMessage,
            model: model,
            baseBranch: baseBranch,
            featureBranch: shouldCreateFeatureBranch,
            progressId: progressId
        )
    }

    // AI writing is a polish layer; Git actions must still work when the writer is unavailable.
    private func generatedGitCommitMessageOrNil(
        gitService: GitActionsService,
        model: String?
    ) async -> String? {
        do {
            return try await gitService.generateCommitMessage(model: model).fullMessage
        } catch {
            return nil
        }
    }
}
