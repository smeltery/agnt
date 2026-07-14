import SwiftUI

extension TurnView {
    @ViewBuilder
    func composerStructuredPromptReplacement(message: CodexMessage) -> some View {
        let activeTurnID = codex.activeTurnID(for: thread.id)
        let renderSnapshot = codex.timelineState(for: thread.id).renderSnapshot
        let activeFileChangeStatus = FileChangeStatusSnapshot.activeTurnSnapshot(
            from: renderSnapshot.messages,
            activeTurnID: activeTurnID,
            isThreadRunning: renderSnapshot.isThreadRunning
        )
        let currentThread = currentResolvedThread
        let gitWorkingDirectory = currentThread.gitWorkingDirectory
        let showsGitControls = repoGitControlsVisible(
            for: currentThread,
            gitWorkingDirectory: gitWorkingDirectory
        )

        if let request = message.structuredUserInputRequest {
            let isDismissed = viewModel.isStructuredPlanPromptDismissed(request.requestID, codex: codex)
            let isDismissing = viewModel.isStructuredPlanPromptDismissing(request.requestID, codex: codex)

            if !isDismissed {
                StructuredUserInputCard(
                    request: request,
                    isInteractionLocked: isDismissing,
                    secondaryActionTitle: isDismissing ? "Closing..." : "ESC",
                    onSecondaryAction: isDismissing ? nil : {
                        isInputFocused = true
                        viewModel.dismissStructuredPlanPrompt(message, codex: codex, threadID: thread.id)
                    }
                )
                .id(request.requestID)
                .padding(.horizontal, 12)
                .padding(.top, 4)
            } else {
                composerWithSubagentAccessory(
                    currentThread: currentThread,
                    activeTurnID: activeTurnID,
                    isThreadRunning: renderSnapshot.isThreadRunning,
                    isEmptyThread: renderSnapshot.messages.isEmpty,
                    isWorktreeProject: currentThread.isManagedWorktreeProject,
                    activeFileChangeStatus: activeFileChangeStatus,
                    showsGitControls: showsGitControls,
                    gitWorkingDirectory: gitWorkingDirectory
                )
            }
        } else {
            composerWithSubagentAccessory(
                currentThread: currentThread,
                activeTurnID: activeTurnID,
                isThreadRunning: renderSnapshot.isThreadRunning,
                isEmptyThread: renderSnapshot.messages.isEmpty,
                isWorktreeProject: currentThread.isManagedWorktreeProject,
                activeFileChangeStatus: activeFileChangeStatus,
                showsGitControls: showsGitControls,
                gitWorkingDirectory: gitWorkingDirectory
            )
        }
    }
    func composerWithSubagentAccessory(
        currentThread: CodexThread,
        activeTurnID: String?,
        isThreadRunning: Bool,
        isEmptyThread: Bool,
        isWorktreeProject: Bool,
        activeFileChangeStatus: FileChangeStatusSnapshot?,
        showsGitControls: Bool,
        gitWorkingDirectory: String?
    ) -> some View {
        VStack(spacing: 8) {
            if let parentThread = parentThread {
                SubagentParentAccessoryCard(
                    parentTitle: parentThread.displayTitle,
                    agentLabel: codex.resolvedSubagentDisplayLabel(threadId: thread.id, agentId: thread.agentId)
                        ?? "Subagent",
                    onTap: { openThread(parentThread.id) }
                )
                .padding(.horizontal, 12)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if isForkingThread {
                forkLoadingNotice
                    .padding(.horizontal, 12)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            composerHostView(
                currentThread: currentThread,
                activeTurnID: activeTurnID,
                isThreadRunning: isThreadRunning,
                isEmptyThread: isEmptyThread,
                isWorktreeProject: isWorktreeProject,
                activeFileChangeStatus: activeFileChangeStatus,
                showsGitControls: showsGitControls,
                gitWorkingDirectory: gitWorkingDirectory
            )
        }
    }

    func composerHostView(
        currentThread: CodexThread,
        activeTurnID: String?,
        isThreadRunning: Bool,
        isEmptyThread: Bool,
        isWorktreeProject: Bool,
        activeFileChangeStatus: FileChangeStatusSnapshot?,
        showsGitControls: Bool,
        gitWorkingDirectory: String?
    ) -> TurnComposerHostView {
        let onSelectGitBranch: (String) -> Void = { branch in
            selectComposerGitBranch(
                branch,
                currentThread: currentThread,
                isThreadRunning: isThreadRunning,
                gitWorkingDirectory: gitWorkingDirectory,
                activeTurnID: activeTurnID
            )
        }
        let onCreateGitBranch: (String) -> Void = { branchName in
            createComposerGitBranch(
                branchName,
                isThreadRunning: isThreadRunning,
                gitWorkingDirectory: gitWorkingDirectory,
                activeTurnID: activeTurnID
            )
        }
        let onRefreshGitBranches: () -> Void = {
            refreshComposerGitBranches(
                showsGitControls: showsGitControls,
                gitWorkingDirectory: gitWorkingDirectory
            )
        }
        let onOpenFeedbackMail: () -> Void = {
            openURL(AppEnvironment.feedbackMailtoURL(
                errorMessage: codex.lastErrorMessage,
                threadId: thread.id,
                isConnected: codex.isConnected,
                cliVersion: codex.bridgeInstalledVersion
            ))
        }
        let onOpenWorktreeHandoff: () -> Void = {
            handleWorktreeHandoffTap(currentThread: currentThread)
        }
        let onShowGoal: (String?) -> Void = { objectivePrefill in
            presentGoalSheet(objectivePrefill: objectivePrefill)
        }
        let onCompactThread: () -> Void = {
            Task { try? await codex.compactThread(currentThread.id) }
        }

        return TurnComposerHostView(
            viewModel: viewModel,
            codex: codex,
            thread: currentThread,
            activeTurnID: activeTurnID,
            isThreadRunning: isThreadRunning,
            isEmptyThread: isEmptyThread,
            isWorktreeProject: isWorktreeProject,
            activeFileChangeStatus: activeFileChangeStatus,
            threadGoal: codex.goalByThreadID[thread.id],
            canForkLocally: showsGitControls && gitWorkingDirectory != nil && WorktreeFlowCoordinator.localForkProjectPath(
                for: currentThread,
                localCheckoutPath: viewModel.gitLocalCheckoutPath
            ) != nil,
            isInputFocused: $isInputFocused,
            orderedModelOptions: orderedModelOptions,
            selectedModelTitle: selectedModelTitle,
            reasoningDisplayOptions: reasoningDisplayOptions,
            showsGitControls: showsGitControls && viewModel.isGitRepositoryInitialized,
            isGitBranchSelectorEnabled: viewModel.isGitRepositoryInitialized && canRunGitAction(
                isThreadRunning: isThreadRunning,
                gitWorkingDirectory: gitWorkingDirectory
            ),
            onSelectGitBranch: onSelectGitBranch,
            onCreateGitBranch: onCreateGitBranch,
            onRefreshGitBranches: onRefreshGitBranches,
            onStartCodeReviewThread: startCodeReviewThread,
            onStartForkThreadLocally: startLocalFork,
            onOpenForkWorktree: {
                isShowingForkWorktree = true
            },
            onOpenWorktreeHandoff: onOpenWorktreeHandoff,
            onOpenFeedbackMail: onOpenFeedbackMail,
            onShowStatus: presentStatusSheet,
            onShowGoal: onShowGoal,
            onCompactThread: onCompactThread,
            voiceButtonPresentation: voiceButtonPresentation,
            isVoiceRecording: isVoiceRecording,
            voiceAudioLevels: voiceTranscriptionManager.audioLevels,
            voiceRecordingDuration: voiceTranscriptionManager.recordingDuration,
            onTapVoice: handleVoiceButtonTap,
            onCancelVoiceRecording: cancelVoiceRecordingIfNeeded,
            onSend: handleSend
        )
    }

    func selectComposerGitBranch(
        _ branch: String,
        currentThread: CodexThread,
        isThreadRunning: Bool,
        gitWorkingDirectory: String?,
        activeTurnID: String?
    ) {
        guard canRunGitAction(
            isThreadRunning: isThreadRunning,
            gitWorkingDirectory: gitWorkingDirectory
        ) else { return }

        if let worktreePath = viewModel.worktreePathForCheckedOutElsewhereBranch(branch) {
            if let normalizedWorktreePath = CodexThreadStartProjectBinding.normalizedProjectPath(worktreePath) {
                let resolvedWorktreePath = TurnWorktreeRouting.canonicalProjectPath(normalizedWorktreePath)
                    ?? normalizedWorktreePath
                if TurnWorktreeRouting.comparableProjectPath(currentThread.normalizedProjectPath) == resolvedWorktreePath {
                    return
                }
            }

            let existingThread = WorktreeFlowCoordinator.liveThreadForCheckedOutElsewhereBranch(
                projectPath: worktreePath,
                codex: codex,
                currentThread: currentThread
            )
            checkedOutElsewhereAlert = CheckedOutElsewhereAlert(
                branch: branch,
                threadID: existingThread?.id
            )
            return
        }

        viewModel.requestSwitchGitBranch(
            to: branch,
            codex: codex,
            workingDirectory: gitWorkingDirectory,
            threadID: thread.id,
            activeTurnID: activeTurnID
        )
    }

    func createComposerGitBranch(
        _ branchName: String,
        isThreadRunning: Bool,
        gitWorkingDirectory: String?,
        activeTurnID: String?
    ) {
        guard canRunGitAction(
            isThreadRunning: isThreadRunning,
            gitWorkingDirectory: gitWorkingDirectory
        ) else { return }

        viewModel.requestCreateGitBranch(
            named: branchName,
            codex: codex,
            workingDirectory: gitWorkingDirectory,
            threadID: thread.id,
            activeTurnID: activeTurnID
        )
    }

    func refreshComposerGitBranches(
        showsGitControls: Bool,
        gitWorkingDirectory: String?
    ) {
        guard showsGitControls, viewModel.isGitRepositoryInitialized else { return }
        viewModel.refreshGitBranchTargets(
            codex: codex,
            workingDirectory: gitWorkingDirectory,
            threadID: thread.id
        )
    }

    var forkLoadingNotice: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)

            VStack(alignment: .leading, spacing: 2) {
                Text("Creating fork...")
                    .font(AppFont.subheadline(weight: .semibold))
                Text("Opening the new chat")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .adaptiveGlass(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
