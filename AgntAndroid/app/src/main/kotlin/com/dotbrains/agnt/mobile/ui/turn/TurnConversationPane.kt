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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.CodexAccessMode
import com.dotbrains.agnt.mobile.core.model.CodexCollaborationModeKind
import com.dotbrains.agnt.mobile.core.model.CodexReviewTarget
import com.dotbrains.agnt.mobile.core.model.CodexServiceTier
import com.dotbrains.agnt.mobile.core.model.TurnUsageSheetLogic
import com.dotbrains.agnt.mobile.core.transport.ConnectionState
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.gitWorkingDirectoryForGitActions
import com.dotbrains.agnt.mobile.services.agent.threads.CodexLookupService
import com.dotbrains.agnt.mobile.ui.LocalAIChangeSetPersistence
import com.dotbrains.agnt.mobile.ui.home.RootReconnectUiState
import com.dotbrains.agnt.mobile.ui.turn.attachments.TurnComposerAttachment
import com.dotbrains.agnt.mobile.ui.turn.composer.ComposerMentionChipPayload
import com.dotbrains.agnt.mobile.ui.turn.composer.TURN_COMPOSER_RUNTIME_AUTO_ID
import com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerBar
import com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerSecondaryBar
import com.dotbrains.agnt.mobile.ui.turn.recovery.TurnConnectionRecoverySnapshotBuilder
import com.dotbrains.agnt.mobile.ui.turn.toolbar.GitBranchPaneState
import com.dotbrains.agnt.mobile.ui.turn.toolbar.TurnPlanAccessoryCard
import com.dotbrains.agnt.mobile.ui.turn.toolbar.TurnReviewAccessoryCard
import com.dotbrains.agnt.mobile.ui.turn.toolbar.resolveReviewBaseBranch
import com.dotbrains.agnt.mobile.ui.turn.toolbar.reviewSelectableDefaultBranch
import com.dotbrains.agnt.mobile.ui.turn.toolbar.selectCompletedPlanAccessoryMessage
import com.dotbrains.agnt.mobile.ui.turn.toolbar.selectPinnedPlanAccessoryMessage
import kotlinx.coroutines.launch

private const val MAX_COMPOSER_ATTACHMENTS = 4
private const val MAX_NON_IMAGE_ATTACHMENT_BYTES = 256 * 1024
private const val MAX_NON_IMAGE_ATTACHMENT_TEXT_CHARS = 8_000

/**
 * Conversation shell: timeline + composer (text, send, image attachments).
 * Shaves a few dp off IME bottom padding so the composer sits slightly
 * closer to the keyboard.
 */
