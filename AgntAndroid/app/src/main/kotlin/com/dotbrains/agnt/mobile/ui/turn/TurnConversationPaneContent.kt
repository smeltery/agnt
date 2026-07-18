package com.dotbrains.agnt.mobile.ui.turn

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import com.dotbrains.agnt.mobile.core.model.AIChangeSet
import com.dotbrains.agnt.mobile.core.model.CodexAccessMode
import com.dotbrains.agnt.mobile.core.model.CodexImageAttachment
import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexReviewTarget
import com.dotbrains.agnt.mobile.core.model.CodexServiceTier
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.CodexThreadGoal
import com.dotbrains.agnt.mobile.core.model.CodexThreadGoalBudgetUpdate
import com.dotbrains.agnt.mobile.core.model.CodexThreadGoalStatus
import com.dotbrains.agnt.mobile.core.model.CodexTurnMention
import com.dotbrains.agnt.mobile.core.model.CodexTurnSkillMention
import com.dotbrains.agnt.mobile.core.model.CommandExecutionDetails
import com.dotbrains.agnt.mobile.core.persistence.AIChangeSetPersistence
import com.dotbrains.agnt.mobile.core.transport.ConnectionState
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.QueuedTurnDraftPreview
import com.dotbrains.agnt.mobile.ui.home.RootReconnectUiState
import com.dotbrains.agnt.mobile.ui.turn.attachments.TurnComposerAttachment
import com.dotbrains.agnt.mobile.ui.turn.composer.ComposerMentionChipPayload
import com.dotbrains.agnt.mobile.ui.turn.composer.TURN_COMPOSER_RUNTIME_AUTO_ID
import com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerBar
import com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerSecondaryBar
import com.dotbrains.agnt.mobile.ui.turn.recovery.TurnConnectionRecoverySnapshot
import com.dotbrains.agnt.mobile.ui.turn.toolbar.GitBranchPaneState
import com.dotbrains.agnt.mobile.ui.turn.toolbar.ThreadGoalControl
import com.dotbrains.agnt.mobile.ui.turn.toolbar.TurnPlanAccessoryCard
import com.dotbrains.agnt.mobile.ui.turn.toolbar.TurnReviewAccessoryCard
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

