import SwiftUI
import PhotosUI
extension TurnView {
    var turnBody: some View {
        let resolvedThread = currentResolvedThread
        let timelineState = codex.timelineState(for: thread.id)
        let renderSnapshot = timelineState.renderSnapshot
        let activeTurnID = renderSnapshot.activeTurnID
        let planSessionSource = codex.currentPlanSessionSource(for: thread.id)
        let gitWorkingDirectory = resolvedThread.gitWorkingDirectory
        let isThreadRunning = renderSnapshot.isThreadRunning
        let showsGitControls = repoGitControlsVisible(
            for: resolvedThread,
            gitWorkingDirectory: gitWorkingDirectory
        )
        let isEmptyThread = renderSnapshot.messages.isEmpty
        let threadDisplayPhase = codex.threadDisplayPhase(
            threadId: thread.id,
            hasVisibleMessages: !renderSnapshot.messages.isEmpty,
            isThreadRunning: isThreadRunning
        )
        // Keep the service-owned loading vs empty-state decision intact while
        // history hydration catches up for previously active conversations.
        let resolvedEmptyConversationState = resolvedEmptyState(for: threadDisplayPhase)
        let isWorktreeProject = resolvedThread.isManagedWorktreeProject
        let isComposerAutocompletePresented = viewModel.isFileAutocompleteVisible
            || viewModel.isSkillAutocompleteVisible
            || viewModel.isPluginAutocompleteVisible
            || viewModel.slashCommandPanelState != .hidden
        let activeFileChangeStatus = FileChangeStatusSnapshot.activeTurnSnapshot(
            from: renderSnapshot.messages,
            activeTurnID: activeTurnID,
            isThreadRunning: isThreadRunning
        )
        let isWorktreeHandoffAvailable = isWorktreeHandoffAvailable(
            isThreadRunning: isThreadRunning,
            gitWorkingDirectory: gitWorkingDirectory
        )
        let canHandOffToWorktree = canHandOffToWorktree(
            isThreadRunning: isThreadRunning,
            gitWorkingDirectory: gitWorkingDirectory
        )
        let toolbarNavigationContext = threadNavigationContext(for: resolvedThread)
        let toolbarWorktreeHandoffTitle = isWorktreeProject ? "Hand off to Local" : "Hand off to Worktree"
        let isGitActionEnabled = viewModel.gitRepoSync != nil && canRunGitAction(
            isThreadRunning: isThreadRunning,
            gitWorkingDirectory: gitWorkingDirectory,
            requiresIdleThread: false
        )
        let disabledGitActions: Set<TurnGitActionKind> = viewModel.disabledGitActions
        let onTapMacHandoff: (() -> Void)? = codex.isConnected && codex.supportsDesktopAppHandoff ? {
            isShowingMacHandoffConfirm = true
        } : nil
        let onTapWorktreeHandoff: (() -> Void)? = showsGitControls ? {
            handleWorktreeHandoffTap(currentThread: resolvedThread)
        } : nil
        let onTapNewChat: (() -> Void)? = codex.isConnected && !isWorktreeProject ? {
            startSiblingChat()
        } : nil
        let onTapRepoDiff: (() -> Void)? = showsGitControls ? {
            presentRepositoryDiff(workingDirectory: gitWorkingDirectory)
        } : nil
        return TurnConversationContainerView(
                threadID: thread.id,
                messages: renderSnapshot.messages,
                timelineChangeToken: renderSnapshot.timelineChangeToken,
                activeTurnID: activeTurnID,
                isThreadRunning: isThreadRunning,
                isSendInFlight: viewModel.isSending,
                latestTurnTerminalState: renderSnapshot.latestTurnTerminalState,
                completedTurnIDs: renderSnapshot.completedTurnIDs,
                stoppedTurnIDs: renderSnapshot.stoppedTurnIDs,
                assistantRevertStatesByMessageID: renderSnapshot.assistantRevertStatesByMessageID,
                planSessionSource: planSessionSource,
                allowsAssistantPlanFallbackRecovery: planSessionSource == .compatibilityFallback,
                threadMessagesForPlanMatching: renderSnapshot.planMatchingMessages,
                currentWorkingDirectory: gitWorkingDirectory,
                errorMessage: timelineFooterErrorMessage,
                composerRecoveryAccessory: composerRecoveryAccessory,
                onReportError: { errorMessage in
                    openURL(AppEnvironment.feedbackMailtoURL(
                        errorMessage: errorMessage,
                        threadId: thread.id,
                        isConnected: codex.isConnected,
                        cliVersion: codex.bridgeInstalledVersion
                    ))
                },
                onDismissError: {
                    codex.lastErrorMessage = nil
                },
                hasRemoteEarlierMessages: renderSnapshot.hasRemoteOlderHistory,
                hasLocallyProjectedEarlierMessages: renderSnapshot.hasLocallyProjectedOlderHistory,
                usesPaginatedHistory: renderSnapshot.usesPaginatedHistory,
                initialTurnsLoaded: renderSnapshot.initialTurnsLoaded,
                isLoadingRemoteEarlierMessages: renderSnapshot.isLoadingOlderHistory,
                olderHistoryLoadErrorMessage: renderSnapshot.olderHistoryLoadErrorMessage,
                shouldAnchorToAssistantResponse: shouldAnchorToAssistantResponseBinding,
                isComposerFocused: isInputFocused,
                isComposerAutocompletePresented: isComposerAutocompletePresented,
                emptyState: resolvedEmptyConversationState,
                composer: AnyView(composerWithSubagentAccessory(
                    currentThread: resolvedThread,
                    activeTurnID: activeTurnID,
                    isThreadRunning: isThreadRunning,
                    isEmptyThread: isEmptyThread,
                    isWorktreeProject: isWorktreeProject,
                    activeFileChangeStatus: activeFileChangeStatus,
                    showsGitControls: showsGitControls,
                    gitWorkingDirectory: gitWorkingDirectory
                )),
                structuredPromptReplacementComposer: { message in
                    AnyView(composerStructuredPromptReplacement(message: message))
                },
                repositoryLoadingToastOverlay: AnyView(EmptyView()),
                usageToastOverlay: AnyView(EmptyView()),
                isRepositoryLoadingToastVisible: false,
                onRetryUserMessage: { messageText in
                    viewModel.input = messageText
                    isInputFocused = true
                },
                onTapAssistantRevert: { message in
                    startAssistantRevertPreview(message: message, gitWorkingDirectory: gitWorkingDirectory)
                },
                onTapSubagent: { subagent in
                    openThread(subagent.threadId)
                },
                onRevealEarlierMessages: { pageSize in
                    codex.noteThreadHistoryRevealRequested(threadId: thread.id, pageSize: pageSize)
                },
                onLoadRemoteEarlierMessages: {
                    Task { @MainActor in
                        await codex.loadOlderThreadHistoryPage(threadId: thread.id)
                    }
                },
                onRetryEarlierMessages: { completion in
                    Task { @MainActor in
                        defer { completion() }
                        _ = try? await codex.loadThreadHistoryIfNeeded(threadId: thread.id, forceRefresh: true)
                    }
                },
                onTapOutsideComposer: {
                    guard isInputFocused else { return }
                    isInputFocused = false
                    viewModel.clearComposerAutocomplete()
                }
            )
        .environment(\.inlineCommitAndPushAction, showsGitControls ? {
            viewModel.inlineCommitAndPush(
                codex: codex,
                workingDirectory: gitWorkingDirectory,
                threadID: thread.id
            )
        } as (() -> Void)? : nil)
        .environment(\.openURL, OpenURLAction { url in
            guard let path = WorkspaceFileLinkResolver.localPath(from: url) else {
                return .systemAction
            }
            workspaceFilePreviewRequest = WorkspaceFilePreviewRequest(
                path: path,
                currentWorkingDirectory: gitWorkingDirectory
            )
            return .handled
        })
        .environment(\.inlineCommitAndPushPhase, viewModel.inlineCommitAndPushPhase)
        .navigationTitle(resolvedThread.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            turnToolbarContent(
                resolvedThread: resolvedThread,
                toolbarNavigationContext: toolbarNavigationContext,
                isHandingOffToMac: isHandingOffToMac,
                isStartingSiblingChat: isStartingSiblingChat,
                canHandOffToWorktree: canHandOffToWorktree,
                toolbarWorktreeHandoffTitle: toolbarWorktreeHandoffTitle,
                isGitActionEnabled: isGitActionEnabled,
                disabledGitActions: disabledGitActions,
                showsGitControls: showsGitControls,
                isThreadRunning: isThreadRunning,
                gitWorkingDirectory: gitWorkingDirectory,
                onTapMacHandoff: onTapMacHandoff,
                onTapWorktreeHandoff: onTapWorktreeHandoff,
                onTapNewChat: onTapNewChat,
                onTapRepoDiff: onTapRepoDiff
            )
        }
        .overlay {
            if isStartingSiblingChat {
                NewChatOpeningOverlay()
                    .transition(.opacity)
            }
            if isShowingWorktreeHandoff {
                TurnWorktreeHandoffOverlay(
                    mode: .handoff,
                    preferredBaseBranch: preferredWorktreeBaseBranch,
                    isHandoffAvailable: isWorktreeHandoffAvailable,
                    isSubmitting: viewModel.isCreatingGitWorktree,
                    onClose: { isShowingWorktreeHandoff = false },
                    onSubmit: { branchName, baseBranch in
                        submitWorktreeHandoff(
                            branchName: branchName,
                            baseBranch: baseBranch,
                            gitWorkingDirectory: gitWorkingDirectory,
                            activeTurnID: activeTurnID
                        )
                    }
                )
                .transition(.opacity)
            }
            if isShowingForkWorktree {
                TurnWorktreeHandoffOverlay(
                    mode: .fork,
                    preferredBaseBranch: preferredWorktreeBaseBranch,
                    isHandoffAvailable: isWorktreeHandoffAvailable,
                    isSubmitting: viewModel.isCreatingGitWorktree || isForkingThread,
                    onClose: { isShowingForkWorktree = false },
                    onSubmit: { branchName, baseBranch in
                        submitForkIntoNewWorktree(
                            branchName: branchName,
                            baseBranch: baseBranch,
                            gitWorkingDirectory: gitWorkingDirectory,
                            activeTurnID: activeTurnID
                        )
                    }
                )
                .transition(.opacity)
            }
        }
        .overlay(alignment: .top) {
            gitActionToastOverlay
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.88), value: viewModel.gitActionLoadingTitle)
        .fullScreenCover(isPresented: isCameraPresentedBinding) {
            CameraImagePicker { data in
                viewModel.enqueueCapturedImageData(data, codex: codex, threadID: thread.id)
            }
            .ignoresSafeArea()
        }
        .fullScreenCover(item: $workspaceFilePreviewRequest) { request in
            WorkspaceLinkedFilePreviewScreen(
                request: request,
                onDismiss: { workspaceFilePreviewRequest = nil }
            )
        }
        .photosPicker(
            isPresented: isPhotoPickerPresentedBinding,
            selection: photoPickerItemsBinding,
            maxSelectionCount: max(1, viewModel.remainingAttachmentSlots),
            matching: .images,
            preferredItemEncoding: .automatic
        )
        .turnViewLifecycle(
            taskID: thread.id,
            activeTurnID: activeTurnID,
            isThreadRunning: isThreadRunning,
            isConnected: codex.isConnected,
            scenePhase: scenePhase,
            approvalRequestChangeToken: approvalRequestChangeToken,
            photoPickerItems: viewModel.photoPickerItems,
            onTask: {
                await prepareThreadIfReady(
                    gitWorkingDirectory: gitWorkingDirectory,
                    showsGitControls: showsGitControls
                )
            },
            onInitialAppear: {
                handleInitialAppear(activeTurnID: activeTurnID)
            },
            onPhotoPickerItemsChanged: { newItems in
                // Defer the observable-model mutation out of the .onChange action
                // to avoid AttributeGraph cycles when the parent re-renders.
                DispatchQueue.main.async { [viewModel] in
                    viewModel.enqueuePhotoPickerItems(newItems, codex: codex, threadID: thread.id)
                    viewModel.photoPickerItems = []
                }
            },
            onActiveTurnChanged: { newValue in
                if newValue != nil {
                    // Defer the observable-model mutation out of the .onChange action
                    // to avoid AttributeGraph cycles when the parent re-renders.
                    DispatchQueue.main.async { [viewModel] in
                        viewModel.clearComposerAutocomplete()
                    }
                }
            },
            onThreadRunningChanged: { wasRunning, isRunning in
                guard wasRunning, !isRunning else { return }
                // Defer the observable-model mutation out of the .onChange action
                // to avoid AttributeGraph cycles when the parent re-renders.
                DispatchQueue.main.async { [viewModel] in
                    viewModel.flushQueueIfPossible(codex: codex, threadID: thread.id)
                    guard showsGitControls else { return }
                    viewModel.refreshGitBranchTargets(
                        codex: codex,
                        workingDirectory: gitWorkingDirectory,
                        threadID: thread.id
                    )
                }
            },
            onConnectionChanged: { wasConnected, isConnected in
                if !isConnected {
                    cancelVoiceRecordingIfNeeded()
                    invalidatePendingVoicePreflight()
                    clearVoiceRecovery()
                    return
                }
                clearVoiceRecovery()
                guard !wasConnected, isConnected else { return }
                // Defer the observable-model mutation out of the .onChange action
                // to avoid AttributeGraph cycles when the parent re-renders.
                DispatchQueue.main.async { [viewModel] in
                    viewModel.flushQueueIfPossible(codex: codex, threadID: thread.id)
                    guard showsGitControls else { return }
                    viewModel.refreshGitBranchTargets(
                        codex: codex,
                        workingDirectory: gitWorkingDirectory,
                        threadID: thread.id
                    )
                }
            },
            onScenePhaseChanged: { phase in
                guard phase != .active else { return }
                // Defer the observable-model mutation out of the .onChange action
                // to avoid AttributeGraph cycles when the parent re-renders.
                DispatchQueue.main.async { [viewModel] in
                    viewModel.saveLifecycleLocalDraft(codex: codex, threadID: thread.id)
                }
                cancelVoiceRecordingIfNeeded()
                invalidatePendingVoicePreflight()
            },
            onApprovalRequestChanged: {
                syncApprovalAlertPresentation()
            }
        )
        .onDisappear {
            cancelVoiceRecordingIfNeeded()
            invalidatePendingVoicePreflight()
            clearVoiceRecovery()
            viewModel.saveLifecycleLocalDraft(codex: codex, threadID: thread.id)
            viewModel.cancelTransientTasks()
            viewModel.clearComposerAutocomplete()
        }
        .onChange(of: isInputFocused) { _, isFocused in
            guard !isFocused else { return }
            // Defer the observable-model mutation out of the .onChange action
            // to avoid AttributeGraph cycles during send.
            DispatchQueue.main.async {
                viewModel.clearComposerAutocomplete()
            }
        }
        .onChange(of: showsGitControls) { _, isVisible in
            guard isVisible else { return }
            // A repo-bound thread can become actionable after connection/project metadata settles.
            DispatchQueue.main.async { [viewModel] in
                viewModel.refreshGitBranchTargets(
                    codex: codex,
                    workingDirectory: gitWorkingDirectory,
                    threadID: thread.id
                )
            }
        }
        .onChange(of: renderSnapshot.repoRefreshSignal) { _, newValue in
            guard showsGitControls, newValue != nil else { return }
            // Defer the observable-model mutation out of the .onChange action
            // to avoid AttributeGraph cycles when the parent re-renders.
            DispatchQueue.main.async { [viewModel] in
                viewModel.scheduleGitStatusRefresh(
                    codex: codex,
                    workingDirectory: gitWorkingDirectory,
                    threadID: thread.id
                )
            }
        }
        .onChange(of: renderSnapshot.timelineChangeToken) { _, _ in
            // Defer the observable-model mutation out of the .onChange action
            // to avoid AttributeGraph cycles when the parent re-renders.
            let messages = renderSnapshot.messages
            DispatchQueue.main.async { [viewModel] in
                viewModel.reconcileDismissedStructuredPlanPrompts(messages: messages, codex: codex)
            }
        }
        .onReceive(voiceTranscriptionManager.$recordingDuration) { duration in
            guard isVoiceRecording,
                  !isVoiceTranscribing,
                  !hasTriggeredVoiceAutoStop,
                  duration >= voiceAutoStopThreshold else {
                return
            }
            hasTriggeredVoiceAutoStop = true
            Task { @MainActor in
                await stopVoiceTranscription()
            }
        }
        .sheet(isPresented: $isShowingThreadPathSheet) {
            if let context = threadNavigationContext(for: resolvedThread) {
                TurnThreadPathSheet(
                    context: context,
                    threadTitle: resolvedThread.displayTitle,
                    onRenameThread: { newName in
                        codex.renameThread(thread.id, name: newName)
                    }
                )
            }
        }
        .sheet(isPresented: $isShowingStatusSheet) {
            TurnStatusSheet(
                contextWindowUsage: codex.contextWindowUsageByThread[thread.id],
                rateLimitBuckets: codex.rateLimitBuckets,
                isLoadingRateLimits: codex.isLoadingRateLimits,
                rateLimitsErrorMessage: codex.rateLimitsErrorMessage
            )
        }
        .sheet(isPresented: $isShowingGoalSheet, onDismiss: clearGoalSheetState) {
            GoalStatusSheet(threadId: thread.id, initialObjectiveDraft: goalSheetObjectivePrefill) { _ in
                consumeComposerDraftAfterGoalSubmission()
            }
            .environment(codex)
        }
        .sheet(isPresented: $isShowingVoiceSetupSheet) {
            GPTVoiceSetupSheet()
        }
        .sheet(item: $repositoryDiffPresentation) { presentation in
            TurnDiffSheet(
                title: presentation.title,
                entries: presentation.entries,
                bodyText: presentation.bodyText,
                messageID: presentation.messageID
            )
        }
        .sheet(isPresented: assistantRevertSheetPresentedBinding) {
            if let assistantRevertSheetState {
                AssistantRevertSheet(
                    state: assistantRevertSheetState,
                    onClose: { self.assistantRevertSheetState = nil },
                    onConfirm: {
                        confirmAssistantRevert(gitWorkingDirectory: gitWorkingDirectory)
                    }
                )
            }
        }
        .turnViewAlerts(
            alertApprovalRequest: $alertApprovalRequest,
            isApprovalAlertPresented: $isApprovalAlertPresented,
            isShowingNothingToCommitAlert: isShowingNothingToCommitAlertBinding,
            gitSyncAlert: gitSyncAlertBinding,
            isShowingMacHandoffConfirm: $isShowingMacHandoffConfirm,
            macHandoffErrorMessage: $macHandoffErrorMessage,
            onDeclineApproval: { request in
                viewModel.decline(request, codex: codex) { didSucceed in
                    if didSucceed {
                        syncApprovalAlertPresentation()
                    } else {
                        restoreApprovalAlert(afterFailureOf: request)
                    }
                }
            },
            onApproveApproval: { request in
                viewModel.approve(request, codex: codex) { didSucceed in
                    if didSucceed {
                        syncApprovalAlertPresentation()
                    } else {
                        restoreApprovalAlert(afterFailureOf: request)
                    }
                }
            },
            onConfirmGitSyncAction: { alertAction in
                viewModel.confirmGitSyncAlertAction(
                    alertAction,
                    codex: codex,
                    workingDirectory: gitWorkingDirectory,
                    threadID: thread.id,
                    activeTurnID: codex.activeTurnID(for: thread.id)
                )
            },
            onDismissGitSyncAlert: {
                viewModel.dismissGitSyncAlert()
            },
            onConfirmMacHandoff: {
                continueOnDesktopApp()
            }
        )
        .alert(
            checkedOutElsewhereAlert?.title ?? "Branch already open elsewhere",
            isPresented: checkedOutElsewhereAlertIsPresented,
            presenting: checkedOutElsewhereAlert
        ) { alert in
            Button("Close", role: .cancel) {
                checkedOutElsewhereAlert = nil
            }
            if let threadID = alert.threadID {
                Button("Open Chat") {
                    checkedOutElsewhereAlert = nil
                    openThread(threadID)
                }
            }
        } message: { alert in
            Text(alert.message)
        }
    }
}