@Composable
fun TurnConversationPane(
    threadId: String,
    repository: CodexRepository,
    reconnectUiState: RootReconnectUiState = RootReconnectUiState(),
    onReconnectSavedPairing: () -> Unit = {},
    onWakeSavedComputer: () -> Unit = {},
    onOpenPairingScanner: () -> Unit = {},
    onGitContextChanged: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val ready by repository.isSessionReady.collectAsStateWithLifecycle()
    val currentTrustedMacDeviceId by repository.currentTrustedMacDeviceId.collectAsStateWithLifecycle()
    // Hoisted out of scope.launch / non-Composable callbacks so they re-cache on configuration change.
    val undoMissingCwdMessage = stringResource(R.string.turn_usage_revert_reason_missing_cwd)
    val undoFailedMessage = stringResource(R.string.turn_message_action_undo_failed)
    val checkoutElsewhereBlockedMessage = stringResource(R.string.git_branch_checkout_elsewhere_blocked)
    val availableModels by repository.availableModels.collectAsStateWithLifecycle()
    val isLoadingModels by repository.isLoadingModels.collectAsStateWithLifecycle()
    val selectedModelId by repository.selectedModelId.collectAsStateWithLifecycle()
    val selectedReasoningEffort by repository.selectedReasoningEffort.collectAsStateWithLifecycle()
    val selectedAccessMode by repository.selectedAccessMode.collectAsStateWithLifecycle()
    val selectedServiceTier by repository.selectedServiceTier.collectAsStateWithLifecycle()
    val messagesByThread by repository.messagesByThread.collectAsStateWithLifecycle()
    val commandExecutionDetailsByItemId by repository.commandExecutionDetailsByItemId.collectAsStateWithLifecycle()
    val historyPaginationByThread by repository.threadHistoryPaginationByThread.collectAsStateWithLifecycle()
    val loadingOlderHistoryThreadIds by repository.loadingOlderHistoryThreadIds.collectAsStateWithLifecycle()
    val olderHistoryErrorByThread by repository.olderHistoryErrorByThread.collectAsStateWithLifecycle()
    val threads by repository.threads.collectAsStateWithLifecycle()
    val connectionState by repository.connectionState.collectAsStateWithLifecycle()
    val bridgeSupportsVoiceTranscription by repository.bridgeSupportsVoiceTranscription.collectAsStateWithLifecycle()
    val activeProvider by repository.activeProvider.collectAsStateWithLifecycle()
    val hasResolvedRateLimits by repository.hasResolvedRateLimitsSnapshot.collectAsStateWithLifecycle()
    val isLoadingRateLimits by repository.isLoadingRateLimits.collectAsStateWithLifecycle()
    val rateLimitsError by repository.rateLimitsErrorMessage.collectAsStateWithLifecycle()
    val runningTurnByThread by repository.runningTurnIdByThread.collectAsStateWithLifecycle()
    val protectedRunningFallback by repository.protectedRunningFallbackThreadIds.collectAsStateWithLifecycle()
    val queuedDraftDepthByThread by repository.turnDraftQueueDepthByThread.collectAsStateWithLifecycle()
    val queuedDraftPreviewByThread by repository.turnDraftQueuePreviewByThread.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val aiChangeSetPersistence = LocalAIChangeSetPersistence.current
    var sending by remember { mutableStateOf(false) }
    var lastError by remember { mutableStateOf<String?>(null) }
    // Per-thread, per-mac so a half-typed message survives thread switches and relaunch
    // (loaded/saved via the mac-scoped session store) instead of bleeding across threads.
    var draft by remember(threadId, currentTrustedMacDeviceId) { mutableStateOf("") }
    var loadedDraftKey by remember { mutableStateOf<String?>(null) }
    var isPlanModeEnabled by rememberSaveable(threadId) { mutableStateOf(false) }
    var expandedPlanAccessoryMessageId by rememberSaveable(threadId) { mutableStateOf<String?>(null) }
    var composerAttachments by remember { mutableStateOf<List<TurnComposerAttachment>>(emptyList()) }
    var mentionChips by remember(threadId) { mutableStateOf<List<ComposerMentionChipPayload>>(emptyList()) }
    var showForkThreadSheet by remember(threadId) { mutableStateOf(false) }
    var showFeedbackDialog by remember(threadId) { mutableStateOf(false) }
    var showWorktreeHandoffSheet by remember(threadId) { mutableStateOf(false) }
    var forkingThread by remember(threadId) { mutableStateOf(false) }
    var showPlanDetailsSheet by remember(threadId) { mutableStateOf(false) }
    var fullTimelineMessage by remember(threadId) { mutableStateOf<com.dotbrains.agnt.mobile.core.model.CodexMessage?>(null) }
    var reviewTargetName by rememberSaveable(threadId) { mutableStateOf<String?>(null) }
    var reviewBaseBranch by rememberSaveable(threadId) { mutableStateOf<String?>(null) }
    val lookupService = remember(repository) { CodexLookupService(repository) }
    var threadChangeSets by remember(threadId) {
        mutableStateOf(TurnUsageSheetLogic.recentChangeSetsForThread(threadId, aiChangeSetPersistence.load(), limit = 50))
    }
    var applyingUndoChangeSetIds by remember(threadId) { mutableStateOf(emptySet<String>()) }
    var inlineUndoError by remember(threadId) { mutableStateOf<String?>(null) }

    val activeThread =
        remember(threadId, threads) {
            threads.firstOrNull { it.id == threadId }
        }
    val gitCwd =
        remember(activeThread) {
            activeThread.gitWorkingDirectoryForGitActions()
        }
    var gitBranchPaneState by remember(threadId) { mutableStateOf<GitBranchPaneState>(GitBranchPaneState.UnavailableNoProject) }
    var gitBranchReloadNonce by remember(threadId) { mutableIntStateOf(0) }
    var isSwitchingGitBranch by remember(threadId) { mutableStateOf(false) }
    var isHandingOffWorktree by remember(threadId) { mutableStateOf(false) }
    var isBranchPickerOpen by rememberSaveable(threadId) { mutableStateOf(false) }
    var gitBranchCheckoutError by remember(threadId) { mutableStateOf<String?>(null) }
    var worktreeHandoffError by remember(threadId) { mutableStateOf<String?>(null) }

    suspend fun hydrateGitContextAfterMutation(targetThreadId: String = threadId) {
        runCatching { repository.syncThreadHistory(targetThreadId, force = true) }
        gitBranchReloadNonce++
        onGitContextChanged()
    }

    val reviewTarget =
        remember(reviewTargetName) {
            reviewTargetName?.let { raw ->
                runCatching { CodexReviewTarget.valueOf(raw) }.getOrNull()
            }
        }
    val loadedGitBranchSummary =
        (gitBranchPaneState as? GitBranchPaneState.Loaded)?.summary
    val defaultReviewBaseBranch =
        remember(loadedGitBranchSummary) {
            reviewSelectableDefaultBranch(
                defaultBranch = loadedGitBranchSummary?.defaultBranch,
                availableBranches = loadedGitBranchSummary?.branches.orEmpty(),
            )
        }
    val resolvedReviewBaseBranch =
        remember(reviewBaseBranch, defaultReviewBaseBranch, loadedGitBranchSummary) {
            resolveReviewBaseBranch(
                selectedBaseBranch = reviewBaseBranch,
                defaultBranch = defaultReviewBaseBranch,
                availableBranches = loadedGitBranchSummary?.branches.orEmpty(),
            )
        }
    val localWorktreeHandoffTargetPath =
        remember(gitBranchPaneState) {
            val summary = (gitBranchPaneState as? GitBranchPaneState.Loaded)?.summary ?: return@remember null
            val preferredBranch = summary.defaultBranch ?: summary.currentBranch
            preferredBranch
                ?.let { summary.worktreePathByBranch[it]?.trim()?.takeIf { path -> path.isNotEmpty() } }
                ?: summary.worktreePathByBranch.values
                    .firstOrNull { it.isNotBlank() }
                    ?.trim()
        }

    val isThreadRunning =
        remember(threadId, runningTurnByThread, protectedRunningFallback) {
            runningTurnByThread.containsKey(threadId) || protectedRunningFallback.contains(threadId)
        }
    val activeTurnId =
        remember(threadId, runningTurnByThread) {
            runningTurnByThread[threadId]
        }
    val queuedDraftCount =
        remember(threadId, queuedDraftDepthByThread) {
            queuedDraftDepthByThread[threadId] ?: 0
        }
    val queuedDraftPreviews =
        remember(threadId, queuedDraftPreviewByThread) {
            queuedDraftPreviewByThread[threadId].orEmpty()
        }
    val hasComposerDraftContent =
        remember(draft, composerAttachments, mentionChips, isPlanModeEnabled, reviewTarget) {
            draft.trim().isNotEmpty() ||
                composerAttachments.isNotEmpty() ||
                mentionChips.isNotEmpty() ||
                isPlanModeEnabled ||
                reviewTarget != null
        }
    val canRestoreQueuedDrafts =
        remember(isThreadRunning, sending, hasComposerDraftContent) {
            !isThreadRunning && !sending && !hasComposerDraftContent
        }
    val branchPickerEnabled =
        remember(
            gitCwd,
            connectionState,
            ready,
            isThreadRunning,
            sending,
            isSwitchingGitBranch,
            isHandingOffWorktree,
            gitBranchPaneState,
        ) {
            gitCwd != null &&
                connectionState is ConnectionState.Connected &&
                ready &&
                !isThreadRunning &&
                !sending &&
                !isSwitchingGitBranch &&
                !isHandingOffWorktree &&
                gitBranchPaneState is GitBranchPaneState.Loaded
        }
    val connectionRecoverySnapshot =
        remember(connectionState, reconnectUiState) {
            TurnConnectionRecoverySnapshotBuilder.makeSnapshot(
                hasReconnectCandidate = true,
                connectionState = connectionState,
                reconnectUiState = reconnectUiState,
            )
        }

    val attachmentLimitMessage = stringResource(R.string.turn_attachment_limit, MAX_COMPOSER_ATTACHMENTS)
    val attachmentOverflowMessage = stringResource(R.string.turn_attachment_overflow, MAX_COMPOSER_ATTACHMENTS)
    val attachmentLoadFailedMessage = stringResource(R.string.turn_attachment_load_failed)
    val attachmentFileTooLargeMessage = stringResource(R.string.turn_attachment_file_too_large, MAX_NON_IMAGE_ATTACHMENT_BYTES / 1024)
    val attachmentFileBinarySummary = stringResource(R.string.turn_attachment_file_binary_summary)
    val attachmentCameraUnavailableMessage = stringResource(R.string.turn_attachment_camera_unavailable)
    val attachmentCameraPermissionDeniedMessage = stringResource(R.string.turn_attachment_camera_permission_denied)
    val voiceMicDeniedMessage = stringResource(R.string.turn_voice_mic_permission_denied)
    val voiceRecorderFailedMessage = stringResource(R.string.turn_voice_recorder_failed)
    val voiceNoAudioMessage = stringResource(R.string.turn_voice_no_audio)
    val voiceTranscriptionFailedMessage = stringResource(R.string.turn_voice_transcription_failed)
    val queuedDraftSendFailedMessage = stringResource(R.string.turn_queue_send_failed)
    val queuedDraftRestoreBlockedMessage = stringResource(R.string.turn_queue_restore_requires_empty)
    val planApplyRequiresEmptyMessage = stringResource(R.string.turn_plan_apply_requires_empty)
    val reviewRunningUnavailableMessage = stringResource(R.string.turn_review_unavailable_running)
    val reviewRequiresEmptyMessage = stringResource(R.string.turn_review_requires_empty)
    val reviewNoDefaultBranchMessage = stringResource(R.string.turn_review_no_default_branch)
    val reviewNoBaseBranchAvailableMessage = stringResource(R.string.turn_review_no_base_branch_available)
    val reviewNoAttachmentsMessage = stringResource(R.string.turn_review_no_attachments)
    val handoffMissingBaseMessage = stringResource(R.string.turn_worktree_handoff_missing_base)
    val handoffMissingLocalMessage = stringResource(R.string.turn_worktree_handoff_missing_local)

    fun clearReviewTarget() {
        reviewTargetName = null
        reviewBaseBranch = null
    }

    fun selectReviewTarget(
        target: CodexReviewTarget,
        baseBranch: String? = null,
    ) {
        selectTurnReviewTarget(
            target = target,
            baseBranch = baseBranch,
            draft = draft,
            mentionChips = mentionChips,
            composerAttachments = composerAttachments,
            isPlanModeEnabled = isPlanModeEnabled,
            defaultReviewBaseBranch = defaultReviewBaseBranch,
            loadedGitBranchSummary = loadedGitBranchSummary,
            reviewNoAttachmentsMessage = reviewNoAttachmentsMessage,
            reviewRequiresEmptyMessage = reviewRequiresEmptyMessage,
            setReviewTargetName = { reviewTargetName = it },
            setReviewBaseBranch = { reviewBaseBranch = it },
            setDraft = { draft = it },
            setMentionChips = { mentionChips = it },
            setPlanModeEnabled = { isPlanModeEnabled = it },
            setLastError = { lastError = it },
        )
    }

    fun handoffCurrentThread(selectedBaseBranch: String? = null) {
        handleTurnWorktreeHandoff(
            selectedBaseBranch = selectedBaseBranch,
            gitCwd = gitCwd,
            isThreadRunning = isThreadRunning,
            sending = sending,
            isHandingOffWorktree = isHandingOffWorktree,
            activeThread = activeThread,
            defaultReviewBaseBranch = defaultReviewBaseBranch,
            localWorktreeHandoffTargetPath = localWorktreeHandoffTargetPath,
            repository = repository,
            threadId = threadId,
            scope = scope,
            handoffMissingLocalMessage = handoffMissingLocalMessage,
            handoffMissingBaseMessage = handoffMissingBaseMessage,
            setWorktreeHandoffError = { worktreeHandoffError = it },
            setShowWorktreeHandoffSheet = { showWorktreeHandoffSheet = it },
            setHandingOffWorktree = { isHandingOffWorktree = it },
            afterMoved = { gitBranchReloadNonce++ },
        )
    }

    fun applyPlanToComposer() {
        applyTurnPlanToComposer(
            hasComposerDraftContent = hasComposerDraftContent,
            planApplyRequiresEmptyMessage = planApplyRequiresEmptyMessage,
            setDraft = { draft = it },
            setPlanModeEnabled = { isPlanModeEnabled = it },
            setMentionChips = { mentionChips = it },
            setLastError = { lastError = it },
        )
    }

    val attachmentLaunchActions =
        rememberTurnAttachmentLaunchActions(
            context = context,
            scope = scope,
            attachments = composerAttachments,
            updateAttachments = { transform ->
                composerAttachments = transform(composerAttachments)
            },
            setLastError = { message -> lastError = message },
            attachmentsAllowed = reviewTarget == null,
            attachmentsBlockedMessage = reviewNoAttachmentsMessage,
            maxAttachments = MAX_COMPOSER_ATTACHMENTS,
            maxNonImageAttachmentBytes = MAX_NON_IMAGE_ATTACHMENT_BYTES,
            maxNonImageAttachmentTextChars = MAX_NON_IMAGE_ATTACHMENT_TEXT_CHARS,
            attachmentLimitMessage = attachmentLimitMessage,
            attachmentOverflowMessage = attachmentOverflowMessage,
            attachmentLoadFailedMessage = attachmentLoadFailedMessage,
            attachmentFileTooLargeMessage = attachmentFileTooLargeMessage,
            attachmentCameraUnavailableMessage = attachmentCameraUnavailableMessage,
            attachmentCameraPermissionDeniedMessage = attachmentCameraPermissionDeniedMessage,
        )

    val voiceControls =
        rememberTurnVoiceControls(
            threadId = threadId,
            repository = repository,
            ready = ready,
            connectionState = connectionState,
            sending = sending,
            bridgeSupportsVoiceTranscription = bridgeSupportsVoiceTranscription,
            activeProvider = activeProvider,
            draft = draft,
            setDraft = { draft = it },
            setLastError = { lastError = it },
            micDeniedMessage = voiceMicDeniedMessage,
            recorderFailedMessage = voiceRecorderFailedMessage,
            noAudioMessage = voiceNoAudioMessage,
            transcriptionFailedMessage = voiceTranscriptionFailedMessage,
        )

    TurnConversationPaneDraftEffects(
        threadId = threadId,
        currentTrustedMacDeviceId = currentTrustedMacDeviceId,
        draft = draft,
        loadedDraftKey = loadedDraftKey,
        repository = repository,
        setDraft = { draft = it },
        setLoadedDraftKey = { loadedDraftKey = it },
    )

    LaunchedEffect(threadId, ready) {
        if (ready) {
            runCatching { repository.syncThreadHistory(threadId) }
            if (availableModels.isEmpty()) {
                runCatching { repository.refreshModels() }
            }
        }
    }

    LaunchedEffect(threadId, ready, connectionState, hasResolvedRateLimits, rateLimitsError, isLoadingRateLimits) {
        if (ready &&
            connectionState is ConnectionState.Connected &&
            rateLimitsError == null &&
            !isLoadingRateLimits &&
            repository.shouldAutoRefreshUsageStatus(threadId)
        ) {
            runCatching { repository.refreshUsageStatus(threadId) }
        }
    }

    LaunchedEffect(threadId) {
        lastError = null
        draft = ""
        composerAttachments = emptyList()
        mentionChips = emptyList()
        expandedPlanAccessoryMessageId = null
    }

    TurnConversationPaneGitBranchEffect(
        threadId = threadId,
        gitCwd = gitCwd,
        connectionState = connectionState,
        ready = ready,
        gitBranchReloadNonce = gitBranchReloadNonce,
        repository = repository,
        setGitBranchPaneState = { gitBranchPaneState = it },
    )

    val messages =
        remember(threadId, messagesByThread) {
            messagesByThread[threadId].orEmpty()
        }
    LaunchedEffect(threadId, messages.size) {
        threadChangeSets =
            TurnUsageSheetLogic.recentChangeSetsForThread(threadId, aiChangeSetPersistence.load(), limit = 50)
    }
    val assistantUndoChangeSetsByMessageId =
        remember(messages, threadChangeSets) {
            assistantUndoChangeSetsByMessageId(messages = messages, changeSets = threadChangeSets)
        }
    val timelineState =
        rememberTurnConversationTimelineState(
            threadId = threadId,
            repository = repository,
            scope = scope,
            messages = messages,
            historyPaginationByThread = historyPaginationByThread,
            loadingOlderHistoryThreadIds = loadingOlderHistoryThreadIds,
            olderHistoryErrorByThread = olderHistoryErrorByThread,
        )
    val pinnedPlanAccessoryMessage =
        remember(messages) {
            selectPinnedPlanAccessoryMessage(messages)
        }
    val completedPlanAccessoryMessage =
        remember(messages, pinnedPlanAccessoryMessage?.id) {
            if (pinnedPlanAccessoryMessage == null) selectCompletedPlanAccessoryMessage(messages) else null
        }
    val visiblePlanAccessoryMessage = pinnedPlanAccessoryMessage ?: completedPlanAccessoryMessage
    val expandedPlanAccessoryMessage =
        visiblePlanAccessoryMessage?.takeIf { it.id == expandedPlanAccessoryMessageId }
    LaunchedEffect(visiblePlanAccessoryMessage?.id) {
        expandedPlanAccessoryMessageId = null
    }
    val autocomplete =
        rememberTurnConversationAutocompleteState(
            threadId = threadId,
            repository = repository,
            lookupService = lookupService,
            ready = ready,
            connectionState = connectionState,
            activeThreadCwd = activeThread?.cwd,
            messages = messages,
            draft = draft,
            isThreadRunning = isThreadRunning,
        )
    val composerState =
        rememberTurnConversationComposerModelState(
            availableModels = availableModels,
            isLoadingModels = isLoadingModels,
            selectedModelId = selectedModelId,
            selectedReasoningEffort = selectedReasoningEffort,
            selectedAccessMode = selectedAccessMode,
            selectedServiceTier = selectedServiceTier,
            draft = draft,
            composerAttachments = composerAttachments,
            mentionChips = mentionChips,
            voicePhase = voiceControls.phase,
            isThreadRunning = isThreadRunning,
            isTranscribing = voiceControls.isTranscribing,
            ready = ready,
            sending = sending,
        )
    val composerLocks = remember(composerState.composerModel) { composerState.composerModel.deriveInteractionLocks() }

    fun dispatchTurn(
        text: String,
        attachments: List<com.dotbrains.agnt.mobile.core.model.CodexImageAttachment>,
        skillMentions: List<com.dotbrains.agnt.mobile.core.model.CodexTurnSkillMention>,
        fileMentions: List<com.dotbrains.agnt.mobile.core.model.CodexTurnMention>,
        collaborationMode: CodexCollaborationModeKind?,
        fromQueue: Boolean,
    ) {
        dispatchTurnFromConversationPane(
            text = text,
            attachments = attachments,
            skillMentions = skillMentions,
            fileMentions = fileMentions,
            collaborationMode = collaborationMode,
            fromQueue = fromQueue,
            threadId = threadId,
            repository = repository,
            scope = scope,
            isThreadRunning = isThreadRunning,
            queuedDraftSendFailedMessage = queuedDraftSendFailedMessage,
            setSending = { sending = it },
            clearComposer = {
                clearTurnComposerState(
                    setDraft = { draft = it },
                    setComposerAttachments = { composerAttachments = it },
                    setMentionChips = { mentionChips = it },
                )
            },
            setLastError = { lastError = it },
        )
    }

    fun stopActiveTurn() {
        stopTurnFromConversationPane(
            threadId = threadId,
            activeTurnId = activeTurnId,
            repository = repository,
            scope = scope,
            setLastError = { lastError = it },
        )
    }

    LaunchedEffect(threadId, isThreadRunning, sending, queuedDraftCount, hasComposerDraftContent) {
        if (isThreadRunning || sending || queuedDraftCount <= 0 || hasComposerDraftContent) return@LaunchedEffect
        val queued = runCatching { repository.pollTurnDraft(threadId) }.getOrNull() ?: return@LaunchedEffect
        dispatchTurn(
            text = queued.text,
            attachments = queued.attachments,
            skillMentions = queued.skillMentions,
            fileMentions = queued.fileMentions,
            collaborationMode = queued.collaborationMode,
            fromQueue = true,
        )
    }

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
                    onOpenFullMessage = { fullTimelineMessage = it },
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
                            setApplyingUndoChangeSetIds = { applyingUndoChangeSetIds = it },
                            setInlineUndoError = { inlineUndoError = it },
                            refreshThreadChangeSets = {
                                threadChangeSets =
                                    TurnUsageSheetLogic.recentChangeSetsForThread(
                                        threadId,
                                        aiChangeSetPersistence.load(),
                                        limit = 50,
                                    )
                            },
                        )
                    },
                    onForkThread = {
                        showForkThreadSheet = true
                        lastError = null
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
                setLastError = { lastError = it },
                setMentionChips = { mentionChips = it },
                setDraft = { draft = it },
                setComposerAttachments = { composerAttachments = it },
            )
            reviewTarget?.let { target ->
                TurnReviewAccessoryCard(
                    target = target,
                    selectedBaseBranch = resolvedReviewBaseBranch,
                    availableBranches = loadedGitBranchSummary?.branches.orEmpty(),
                    currentBranch = loadedGitBranchSummary?.currentBranch,
                    defaultBranch = defaultReviewBaseBranch,
                    onSelectCurrentChanges = {
                        selectReviewTarget(CodexReviewTarget.uncommittedChanges)
                    },
                    onSelectBaseBranch = { branch ->
                        selectReviewTarget(CodexReviewTarget.baseBranch, branch)
                    },
                    onDismiss = {
                        clearReviewTarget()
                        draft = ""
                    },
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
            visiblePlanAccessoryMessage?.let { planMessage ->
                TurnPlanAccessoryCard(
                    message = planMessage,
                    expanded = false,
                    onToggleExpanded = { expandedPlanAccessoryMessageId = planMessage.id },
                    canApplyPlan = !isThreadRunning && !sending,
                    onApplyPlan = { applyPlanToComposer() },
                    onOpenDetailsSheet = {
                        showPlanDetailsSheet = true
                        lastError = null
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
                        setSwitchingGitBranch = { isSwitchingGitBranch = it },
                        setGitBranchCheckoutError = { gitBranchCheckoutError = it },
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
                        setSwitchingGitBranch = { isSwitchingGitBranch = it },
                        setGitBranchCheckoutError = { gitBranchCheckoutError = it },
                        setGitBranchPaneState = { gitBranchPaneState = it },
                        hydrateGitContextAfterMutation = { hydrateGitContextAfterMutation() },
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
                    draft = next
                    val target = reviewTarget
                    if (target != null && next.trim() != turnReviewDraftText(target, reviewBaseBranch)) {
                        clearReviewTarget()
                    }
                },
                onPickImages = attachmentLaunchActions.pickImages,
                onPickFiles = attachmentLaunchActions.pickFiles,
                onTakePhoto = attachmentLaunchActions.takePhoto,
                onSetPlanModeEnabled = { isPlanModeEnabled = it },
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
                    composerAttachments = composerAttachments.filterNot { it.id == attachmentId }
                },
                onRemoveMentionChip = { chip ->
                    mentionChips = mentionChips.filterNot { it == chip }
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
                        setDraft = { draft = it },
                        setMentionChips = { mentionChips = it },
                        setShowForkThreadSheet = { showForkThreadSheet = it },
                        setShowFeedbackDialog = { showFeedbackDialog = it },
                        setLastError = { lastError = it },
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
                                showWorktreeHandoffSheet = true
                                worktreeHandoffError = null
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
                            onRefreshGitBranches = { gitBranchReloadNonce++ },
                            onCheckoutGitBranch = onGitCheckout,
                            onCreateGitBranch = onGitCreateBranch,
                            onOpenBranchSelector = {},
                            onBranchPickerOpenChange = { isOpen ->
                                isBranchPickerOpen = isOpen
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
                        setSending = { sending = it },
                        setDraft = { draft = it },
                        setMentionChips = { mentionChips = it },
                        setLastError = { lastError = it },
                        dispatchTurn = ::dispatchTurn,
                    )
                },
            )
        }
        expandedPlanAccessoryMessage?.let { planMessage ->
            TurnPlanAccessoryCard(
                message = planMessage,
                expanded = true,
                onToggleExpanded = { expandedPlanAccessoryMessageId = null },
                canApplyPlan = !isThreadRunning && !sending,
                onApplyPlan = { applyPlanToComposer() },
                onOpenDetailsSheet = {
                    showPlanDetailsSheet = true
                    lastError = null
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
        setForkingThread = { forkingThread = it },
        setShowForkThreadSheet = { showForkThreadSheet = it },
        setShowFeedbackDialog = { showFeedbackDialog = it },
        setShowWorktreeHandoffSheet = { showWorktreeHandoffSheet = it },
        setShowPlanDetailsSheet = { showPlanDetailsSheet = it },
        setFullTimelineMessage = { fullTimelineMessage = it },
        setLastError = { lastError = it },
    )
}
