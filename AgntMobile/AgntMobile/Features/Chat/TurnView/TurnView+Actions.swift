import SwiftUI

extension TurnView {
    // Fetches the repo-wide local patch on demand so the toolbar pill opens the same diff UI as turn changes.
    func presentRepositoryDiff(workingDirectory: String?) {
        guard !isLoadingRepositoryDiff else { return }
        isLoadingRepositoryDiff = true

        Task { @MainActor in
            defer { isLoadingRepositoryDiff = false }

            let gitService = GitActionsService(codex: codex, workingDirectory: workingDirectory)

            do {
                let result = try await gitService.diff()
                guard let presentation = TurnDiffPresentationBuilder.repositoryPresentation(from: result.patch) else {
                    viewModel.gitSyncAlert = TurnGitSyncAlert(
                        title: "Git Error",
                        message: "There are no repository changes to show.",
                        action: .dismissOnly
                    )
                    return
                }
                repositoryDiffPresentation = presentation
            } catch let error as GitActionsError {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: "Git Error",
                    message: error.errorDescription ?? "Could not load repository changes.",
                    action: .dismissOnly
                )
            } catch {
                viewModel.gitSyncAlert = TurnGitSyncAlert(
                    title: "Git Error",
                    message: error.localizedDescription,
                    action: .dismissOnly
                )
            }
        }
    }
    // Opens the local session summary and refreshes both thread context usage and rate limits.
    func presentStatusSheet() {
        isShowingStatusSheet = true

        Task {
            await codex.refreshUsageStatus(threadId: thread.id)
        }
    }

    func presentGoalSheet(objectivePrefill: String?) {
        let cleanedPrefill = objectivePrefill?.trimmingCharacters(in: .whitespacesAndNewlines)
        goalSheetObjectivePrefill = cleanedPrefill?.isEmpty == false ? cleanedPrefill : nil
        goalSheetComposerConsumedInput = goalSheetObjectivePrefill == nil ? nil : viewModel.input
        isShowingGoalSheet = true
    }

    func clearGoalSheetState() {
        goalSheetObjectivePrefill = nil
        goalSheetComposerConsumedInput = nil
    }

    func consumeComposerDraftAfterGoalSubmission() {
        guard let consumedInput = goalSheetComposerConsumedInput,
              viewModel.input == consumedInput else {
            goalSheetComposerConsumedInput = nil
            return
        }

        viewModel.input = ""
        goalSheetComposerConsumedInput = nil
    }

    func continueOnDesktopApp() {
        guard !isHandingOffToMac else { return }
        isHandingOffToMac = true

        Task { @MainActor in
            defer { isHandingOffToMac = false }

            do {
                let handoffService = DesktopHandoffService(codex: codex)
                try await handoffService.continueOnDesktopApp(threadId: thread.id)
            } catch {
                macHandoffErrorMessage = error.localizedDescription
            }
        }
    }

    // Starts a sibling chat scoped to the same cwd as the current thread.
    func startSiblingChat() {
        Task { @MainActor in
            guard !isStartingSiblingChat else { return }
            guard !currentResolvedThread.isManagedWorktreeProject else { return }
            isStartingSiblingChat = true
            defer { isStartingSiblingChat = false }

            do {
                _ = try await codex.startThreadIfReady(preferredProjectPath: resolvedProjectPathForFollowUpThread())
            } catch {
                if let message = codex.userFacingTurnErrorMessageForFooter(from: error),
                   codex.lastErrorMessage?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true {
                    codex.lastErrorMessage = message
                }
            }
        }
    }
    func handleSend() {
        let goalCommand = GoalCommandParser.parse(viewModel.input)
        if goalCommand.isGoalCommand {
            presentGoalSheet(objectivePrefill: goalCommand.objective)
            if goalCommand.objective == nil {
                viewModel.input = ""
            }
            isInputFocused = false
            return
        }

        viewModel.clearComposerAutocomplete()
        viewModel.sendTurn(codex: codex, threadID: thread.id)
        isInputFocused = false
    }
    func handleGitActionSelection(
        _ action: TurnGitActionKind,
        isThreadRunning: Bool,
        gitWorkingDirectory: String?
    ) {
        guard canRunGitAction(
            isThreadRunning: isThreadRunning,
            gitWorkingDirectory: gitWorkingDirectory,
            requiresIdleThread: false
        ) else { return }
        viewModel.triggerGitAction(
            action,
            codex: codex,
            workingDirectory: gitWorkingDirectory,
            threadID: thread.id,
            activeTurnID: codex.activeTurnID(for: thread.id)
        )
    }

    func canRunGitAction(
        isThreadRunning: Bool,
        gitWorkingDirectory: String?,
        requiresIdleThread: Bool = true
    ) -> Bool {
        viewModel.canRunGitAction(
            isConnected: codex.isConnected,
            isThreadRunning: isThreadRunning,
            hasGitWorkingDirectory: gitWorkingDirectory != nil,
            requiresIdleThread: requiresIdleThread
        )
    }

    func handleInitialAppear(activeTurnID: String?) {
        syncApprovalAlertPresentation()
        if initialShouldAnchorToAssistantResponse && !hasConsumedInitialAssistantAnchor {
            hasConsumedInitialAssistantAnchor = true
            viewModel.shouldAnchorToAssistantResponse = true
            onInitialAssistantAnchorConsumed?()
        }
        if let pendingComposerAction = codex.consumePendingComposerAction(for: thread.id) {
            viewModel.applyPendingComposerAction(pendingComposerAction)
            isInputFocused = true
        } else {
            viewModel.restoreSavedLocalDraftIfNeeded(codex: codex, threadID: thread.id)
        }
    }

    func startAssistantRevertPreview(message: CodexMessage, gitWorkingDirectory: String?) {
        guard let gitWorkingDirectory,
              let changeSet = codex.readyChangeSet(forAssistantMessage: message),
              let presentation = codex.assistantRevertPresentation(
                for: message,
                workingDirectory: gitWorkingDirectory
              ),
              presentation.isEnabled else {
            return
        }

        assistantRevertSheetState = AssistantRevertSheetState(
            changeSet: changeSet,
            presentation: presentation,
            preview: nil,
            isLoadingPreview: true,
            isApplying: false,
            errorMessage: nil
        )

        Task { @MainActor in
            do {
                let preview = try await codex.previewRevert(
                    changeSet: changeSet,
                    workingDirectory: gitWorkingDirectory
                )
                guard assistantRevertSheetState?.id == changeSet.id else { return }
                assistantRevertSheetState?.preview = preview
                assistantRevertSheetState?.isLoadingPreview = false
            } catch {
                guard assistantRevertSheetState?.id == changeSet.id else { return }
                assistantRevertSheetState?.isLoadingPreview = false
                assistantRevertSheetState?.errorMessage = error.localizedDescription
            }
        }
    }

    func confirmAssistantRevert(gitWorkingDirectory: String?) {
        guard let gitWorkingDirectory,
              var assistantRevertSheetState,
              let preview = assistantRevertSheetState.preview,
              preview.canRevert else {
            return
        }

        assistantRevertSheetState.isApplying = true
        assistantRevertSheetState.errorMessage = nil
        self.assistantRevertSheetState = assistantRevertSheetState

        let changeSet = assistantRevertSheetState.changeSet
        Task { @MainActor in
            do {
                let applyResult = try await codex.applyRevert(
                    changeSet: changeSet,
                    workingDirectory: gitWorkingDirectory
                )

                guard self.assistantRevertSheetState?.id == changeSet.id else { return }
                if applyResult.success {
                    if let status = applyResult.status {
                        viewModel.gitRepoSync = status
                    } else {
                        viewModel.scheduleGitStatusRefresh(
                            codex: codex,
                            workingDirectory: gitWorkingDirectory,
                            threadID: thread.id
                        )
                    }
                    self.assistantRevertSheetState = nil
                    return
                }

                self.assistantRevertSheetState?.isApplying = false
                let affectedFiles = self.assistantRevertSheetState?.preview?.affectedFiles
                    ?? changeSet.fileChanges.map(\.path)
                self.assistantRevertSheetState?.preview = RevertPreviewResult(
                    canRevert: false,
                    affectedFiles: affectedFiles,
                    conflicts: applyResult.conflicts,
                    unsupportedReasons: applyResult.unsupportedReasons,
                    stagedFiles: applyResult.stagedFiles
                )
                self.assistantRevertSheetState?.errorMessage = applyResult.conflicts.first?.message
                    ?? applyResult.unsupportedReasons.first
            } catch {
                guard self.assistantRevertSheetState?.id == changeSet.id else { return }
                self.assistantRevertSheetState?.isApplying = false
                self.assistantRevertSheetState?.errorMessage = error.localizedDescription
            }
        }
    }

    func prepareThreadIfReady(
        gitWorkingDirectory: String?,
        showsGitControls: Bool
    ) async {
        let didPrepare = await codex.prepareThreadForDisplay(threadId: thread.id)
        guard didPrepare, !Task.isCancelled, codex.activeThreadId == thread.id else { return }
        await codex.refreshContextWindowUsage(threadId: thread.id)
        guard !Task.isCancelled, codex.activeThreadId == thread.id else { return }
        viewModel.flushQueueIfPossible(codex: codex, threadID: thread.id)
        guard !Task.isCancelled, codex.activeThreadId == thread.id else { return }
        guard showsGitControls else { return }
        viewModel.refreshGitBranchTargets(
            codex: codex,
            workingDirectory: gitWorkingDirectory,
            threadID: thread.id
        )
    }

    // Re-resolves the thread at action time so follow-up chats inherit the freshest cwd after sync/reconnect.
    func resolvedProjectPathForFollowUpThread() -> String? {
        let currentThread = codex.thread(for: thread.id) ?? thread
        return currentThread.normalizedProjectPath
    }

    // Creates a fresh thread in the same project and opens it straight into the review flow.
    func startCodeReviewThread(target: TurnComposerReviewTarget) {
        Task { @MainActor in
            do {
                _ = try await codex.startThreadIfReady(
                    preferredProjectPath: resolvedProjectPathForFollowUpThread(),
                    pendingComposerAction: .codeReview(target: target.codexPendingTarget)
                )
                viewModel.clearComposerReviewSelection()
            } catch {
                if let message = codex.userFacingTurnErrorMessageForFooter(from: error),
                   codex.lastErrorMessage?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true {
                    codex.lastErrorMessage = message
                }
            }
        }
    }
}