@Composable
internal fun TurnConversationPaneContent(
    modifier: Modifier,
    timelineState: TurnConversationTimelineState,
    commandExecutionDetailsByItemId: Map<String, CommandExecutionDetails>,
    isThreadRunning: Boolean,
    activeTurnId: String?,
    assistantUndoChangeSetsByMessageId: Map<String, AIChangeSet>,
    applyingUndoChangeSetIds: Set<String>,
    ready: Boolean,
    connectionState: ConnectionState,
    forkingThread: Boolean,
    activeThread: CodexThread?,
    repository: CodexRepository,
    aiChangeSetPersistence: AIChangeSetPersistence,
    scope: CoroutineScope,
    threadId: String,
    undoMissingCwdMessage: String,
    undoFailedMessage: String,
    checkoutElsewhereBlockedMessage: String,
    lastError: String?,
    gitBranchCheckoutError: String?,
    worktreeHandoffError: String?,
    inlineUndoError: String?,
    connectionRecoverySnapshot: TurnConnectionRecoverySnapshot?,
    reconnectUiState: RootReconnectUiState,
    onOpenPairingScanner: () -> Unit,
    onWakeSavedComputer: () -> Unit,
    onReconnectSavedPairing: () -> Unit,
    queuedDraftPreviews: List<QueuedTurnDraftPreview>,
    queuedDraftCount: Int,
    canRestoreQueuedDrafts: Boolean,
    attachmentOverflowMessage: String,
    queuedDraftRestoreBlockedMessage: String,
    reviewTarget: CodexReviewTarget?,
    resolvedReviewBaseBranch: String?,
    loadedGitBranchSummary: com.dotbrains.agnt.mobile.data.GitBranchDisplaySummary?,
    defaultReviewBaseBranch: String?,
    visiblePlanAccessoryMessage: CodexMessage?,
    expandedPlanAccessoryMessage: CodexMessage?,
    sending: Boolean,
    gitCwd: String?,
    gitBranchPaneState: GitBranchPaneState,
    threads: List<CodexThread>,
    isSwitchingGitBranch: Boolean,
    isHandingOffWorktree: Boolean,
    draft: String,
    composerAttachments: List<TurnComposerAttachment>,
    composerState: TurnConversationComposerModelState,
    composerLocks: com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerInteractionLocks,
    isPlanModeEnabled: Boolean,
    mentionChips: List<ComposerMentionChipPayload>,
    autocomplete: TurnConversationAutocompleteState,
    attachmentLaunchActions: TurnAttachmentLaunchActions,
    voiceControls: TurnVoiceControls,
    isBranchPickerOpen: Boolean,
    selectedAccessMode: CodexAccessMode,
    threadGoal: CodexThreadGoal?,
    threadGoalBusy: Boolean,
    threadGoalError: String?,
    branchPickerEnabled: Boolean,
    attachmentFileBinarySummary: String,
    reviewRunningUnavailableMessage: String,
    reviewNoBaseBranchAvailableMessage: String,
    reviewNoAttachmentsMessage: String,
    reviewNoDefaultBranchMessage: String,
    reviewBaseBranch: String?,
    localWorktreeHandoffTargetPath: String?,
    showForkThreadSheet: Boolean,
    showFeedbackDialog: Boolean,
    showWorktreeHandoffSheet: Boolean,
    showPlanDetailsSheet: Boolean,
    hasComposerDraftContent: Boolean,
    fullTimelineMessage: CodexMessage?,
    handoffCurrentThread: (String?) -> Unit,
    applyPlanToComposer: () -> Unit,
    clearReviewTarget: () -> Unit,
    selectReviewTarget: (CodexReviewTarget, String?) -> Unit,
    hydrateGitContextAfterMutation: suspend (String) -> Unit,
    dispatchTurn: (String, List<CodexImageAttachment>, List<CodexTurnSkillMention>, List<CodexTurnMention>, com.dotbrains.agnt.mobile.core.model.CodexCollaborationModeKind?, Boolean) -> Unit,
    stopActiveTurn: () -> Unit,
    setApplyingUndoChangeSetIds: (Set<String>) -> Unit,
    setInlineUndoError: (String?) -> Unit,
    refreshThreadChangeSets: () -> Unit,
    setLastError: (String?) -> Unit,
    setThreadGoalBusy: (Boolean) -> Unit,
    setThreadGoalError: (String?) -> Unit,
    setDraft: (String) -> Unit,
    setMentionChips: (List<ComposerMentionChipPayload>) -> Unit,
    setComposerAttachments: (List<TurnComposerAttachment>) -> Unit,
    setShowForkThreadSheet: (Boolean) -> Unit,
    setShowFeedbackDialog: (Boolean) -> Unit,
    setExpandedPlanAccessoryMessageId: (String?) -> Unit,
    setShowPlanDetailsSheet: (Boolean) -> Unit,
    setSwitchingGitBranch: (Boolean) -> Unit,
    setGitBranchCheckoutError: (String?) -> Unit,
    setGitBranchPaneState: (GitBranchPaneState) -> Unit,
    incrementGitBranchReloadNonce: () -> Unit,
    setPlanModeEnabled: (Boolean) -> Unit,
    setBranchPickerOpen: (Boolean) -> Unit,
    setWorktreeHandoffError: (String?) -> Unit,
    setShowWorktreeHandoffSheet: (Boolean) -> Unit,
    setSending: (Boolean) -> Unit,
    setForkingThread: (Boolean) -> Unit,
    setFullTimelineMessage: (CodexMessage?) -> Unit,
) {
    val imeBottomInset = WindowInsets.ime.asPaddingValues().calculateBottomPadding()
    val navigationBottomInset = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val isImeVisible = imeBottomInset > navigationBottomInset
    Box(
        modifier =
            modifier
                .fillMaxSize(),
    ) {
        Column(
            modifier =
                Modifier
                    .fillMaxSize()
                    .fillMaxWidth(),
        ) {
            Box(
                modifier =
                    Modifier
                        .weight(1f)
                        .fillMaxWidth(),
            ) {
                TurnConversationTimelinePane(
                    messages = timelineState.visibleMessages,
                    listState = timelineState.listState,
                    commandExecutionDetailsByItemId = commandExecutionDetailsByItemId,
                    isAssistantTurnActive = isThreadRunning,
                    activeTurnId = activeTurnId,
                    hiddenEarlierCount = timelineState.hiddenEarlierCount,
                    canLoadOlderRemoteHistory = timelineState.canLoadOlderRemoteHistory,
                    isLoadingOlderHistory = timelineState.isLoadingOlderHistory,
                    olderHistoryError = timelineState.olderHistoryError,
                    contentTopPadding = TurnConversationMessageListTopPadding,
                    timelineBlurRadius = timelineState.timelineBlurRadius,
                    timelineContentAlpha = timelineState.timelineContentAlpha,
                    smartScrollNavigationState = timelineState.smartScrollNavigationState,
                    assistantUndoChangeSetsByMessageId = assistantUndoChangeSetsByMessageId,
                    applyingUndoChangeSetIds = applyingUndoChangeSetIds,
                    forkThreadEnabled =
                        ready &&
                            connectionState is ConnectionState.Connected &&
                            !isThreadRunning &&
                            !forkingThread,
                    onOpenFullMessage = { setFullTimelineMessage(it) },
                    onLoadEarlierMessages = timelineState.onLoadEarlierMessages,
                    onUndoAssistantChanges = { changeSet ->
                        handleTurnAssistantUndo(
                            changeSet = changeSet,
                            activeThread = activeThread,
                            repository = repository,
                            aiChangeSetPersistence = aiChangeSetPersistence,
                            scope = scope,
                            applyingUndoChangeSetIds = applyingUndoChangeSetIds,
                            undoMissingCwdMessage = undoMissingCwdMessage,
                            undoFailedMessage = undoFailedMessage,
                            setApplyingUndoChangeSetIds = setApplyingUndoChangeSetIds,
                            setInlineUndoError = setInlineUndoError,
                            refreshThreadChangeSets = refreshThreadChangeSets,
                        )
                    },
                    onForkThread = {
                        setShowForkThreadSheet(true)
                        setLastError(null)
                    },
                    onSmartScrollNavigate = timelineState.onSmartScrollNavigate,
                )
            }
            TurnConversationPaneInlineStatus(
                lastError = lastError,
                gitBranchCheckoutError = gitBranchCheckoutError,
                worktreeHandoffError = worktreeHandoffError,
                inlineUndoError = inlineUndoError,
                connectionRecoverySnapshot = connectionRecoverySnapshot,
                reconnectUiState = reconnectUiState,
                onOpenPairingScanner = onOpenPairingScanner,
                onWakeSavedComputer = onWakeSavedComputer,
                onReconnectSavedPairing = onReconnectSavedPairing,
            )
            TurnConversationPaneQueuedDrafts(
                threadId = threadId,
                repository = repository,
                scope = scope,
                queuedDraftPreviews = queuedDraftPreviews,
                queuedDraftCount = queuedDraftCount,
                canRestoreQueuedDrafts = canRestoreQueuedDrafts,
                maxComposerAttachments = MAX_COMPOSER_ATTACHMENTS,
                attachmentOverflowMessage = attachmentOverflowMessage,
                queuedDraftRestoreBlockedMessage = queuedDraftRestoreBlockedMessage,
                setLastError = setLastError,
                setMentionChips = setMentionChips,
                setDraft = setDraft,
                setComposerAttachments = setComposerAttachments,
            )
            reviewTarget?.let { target ->
                TurnReviewAccessoryCard(
                    target = target,
                    selectedBaseBranch = resolvedReviewBaseBranch,
                    availableBranches = loadedGitBranchSummary?.branches.orEmpty(),
                    currentBranch = loadedGitBranchSummary?.currentBranch,
                    defaultBranch = defaultReviewBaseBranch,
                    onSelectCurrentChanges = {
                        selectReviewTarget(CodexReviewTarget.uncommittedChanges, null)
                    },
                    onSelectBaseBranch = { branch ->
                        selectReviewTarget(CodexReviewTarget.baseBranch, branch)
                    },
                    onDismiss = {
                        clearReviewTarget()
                        setDraft("")
                    },
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
            ThreadGoalControl(
                goal = threadGoal,
                enabled = ready && connectionState is ConnectionState.Connected,
                busy = threadGoalBusy,
                errorMessage = threadGoalError,
                onSetGoal = { objective: String?, status: CodexThreadGoalStatus?, budget: CodexThreadGoalBudgetUpdate ->
                    setThreadGoalBusy(true)
                    setThreadGoalError(null)
                    scope.launch {
                        runCatching {
                            repository.setThreadGoal(
                                threadId = threadId,
                                objective = objective,
                                status = status,
                                tokenBudget = budget,
                            )
                        }.onFailure { error ->
                            setThreadGoalError(error.localizedMessage ?: error.message ?: "Unable to update thread goal.")
                        }
                        setThreadGoalBusy(false)
                    }
                },
                onClearGoal = {
                    setThreadGoalBusy(true)
                    setThreadGoalError(null)
                    scope.launch {
                        runCatching { repository.clearThreadGoal(threadId) }
                            .onFailure { error ->
                                setThreadGoalError(error.localizedMessage ?: error.message ?: "Unable to clear thread goal.")
                            }
                        setThreadGoalBusy(false)
                    }
                },
                onDismissError = { setThreadGoalError(null) },
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
            )
            visiblePlanAccessoryMessage?.let { planMessage ->
                TurnPlanAccessoryCard(
                    message = planMessage,
                    expanded = false,
                    onToggleExpanded = { setExpandedPlanAccessoryMessageId(planMessage.id) },
                    canApplyPlan = !isThreadRunning && !sending,
                    onApplyPlan = { applyPlanToComposer() },
                    onOpenDetailsSheet = {
                        setShowPlanDetailsSheet(true)
                        setLastError(null)
                    },
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 4.dp),
                )
            }
            val onGitCheckout: (String) -> Unit =
                { selectedBranch ->
                    handleTurnGitCheckout(
                        selectedBranch = selectedBranch,
                        cwd = gitCwd,
                        gitBranchPaneState = gitBranchPaneState,
                        checkoutElsewhereBlockedMessage = checkoutElsewhereBlockedMessage,
                        activeThread = activeThread,
                        threads = threads,
                        threadId = threadId,
                        repository = repository,
                        scope = scope,
                        setSwitchingGitBranch = setSwitchingGitBranch,
                        setGitBranchCheckoutError = setGitBranchCheckoutError,
                        hydrateGitContextAfterMutation = { targetThreadId ->
                            hydrateGitContextAfterMutation(targetThreadId)
                        },
                    )
                }
            val onGitCreateBranch: (String) -> Unit =
                { branchName ->
                    handleTurnGitCreateBranch(
                        branchName = branchName,
                        cwd = gitCwd,
                        gitBranchPaneState = gitBranchPaneState,
                        repository = repository,
                        scope = scope,
                        setSwitchingGitBranch = setSwitchingGitBranch,
                        setGitBranchCheckoutError = setGitBranchCheckoutError,
                        setGitBranchPaneState = setGitBranchPaneState,
                        hydrateGitContextAfterMutation = { hydrateGitContextAfterMutation(threadId) },
                    )
                }
            TurnComposerBar(
                draft = draft,
                attachments = composerAttachments,
                model = composerState.composerModel,
                isPlanModeEnabled = isPlanModeEnabled,
                runtimeControls = composerState.runtimeControls,
                mentionChips = mentionChips,
                autocomplete = autocomplete.autocompleteState,
                onDraftChange = { next ->
                    setDraft(next)
                    val target = reviewTarget
                    if (target != null && next.trim() != turnReviewDraftText(target, reviewBaseBranch)) {
                        clearReviewTarget()
                    }
                },
                onPickImages = attachmentLaunchActions.pickImages,
                onPickFiles = attachmentLaunchActions.pickFiles,
                onTakePhoto = attachmentLaunchActions.takePhoto,
                onSetPlanModeEnabled = { setPlanModeEnabled(it) },
                onSelectModel = { option ->
                    scope.launch { runCatching { repository.setSelectedModelId(option.id) } }
                },
                onSelectReasoningEffort = { option ->
                    scope.launch {
                        runCatching {
                            repository.setSelectedReasoningEffort(option.id.takeUnless { it == TURN_COMPOSER_RUNTIME_AUTO_ID })
                        }
                    }
                },
                onSelectAccessMode = { option ->
                    CodexAccessMode.entries.firstOrNull { it.name == option.id }?.let { mode ->
                        scope.launch { runCatching { repository.setSelectedAccessMode(mode) } }
                    }
                },
                onSelectServiceTier = { option ->
                    val tier = CodexServiceTier.entries.firstOrNull { it.name == option.id }
                    scope.launch { runCatching { repository.setSelectedServiceTier(tier) } }
                },
                onRemoveAttachment = { attachmentId ->
                    setComposerAttachments(composerAttachments.filterNot { it.id == attachmentId })
                },
                onRemoveMentionChip = { chip ->
                    setMentionChips(mentionChips.filterNot { it == chip })
                },
                onSelectAutocomplete = { item ->
                    handleTurnComposerAutocompleteSelection(
                        item = item,
                        draft = draft,
                        trailingToken = autocomplete.trailingToken,
                        mentionChips = mentionChips,
                        defaultReviewBaseBranch = defaultReviewBaseBranch,
                        reviewNoDefaultBranchMessage = reviewNoDefaultBranchMessage,
                        selectReviewTarget = { target, baseBranch -> selectReviewTarget(target, baseBranch) },
                        setDraft = setDraft,
                        setMentionChips = setMentionChips,
                        setShowForkThreadSheet = setShowForkThreadSheet,
                        setShowFeedbackDialog = setShowFeedbackDialog,
                        setLastError = setLastError,
                    )
                },
                onStopTurn = { stopActiveTurn() },
                voiceUiEnabled = voiceControls.isInteractionEnabled,
                voiceAudioLevels = voiceControls.audioLevels,
                voiceRecordingDurationSeconds = voiceControls.recordingDurationSeconds,
                onVoiceClick = voiceControls.onVoiceClick,
                onCancelVoiceRecording = voiceControls.onCancelRecording,
                composerEnvironment = {
                    if (!isImeVisible || isBranchPickerOpen) {
                        TurnComposerSecondaryBar(
                            threadId = threadId,
                            repository = repository,
                            isWorktreeProject = activeThread?.isManagedWorktreeProject == true,
                            worktreeHandoffEnabled =
                                gitCwd != null &&
                                    gitBranchPaneState is GitBranchPaneState.Loaded &&
                                    ready &&
                                    connectionState is ConnectionState.Connected &&
                                    !isThreadRunning &&
                                    !sending &&
                                    !isSwitchingGitBranch,
                            isHandingOffWorktree = isHandingOffWorktree,
                            onWorktreeHandoff = {
                                setShowWorktreeHandoffSheet(true)
                                setWorktreeHandoffError(null)
                            },
                            selectedAccessMode = selectedAccessMode,
                            accessPickerEnabled =
                                ready &&
                                    !composerLocks.runtimeControlsLocked &&
                                    composerState.runtimeControls.accessMode.enabled,
                            onSelectAccessMode = { mode ->
                                scope.launch { runCatching { repository.setSelectedAccessMode(mode) } }
                            },
                            gitBranchPaneState = gitBranchPaneState,
                            branchPickerEnabled = branchPickerEnabled,
                            isSwitchingGitBranch = isSwitchingGitBranch,
                            onRefreshGitBranches = { incrementGitBranchReloadNonce() },
                            onCheckoutGitBranch = onGitCheckout,
                            onCreateGitBranch = onGitCreateBranch,
                            onOpenBranchSelector = {},
                            onBranchPickerOpenChange = { isOpen ->
                                setBranchPickerOpen(isOpen)
                            },
                        )
                    }
                },
                onSend = {
                    handleTurnComposerSend(
                        threadId = threadId,
                        repository = repository,
                        scope = scope,
                        reviewTarget = reviewTarget,
                        resolvedReviewBaseBranch = resolvedReviewBaseBranch,
                        isThreadRunning = isThreadRunning,
                        composerAttachments = composerAttachments,
                        draftWithMentions = composerState.draftWithMentions,
                        readyComposerImageAttachments = composerState.readyComposerImageAttachments,
                        readyComposerFileAttachments = composerState.readyComposerFileAttachments,
                        structuredSkillMentions = composerState.structuredSkillMentions,
                        structuredFileMentions = composerState.structuredFileMentions,
                        isPlanModeEnabled = isPlanModeEnabled,
                        attachmentFileBinarySummary = attachmentFileBinarySummary,
                        reviewRunningUnavailableMessage = reviewRunningUnavailableMessage,
                        reviewNoBaseBranchAvailableMessage = reviewNoBaseBranchAvailableMessage,
                        reviewNoAttachmentsMessage = reviewNoAttachmentsMessage,
                        cancelVoiceWork = voiceControls.cancelActiveWork,
                        clearReviewTarget = { clearReviewTarget() },
                        setSending = setSending,
                        setDraft = setDraft,
                        setMentionChips = setMentionChips,
                        setLastError = setLastError,
                        dispatchTurn = dispatchTurn,
                    )
                },
            )
        }
        expandedPlanAccessoryMessage?.let { planMessage ->
            TurnPlanAccessoryCard(
                message = planMessage,
                expanded = true,
                onToggleExpanded = { setExpandedPlanAccessoryMessageId(null) },
                canApplyPlan = !isThreadRunning && !sending,
                onApplyPlan = { applyPlanToComposer() },
                onOpenDetailsSheet = {
                    setShowPlanDetailsSheet(true)
                    setLastError(null)
                },
                floating = true,
                modifier =
                    Modifier
                        .align(Alignment.Center)
                        .padding(horizontal = 18.dp, vertical = 24.dp)
                        .widthIn(max = 560.dp)
                        .zIndex(2f),
            )
        }
    }
    TurnConversationPaneSheetHostWithActions(
        threadId = threadId,
        repository = repository,
        scope = scope,
        activeThread = activeThread,
        gitCwd = gitCwd,
        showForkThreadSheet = showForkThreadSheet,
        forkingThread = forkingThread,
        showFeedbackDialog = showFeedbackDialog,
        showWorktreeHandoffSheet = showWorktreeHandoffSheet,
        isHandingOffWorktree = isHandingOffWorktree,
        loadedGitBranchSummary = loadedGitBranchSummary,
        defaultReviewBaseBranch = defaultReviewBaseBranch,
        localWorktreeHandoffTargetPath = localWorktreeHandoffTargetPath,
        worktreeHandoffError = worktreeHandoffError,
        showPlanDetailsSheet = showPlanDetailsSheet,
        visiblePlanAccessoryMessage = visiblePlanAccessoryMessage,
        isThreadRunning = isThreadRunning,
        sending = sending,
        hasComposerDraftContent = hasComposerDraftContent,
        fullTimelineMessage = fullTimelineMessage,
        handoffCurrentThread = { selectedBaseBranch -> handoffCurrentThread(selectedBaseBranch) },
        applyPlanToComposer = { applyPlanToComposer() },
        setForkingThread = setForkingThread,
        setShowForkThreadSheet = setShowForkThreadSheet,
        setShowFeedbackDialog = setShowFeedbackDialog,
        setShowWorktreeHandoffSheet = setShowWorktreeHandoffSheet,
        setShowPlanDetailsSheet = setShowPlanDetailsSheet,
        setFullTimelineMessage = { setFullTimelineMessage(it) },
        setLastError = setLastError,
    )
}
