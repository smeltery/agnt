package com.smeltery.agnt.mobile.ui.turn

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.smeltery.agnt.mobile.core.model.CodexReviewTarget
import com.smeltery.agnt.mobile.core.model.TurnUsageSheetLogic
import com.smeltery.agnt.mobile.core.transport.ConnectionState
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.services.agent.threads.CodexLookupService
import com.smeltery.agnt.mobile.ui.LocalAIChangeSetPersistence
import com.smeltery.agnt.mobile.ui.home.RootReconnectUiState
import com.smeltery.agnt.mobile.ui.turn.attachments.TurnComposerAttachment
import com.smeltery.agnt.mobile.ui.turn.composer.ComposerMentionChipPayload
import com.smeltery.agnt.mobile.ui.turn.toolbar.GitBranchPaneState
import com.smeltery.agnt.mobile.ui.turn.toolbar.selectCompletedPlanAccessoryMessage
import com.smeltery.agnt.mobile.ui.turn.toolbar.selectPinnedPlanAccessoryMessage

internal const val MAX_COMPOSER_ATTACHMENTS = 4
internal const val MAX_NON_IMAGE_ATTACHMENT_BYTES = 256 * 1024
internal const val MAX_NON_IMAGE_ATTACHMENT_TEXT_CHARS = 8_000

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
    val strings = rememberTurnConversationPaneStrings()
    val availableModels by repository.availableModels.collectAsStateWithLifecycle()
    val isLoadingModels by repository.isLoadingModels.collectAsStateWithLifecycle()
    val selectedModelId by repository.selectedModelId.collectAsStateWithLifecycle()
    val selectedReasoningEffort by repository.selectedReasoningEffort.collectAsStateWithLifecycle()
    val selectedAccessMode by repository.selectedAccessMode.collectAsStateWithLifecycle()
    val selectedServiceTier by repository.selectedServiceTier.collectAsStateWithLifecycle()
    val messagesByThread by repository.messagesByThread.collectAsStateWithLifecycle()
    val threadGoalsByThread by repository.threadGoalsByThread.collectAsStateWithLifecycle()
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
    var fullTimelineMessage by remember(threadId) { mutableStateOf<com.smeltery.agnt.mobile.core.model.CodexMessage?>(null) }
    var reviewTargetName by rememberSaveable(threadId) { mutableStateOf<String?>(null) }
    var reviewBaseBranch by rememberSaveable(threadId) { mutableStateOf<String?>(null) }
    val lookupService = remember(repository) { CodexLookupService(repository) }
    var threadChangeSets by remember(threadId) {
        mutableStateOf(TurnUsageSheetLogic.recentChangeSetsForThread(threadId, aiChangeSetPersistence.load(), limit = 50))
    }
    var applyingUndoChangeSetIds by remember(threadId) { mutableStateOf(emptySet<String>()) }
    var inlineUndoError by remember(threadId) { mutableStateOf<String?>(null) }
    var gitBranchPaneState by remember(threadId) { mutableStateOf<GitBranchPaneState>(GitBranchPaneState.UnavailableNoProject) }
    var gitBranchReloadNonce by remember(threadId) { mutableIntStateOf(0) }
    var isSwitchingGitBranch by remember(threadId) { mutableStateOf(false) }
    var isHandingOffWorktree by remember(threadId) { mutableStateOf(false) }
    var isBranchPickerOpen by rememberSaveable(threadId) { mutableStateOf(false) }
    var gitBranchCheckoutError by remember(threadId) { mutableStateOf<String?>(null) }
    var worktreeHandoffError by remember(threadId) { mutableStateOf<String?>(null) }
    var threadGoalBusy by remember(threadId) { mutableStateOf(false) }
    var threadGoalError by remember(threadId) { mutableStateOf<String?>(null) }

    suspend fun hydrateGitContextAfterMutation(targetThreadId: String = threadId) {
        runCatching { repository.syncThreadHistory(targetThreadId, force = true) }
        gitBranchReloadNonce++
        onGitContextChanged()
    }

    val gitReviewContext =
        rememberTurnConversationPaneGitReviewContext(
            threadId = threadId,
            threads = threads,
            reviewTargetName = reviewTargetName,
            reviewBaseBranch = reviewBaseBranch,
            gitBranchPaneState = gitBranchPaneState,
        )
    val activeThread = gitReviewContext.activeThread
    val threadGoal = threadGoalsByThread[threadId]
    val gitCwd = gitReviewContext.gitCwd
    val reviewTarget = gitReviewContext.reviewTarget
    val loadedGitBranchSummary = gitReviewContext.loadedGitBranchSummary
    val defaultReviewBaseBranch = gitReviewContext.defaultReviewBaseBranch
    val resolvedReviewBaseBranch = gitReviewContext.resolvedReviewBaseBranch
    val localWorktreeHandoffTargetPath = gitReviewContext.localWorktreeHandoffTargetPath

    val derivedState =
        rememberTurnConversationPaneDerivedState(
            threadId = threadId,
            runningTurnByThread = runningTurnByThread,
            protectedRunningFallback = protectedRunningFallback,
            queuedDraftDepthByThread = queuedDraftDepthByThread,
            queuedDraftPreviewByThread = queuedDraftPreviewByThread,
            draft = draft,
            composerAttachments = composerAttachments,
            mentionChips = mentionChips,
            isPlanModeEnabled = isPlanModeEnabled,
            reviewTarget = reviewTarget,
            sending = sending,
            gitCwd = gitCwd,
            connectionState = connectionState,
            ready = ready,
            isSwitchingGitBranch = isSwitchingGitBranch,
            isHandingOffWorktree = isHandingOffWorktree,
            gitBranchPaneState = gitBranchPaneState,
            reconnectUiState = reconnectUiState,
        )
    val isThreadRunning = derivedState.isThreadRunning
    val activeTurnId = derivedState.activeTurnId
    val queuedDraftCount = derivedState.queuedDraftCount
    val queuedDraftPreviews = derivedState.queuedDraftPreviews
    val hasComposerDraftContent = derivedState.hasComposerDraftContent
    val canRestoreQueuedDrafts = derivedState.canRestoreQueuedDrafts
    val branchPickerEnabled = derivedState.branchPickerEnabled
    val connectionRecoverySnapshot = derivedState.connectionRecoverySnapshot

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
            reviewNoAttachmentsMessage = strings.reviewNoAttachments,
            reviewRequiresEmptyMessage = strings.reviewRequiresEmpty,
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
            handoffMissingLocalMessage = strings.handoffMissingLocal,
            handoffMissingBaseMessage = strings.handoffMissingBase,
            setWorktreeHandoffError = { worktreeHandoffError = it },
            setShowWorktreeHandoffSheet = { showWorktreeHandoffSheet = it },
            setHandingOffWorktree = { isHandingOffWorktree = it },
            afterMoved = { gitBranchReloadNonce++ },
        )
    }

    fun applyPlanToComposer() {
        applyTurnPlanToComposer(
            hasComposerDraftContent = hasComposerDraftContent,
            planApplyRequiresEmptyMessage = strings.planApplyRequiresEmpty,
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
            attachmentsBlockedMessage = strings.reviewNoAttachments,
            maxAttachments = MAX_COMPOSER_ATTACHMENTS,
            maxNonImageAttachmentBytes = MAX_NON_IMAGE_ATTACHMENT_BYTES,
            maxNonImageAttachmentTextChars = MAX_NON_IMAGE_ATTACHMENT_TEXT_CHARS,
            attachmentLimitMessage = strings.attachmentLimit,
            attachmentOverflowMessage = strings.attachmentOverflow,
            attachmentLoadFailedMessage = strings.attachmentLoadFailed,
            attachmentFileTooLargeMessage = strings.attachmentFileTooLarge,
            attachmentCameraUnavailableMessage = strings.attachmentCameraUnavailable,
            attachmentCameraPermissionDeniedMessage = strings.attachmentCameraPermissionDenied,
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
            micDeniedMessage = strings.voiceMicDenied,
            recorderFailedMessage = strings.voiceRecorderFailed,
            noAudioMessage = strings.voiceNoAudio,
            transcriptionFailedMessage = strings.voiceTranscriptionFailed,
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
            runCatching { repository.refreshThreadGoal(threadId) }
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
        threadGoalError = null
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

    val turnActions =
        rememberTurnConversationPaneTurnActions(
            threadId = threadId,
            repository = repository,
            scope = scope,
            isThreadRunning = isThreadRunning,
            activeTurnId = activeTurnId,
            queuedDraftCount = queuedDraftCount,
            hasComposerDraftContent = hasComposerDraftContent,
            sending = sending,
            queuedDraftSendFailedMessage = strings.queuedDraftSendFailed,
            setSending = { sending = it },
            setDraft = { draft = it },
            setComposerAttachments = { composerAttachments = it },
            setMentionChips = { mentionChips = it },
            setLastError = { lastError = it },
        )

    TurnConversationPaneContent(
        modifier = modifier,
        timelineState = timelineState,
        commandExecutionDetailsByItemId = commandExecutionDetailsByItemId,
        isThreadRunning = isThreadRunning,
        activeTurnId = activeTurnId,
        assistantUndoChangeSetsByMessageId = assistantUndoChangeSetsByMessageId,
        applyingUndoChangeSetIds = applyingUndoChangeSetIds,
        ready = ready,
        connectionState = connectionState,
        forkingThread = forkingThread,
        activeThread = activeThread,
        repository = repository,
        aiChangeSetPersistence = aiChangeSetPersistence,
        scope = scope,
        threadId = threadId,
        undoMissingCwdMessage = strings.undoMissingCwd,
        undoFailedMessage = strings.undoFailed,
        checkoutElsewhereBlockedMessage = strings.checkoutElsewhereBlocked,
        lastError = lastError,
        gitBranchCheckoutError = gitBranchCheckoutError,
        worktreeHandoffError = worktreeHandoffError,
        inlineUndoError = inlineUndoError,
        connectionRecoverySnapshot = connectionRecoverySnapshot,
        reconnectUiState = reconnectUiState,
        onOpenPairingScanner = onOpenPairingScanner,
        onWakeSavedComputer = onWakeSavedComputer,
        onReconnectSavedPairing = onReconnectSavedPairing,
        queuedDraftPreviews = queuedDraftPreviews,
        queuedDraftCount = queuedDraftCount,
        canRestoreQueuedDrafts = canRestoreQueuedDrafts,
        attachmentOverflowMessage = strings.attachmentOverflow,
        queuedDraftRestoreBlockedMessage = strings.queuedDraftRestoreBlocked,
        reviewTarget = reviewTarget,
        resolvedReviewBaseBranch = resolvedReviewBaseBranch,
        loadedGitBranchSummary = loadedGitBranchSummary,
        defaultReviewBaseBranch = defaultReviewBaseBranch,
        visiblePlanAccessoryMessage = visiblePlanAccessoryMessage,
        expandedPlanAccessoryMessage = expandedPlanAccessoryMessage,
        sending = sending,
        gitCwd = gitCwd,
        gitBranchPaneState = gitBranchPaneState,
        threads = threads,
        isSwitchingGitBranch = isSwitchingGitBranch,
        isHandingOffWorktree = isHandingOffWorktree,
        draft = draft,
        composerAttachments = composerAttachments,
        composerState = composerState,
        composerLocks = composerLocks,
        isPlanModeEnabled = isPlanModeEnabled,
        mentionChips = mentionChips,
        autocomplete = autocomplete,
        attachmentLaunchActions = attachmentLaunchActions,
        voiceControls = voiceControls,
        isBranchPickerOpen = isBranchPickerOpen,
        selectedAccessMode = selectedAccessMode,
        threadGoal = threadGoal,
        threadGoalBusy = threadGoalBusy,
        threadGoalError = threadGoalError,
        branchPickerEnabled = branchPickerEnabled,
        attachmentFileBinarySummary = strings.attachmentFileBinarySummary,
        reviewRunningUnavailableMessage = strings.reviewRunningUnavailable,
        reviewNoBaseBranchAvailableMessage = strings.reviewNoBaseBranchAvailable,
        reviewNoAttachmentsMessage = strings.reviewNoAttachments,
        reviewNoDefaultBranchMessage = strings.reviewNoDefaultBranch,
        reviewBaseBranch = reviewBaseBranch,
        localWorktreeHandoffTargetPath = localWorktreeHandoffTargetPath,
        showForkThreadSheet = showForkThreadSheet,
        showFeedbackDialog = showFeedbackDialog,
        showWorktreeHandoffSheet = showWorktreeHandoffSheet,
        showPlanDetailsSheet = showPlanDetailsSheet,
        hasComposerDraftContent = hasComposerDraftContent,
        fullTimelineMessage = fullTimelineMessage,
        handoffCurrentThread = { selectedBaseBranch -> handoffCurrentThread(selectedBaseBranch) },
        applyPlanToComposer = { applyPlanToComposer() },
        clearReviewTarget = { clearReviewTarget() },
        selectReviewTarget = { target, baseBranch -> selectReviewTarget(target, baseBranch) },
        hydrateGitContextAfterMutation = { targetThreadId -> hydrateGitContextAfterMutation(targetThreadId) },
        dispatchTurn = turnActions.dispatchTurn,
        stopActiveTurn = turnActions.stopActiveTurn,
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
        setLastError = { lastError = it },
        setThreadGoalBusy = { threadGoalBusy = it },
        setThreadGoalError = { threadGoalError = it },
        setDraft = { draft = it },
        setMentionChips = { mentionChips = it },
        setComposerAttachments = { composerAttachments = it },
        setShowForkThreadSheet = { showForkThreadSheet = it },
        setShowFeedbackDialog = { showFeedbackDialog = it },
        setExpandedPlanAccessoryMessageId = { expandedPlanAccessoryMessageId = it },
        setShowPlanDetailsSheet = { showPlanDetailsSheet = it },
        setSwitchingGitBranch = { isSwitchingGitBranch = it },
        setGitBranchCheckoutError = { gitBranchCheckoutError = it },
        setGitBranchPaneState = { gitBranchPaneState = it },
        incrementGitBranchReloadNonce = { gitBranchReloadNonce++ },
        setPlanModeEnabled = { isPlanModeEnabled = it },
        setBranchPickerOpen = { isBranchPickerOpen = it },
        setWorktreeHandoffError = { worktreeHandoffError = it },
        setShowWorktreeHandoffSheet = { showWorktreeHandoffSheet = it },
        setSending = { sending = it },
        setForkingThread = { forkingThread = it },
        setFullTimelineMessage = { fullTimelineMessage = it },
    )
}
