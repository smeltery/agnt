package com.dotbrains.agnt.mobile.ui.turn

import android.util.Log
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dotbrains.agnt.mobile.BuildConfig
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.CodexAccessMode
import com.dotbrains.agnt.mobile.core.model.CodexCollaborationModeKind
import com.dotbrains.agnt.mobile.core.model.CodexPluginMetadata
import com.dotbrains.agnt.mobile.core.model.CodexReviewTarget
import com.dotbrains.agnt.mobile.core.model.CodexServiceTier
import com.dotbrains.agnt.mobile.core.model.TurnUsageSheetLogic
import com.dotbrains.agnt.mobile.core.transport.ConnectionState
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.GitBranchDisplayMapper
import com.dotbrains.agnt.mobile.data.gitWorkingDirectoryForGitActions
import com.dotbrains.agnt.mobile.data.loadGitBranchesWithStatus
import com.dotbrains.agnt.mobile.services.agent.threads.CodexLookupService
import com.dotbrains.agnt.mobile.services.agent.threads.isPluginListUnsupported
import com.dotbrains.agnt.mobile.ui.LocalAIChangeSetPersistence
import com.dotbrains.agnt.mobile.ui.agent.MessageList
import com.dotbrains.agnt.mobile.ui.home.RootReconnectUiState
import com.dotbrains.agnt.mobile.ui.turn.attachments.TurnComposerAttachment
import com.dotbrains.agnt.mobile.ui.turn.attachments.TurnComposerAttachmentState
import com.dotbrains.agnt.mobile.ui.turn.attachments.appendFileAttachmentsToDraft
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.SkillAutocompleteSuggestion
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.buildComposerAutocompleteState
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.extractThreadFileAutocompleteCandidates
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.isPluginAutocompleteQuery
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.loadSkillAutocompleteSuggestions
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.mentionChipsToFileMentions
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.mentionChipsToSkillMentions
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.mergeMentionChipsIntoDraft
import com.dotbrains.agnt.mobile.ui.turn.composer.ComposerMentionChipPayload
import com.dotbrains.agnt.mobile.ui.turn.composer.ComposerMentionKind
import com.dotbrains.agnt.mobile.ui.turn.composer.ReasoningEffortTitleStrings
import com.dotbrains.agnt.mobile.ui.turn.composer.TURN_COMPOSER_RUNTIME_AUTO_ID
import com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerBar
import com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerEvent
import com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerModel
import com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerReducer
import com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerReviewModeRules
import com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerSecondaryBar
import com.dotbrains.agnt.mobile.ui.turn.composer.TurnComposerTrailingTokens
import com.dotbrains.agnt.mobile.ui.turn.composer.buildRuntimeControlsState
import com.dotbrains.agnt.mobile.ui.turn.composer.formatTurnSendError
import com.dotbrains.agnt.mobile.ui.turn.recovery.TurnConnectionRecoverySnapshotBuilder
import com.dotbrains.agnt.mobile.ui.turn.timeline.SmartScrollNavigationCta
import com.dotbrains.agnt.mobile.ui.turn.timeline.buildChatAnchors
import com.dotbrains.agnt.mobile.ui.turn.timeline.buildSmartScrollNavigationState
import com.dotbrains.agnt.mobile.ui.turn.timeline.shouldFollowTimelineBottom
import com.dotbrains.agnt.mobile.ui.turn.toolbar.GitBranchPaneState
import com.dotbrains.agnt.mobile.ui.turn.toolbar.TurnPlanAccessoryCard
import com.dotbrains.agnt.mobile.ui.turn.toolbar.TurnReviewAccessoryCard
import com.dotbrains.agnt.mobile.ui.turn.toolbar.resolveReviewBaseBranch
import com.dotbrains.agnt.mobile.ui.turn.toolbar.reviewSelectableDefaultBranch
import com.dotbrains.agnt.mobile.ui.turn.toolbar.selectCompletedPlanAccessoryMessage
import com.dotbrains.agnt.mobile.ui.turn.toolbar.selectPinnedPlanAccessoryMessage
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

private const val MAX_COMPOSER_ATTACHMENTS = 4
private const val MAX_NON_IMAGE_ATTACHMENT_BYTES = 256 * 1024
private const val MAX_NON_IMAGE_ATTACHMENT_TEXT_CHARS = 8_000
private const val TIMELINE_INITIAL_RENDER_TAIL = 48
private const val TIMELINE_LOAD_EARLIER_PAGE = 80
private const val TIMELINE_STAGING_THRESHOLD = 72
private const val STARTUP_TRACE_TAG = "AgntStartup"
private const val SMART_SCROLL_FADE_JUMP_DISTANCE_ITEMS = 24
private val TurnConversationMessageListTopPadding = 112.dp

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
    var availableSkills by remember(threadId) { mutableStateOf<List<SkillAutocompleteSuggestion>>(emptyList()) }
    var availablePlugins by remember(threadId) { mutableStateOf<List<CodexPluginMetadata>>(emptyList()) }
    var pluginAutocompleteLoading by remember(threadId) { mutableStateOf(false) }
    var cachedPluginSearchIndexByRoot by remember(repository) { mutableStateOf<Map<String, List<CodexPluginMetadata>>>(emptyMap()) }
    var unsupportedPluginAutocompleteRoots by remember(repository) { mutableStateOf<Set<String>>(emptySet()) }
    var availableFileMatches by remember(threadId) {
        mutableStateOf<List<com.dotbrains.agnt.mobile.core.model.CodexFuzzyFileMatch>>(emptyList())
    }
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

    fun reviewDraftText(
        target: CodexReviewTarget,
        baseBranch: String?,
    ): String =
        when (target) {
            CodexReviewTarget.uncommittedChanges -> "Review current changes"
            CodexReviewTarget.baseBranch -> "Review against base branch ${baseBranch.orEmpty()}"
        }

    fun clearReviewTarget() {
        reviewTargetName = null
        reviewBaseBranch = null
    }

    fun selectReviewTarget(
        target: CodexReviewTarget,
        baseBranch: String? = null,
    ) {
        if (
            TurnComposerReviewModeRules.hasComposerContentConflictingWithReview(
                draftText = draft,
                mentionChipCount = mentionChips.size,
                readyAttachmentCount =
                    composerAttachments.count {
                        it.state is TurnComposerAttachmentState.ReadyImage ||
                            it.state is TurnComposerAttachmentState.ReadyFile
                    },
                hasBlockingAttachments =
                    composerAttachments.any {
                        it.state == TurnComposerAttachmentState.Loading ||
                            it.state is TurnComposerAttachmentState.Failed
                    },
                isPlanModeEnabled = isPlanModeEnabled,
            )
        ) {
            lastError = if (composerAttachments.isNotEmpty()) reviewNoAttachmentsMessage else reviewRequiresEmptyMessage
            return
        }
        reviewTargetName = target.name
        reviewBaseBranch =
            resolveReviewBaseBranch(
                selectedBaseBranch = baseBranch,
                defaultBranch = defaultReviewBaseBranch,
                availableBranches = loadedGitBranchSummary?.branches.orEmpty(),
            )
        draft = reviewDraftText(target, reviewBaseBranch)
        mentionChips = emptyList()
        isPlanModeEnabled = false
        lastError = null
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
        if (hasComposerDraftContent) {
            lastError = planApplyRequiresEmptyMessage
        } else {
            draft = "Implement plan."
            isPlanModeEnabled = false
            mentionChips = emptyList()
        }
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

    // Restore the saved composer draft for this thread/mac.
    LaunchedEffect(threadId, currentTrustedMacDeviceId) {
        draft = runCatching { repository.loadComposerDraft(threadId) }.getOrDefault("")
        loadedDraftKey = "${currentTrustedMacDeviceId.orEmpty()}|$threadId"
    }

    // Persist edits once the draft for the current key has loaded. The key guard
    // prevents the freshly-reset draft from overwriting another thread's draft
    // before its restore completes.
    LaunchedEffect(threadId, currentTrustedMacDeviceId, draft, loadedDraftKey) {
        val draftKey = "${currentTrustedMacDeviceId.orEmpty()}|$threadId"
        if (loadedDraftKey == draftKey) {
            runCatching { repository.saveComposerDraft(threadId, draft) }
        }
    }

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

    LaunchedEffect(threadId, ready, connectionState, activeThread?.cwd) {
        if (!ready || connectionState !is ConnectionState.Connected) {
            availableSkills = emptyList()
            return@LaunchedEffect
        }
        availableSkills =
            runCatching {
                loadSkillAutocompleteSuggestions(repository, activeThread?.cwd)
            }.getOrDefault(emptyList())
    }

    LaunchedEffect(threadId) {
        lastError = null
        draft = ""
        composerAttachments = emptyList()
        mentionChips = emptyList()
        expandedPlanAccessoryMessageId = null
    }

    LaunchedEffect(threadId, gitCwd, connectionState, ready, gitBranchReloadNonce) {
        when {
            gitCwd == null -> {
                gitBranchPaneState = GitBranchPaneState.UnavailableNoProject
                return@LaunchedEffect
            }
            connectionState !is ConnectionState.Connected -> {
                gitBranchPaneState = GitBranchPaneState.AwaitingBridge
                return@LaunchedEffect
            }
            !ready -> {
                gitBranchPaneState = GitBranchPaneState.Loading
                return@LaunchedEffect
            }
            else -> {
                gitBranchPaneState = GitBranchPaneState.Loading
                val result = loadGitBranchesWithStatus(repository, gitCwd)
                gitBranchPaneState =
                    result.fold(
                        onSuccess = {
                            GitBranchPaneState.Loaded(GitBranchDisplayMapper.summaryFrom(it))
                        },
                        onFailure = {
                            GitBranchPaneState.Failed(GitBranchDisplayMapper.userVisibleMessage(it))
                        },
                    )
            }
        }
    }

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
    var visibleTailCount by rememberSaveable(threadId) { mutableIntStateOf(TIMELINE_INITIAL_RENDER_TAIL) }
    LaunchedEffect(threadId, messages.size) {
        if (messages.size <= TIMELINE_STAGING_THRESHOLD) {
            visibleTailCount = messages.size.coerceAtLeast(TIMELINE_INITIAL_RENDER_TAIL)
        } else if (visibleTailCount < TIMELINE_INITIAL_RENDER_TAIL) {
            visibleTailCount = TIMELINE_INITIAL_RENDER_TAIL
        }
        if (BuildConfig.DEBUG) {
            Log.d(
                STARTUP_TRACE_TAG,
                "timeline source thread=$threadId messages=${messages.size} visibleTail=$visibleTailCount",
            )
        }
    }
    val visibleMessages =
        remember(messages, visibleTailCount) {
            if (messages.size <= TIMELINE_STAGING_THRESHOLD) {
                messages
            } else {
                messages.takeLast(visibleTailCount.coerceAtMost(messages.size))
            }
        }
    val hiddenEarlierCount = (messages.size - visibleMessages.size).coerceAtLeast(0)
    val historyPaginationState = historyPaginationByThread[threadId]
    val canLoadOlderRemoteHistory = historyPaginationState?.canLoadOlder == true
    val isLoadingOlderHistory = threadId in loadingOlderHistoryThreadIds
    val olderHistoryError = olderHistoryErrorByThread[threadId]
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
    val fileAutocompleteCandidates =
        remember(messages) {
            extractThreadFileAutocompleteCandidates(messages)
        }
    val trailingToken =
        remember(draft) { TurnComposerTrailingTokens.parseTrailingToken(draft) }
    LaunchedEffect(
        threadId,
        ready,
        connectionState,
        activeThread?.cwd,
        trailingToken?.payload?.kind,
        trailingToken?.payload?.semanticValue,
    ) {
        val parse = trailingToken
        if (!ready || connectionState !is ConnectionState.Connected || parse?.payload?.kind != ComposerMentionKind.File) {
            availableFileMatches = emptyList()
            return@LaunchedEffect
        }
        val query = parse.payload.semanticValue.trim()
        val cwd = activeThread?.cwd?.trim()?.takeIf { it.isNotEmpty() }
        if (cwd.isNullOrEmpty() || query.isEmpty()) {
            availableFileMatches = emptyList()
            return@LaunchedEffect
        }
        availableFileMatches =
            runCatching {
                lookupService.fuzzyFileSearch(query = query, roots = listOf(cwd))
            }.getOrDefault(emptyList())
    }
    LaunchedEffect(
        threadId,
        ready,
        connectionState,
        activeThread?.cwd,
        trailingToken?.payload?.kind,
        trailingToken?.payload?.semanticValue,
    ) {
        val parse = trailingToken
        val shouldLoadPlugins =
            parse?.payload?.kind == ComposerMentionKind.Plugin ||
                (parse?.payload?.kind == ComposerMentionKind.File && isPluginAutocompleteQuery(parse.payload.semanticValue))
        if (!ready || connectionState !is ConnectionState.Connected || !shouldLoadPlugins) {
            availablePlugins = emptyList()
            pluginAutocompleteLoading = false
            return@LaunchedEffect
        }
        val cwd = activeThread?.cwd?.trim()?.takeIf { it.isNotEmpty() }
        if (cwd.isNullOrEmpty()) {
            availablePlugins = emptyList()
            pluginAutocompleteLoading = false
            return@LaunchedEffect
        }
        cachedPluginSearchIndexByRoot[cwd]?.let { cached ->
            availablePlugins = cached
            pluginAutocompleteLoading = false
            return@LaunchedEffect
        }
        if (unsupportedPluginAutocompleteRoots.contains(cwd)) {
            availablePlugins = emptyList()
            pluginAutocompleteLoading = false
            return@LaunchedEffect
        }
        pluginAutocompleteLoading = true
        runCatching {
            lookupService.listPlugins(cwds = listOf(cwd), forceReload = false)
        }.onSuccess { plugins ->
            cachedPluginSearchIndexByRoot = cachedPluginSearchIndexByRoot + (cwd to plugins)
            availablePlugins = plugins
        }.onFailure { error ->
            if (isPluginListUnsupported(error)) {
                unsupportedPluginAutocompleteRoots = unsupportedPluginAutocompleteRoots + cwd
            }
            availablePlugins = emptyList()
        }
        pluginAutocompleteLoading = false
    }
    val autocompleteState =
        remember(
            trailingToken,
            availableSkills,
            availablePlugins,
            pluginAutocompleteLoading,
            fileAutocompleteCandidates,
            availableFileMatches,
            isThreadRunning,
        ) {
            buildComposerAutocompleteState(
                parse = trailingToken,
                skillSuggestions = availableSkills,
                pluginSuggestions = availablePlugins,
                fileCandidates = fileAutocompleteCandidates,
                fileMatches = availableFileMatches,
                isThreadRunning = isThreadRunning,
                isPluginLoading = pluginAutocompleteLoading,
            )
        }
    val listState = rememberLazyListState()
    val latestMessageId = visibleMessages.lastOrNull()?.id
    var lastAutoScrollThreadId by remember { mutableStateOf<String?>(null) }
    var shouldAutoFollowBottom by rememberSaveable(threadId) { mutableStateOf(true) }
    var timelineContentVisible by remember(threadId) { mutableStateOf(true) }
    val timelineContentAlpha by animateFloatAsState(
        targetValue = if (timelineContentVisible) 1f else 0.18f,
        label = "timeline-content-alpha",
    )
    val timelineBlurRadius by animateDpAsState(
        targetValue = if (timelineContentVisible) 0.dp else 10.dp,
        label = "timeline-content-blur",
    )
    val shouldFollowBottom by remember {
        derivedStateOf {
            shouldFollowTimelineBottom(
                totalItemsCount = listState.layoutInfo.totalItemsCount,
                lastVisibleItemIndex =
                    listState.layoutInfo.visibleItemsInfo
                        .lastOrNull()
                        ?.index,
            )
        }
    }
    val firstVisibleListItemIndex by remember {
        derivedStateOf { listState.firstVisibleItemIndex }
    }
    val lastVisibleListItemIndex by remember {
        derivedStateOf {
            listState.layoutInfo.visibleItemsInfo
                .lastOrNull()
                ?.index
        }
    }
    val totalListItemCount by remember {
        derivedStateOf { listState.layoutInfo.totalItemsCount }
    }
    val timelineListItemOffset =
        if (hiddenEarlierCount > 0 || canLoadOlderRemoteHistory) {
            1
        } else {
            0
        }
    val chatAnchors =
        remember(visibleMessages, timelineListItemOffset) {
            buildChatAnchors(
                messages = visibleMessages,
                listItemOffset = timelineListItemOffset,
            )
        }
    val smartScrollNavigationState =
        remember(
            totalListItemCount,
            firstVisibleListItemIndex,
            lastVisibleListItemIndex,
            chatAnchors,
            shouldFollowBottom,
            latestMessageId,
        ) {
            buildSmartScrollNavigationState(
                totalItemsCount = totalListItemCount,
                firstVisibleItemIndex = firstVisibleListItemIndex,
                lastVisibleItemIndex = lastVisibleListItemIndex,
                anchors = chatAnchors,
                isNearBottom = shouldFollowBottom,
            )
        }
    LaunchedEffect(threadId) {
        lastAutoScrollThreadId = threadId
        if (visibleMessages.isNotEmpty()) {
            listState.scrollToItem(visibleMessages.lastIndex)
            if (BuildConfig.DEBUG) {
                Log.d(
                    STARTUP_TRACE_TAG,
                    "timeline scrolled thread=$threadId visible=${visibleMessages.size} hiddenEarlier=$hiddenEarlierCount reason=thread",
                )
            }
        }
    }
    LaunchedEffect(threadId, listState) {
        snapshotFlow { shouldFollowBottom to listState.isScrollInProgress }
            .distinctUntilChanged()
            .collect { (isAtBottom, isScrolling) ->
                if (isScrolling) {
                    shouldAutoFollowBottom = isAtBottom
                }
            }
    }
    LaunchedEffect(latestMessageId, shouldFollowBottom) {
        if (shouldFollowBottom) {
            shouldAutoFollowBottom = true
        }
    }
    LaunchedEffect(latestMessageId, visibleMessages.size, shouldAutoFollowBottom) {
        if (visibleMessages.isNotEmpty() && shouldAutoFollowBottom && lastAutoScrollThreadId == threadId) {
            listState.animateScrollToItem(visibleMessages.lastIndex)
            if (BuildConfig.DEBUG) {
                Log.d(
                    STARTUP_TRACE_TAG,
                    "timeline scrolled thread=$threadId visible=${visibleMessages.size} hiddenEarlier=$hiddenEarlierCount reason=followBottom",
                )
            }
        }
    }
    val readyComposerImageAttachments =
        remember(composerAttachments) {
            composerAttachments.mapNotNull { attachment ->
                (attachment.state as? TurnComposerAttachmentState.ReadyImage)?.attachment
            }
        }
    val readyComposerFileAttachments =
        remember(composerAttachments) {
            composerAttachments.mapNotNull { attachment ->
                (attachment.state as? TurnComposerAttachmentState.ReadyFile)?.attachment
            }
        }
    val runtimeLoadingLabel = stringResource(R.string.turn_runtime_loading)
    val runtimeModelFallbackLabel = stringResource(R.string.turn_runtime_model_fallback)
    val runtimeNoModelsLabel = stringResource(R.string.turn_runtime_no_models)
    val runtimeAutoLabel = stringResource(R.string.turn_runtime_auto)
    val runtimeNormalLabel = stringResource(R.string.turn_runtime_normal)
    val reasoningEffortTitles =
        ReasoningEffortTitleStrings(
            low = stringResource(R.string.turn_runtime_reasoning_title_low),
            medium = stringResource(R.string.turn_runtime_reasoning_title_medium),
            high = stringResource(R.string.turn_runtime_reasoning_title_high),
            xhigh = stringResource(R.string.turn_runtime_reasoning_title_xhigh),
        )
    val runtimeControls =
        remember(
            availableModels,
            isLoadingModels,
            selectedModelId,
            selectedReasoningEffort,
            selectedAccessMode,
            selectedServiceTier,
            runtimeLoadingLabel,
            runtimeModelFallbackLabel,
            runtimeNoModelsLabel,
            runtimeAutoLabel,
            runtimeNormalLabel,
            reasoningEffortTitles,
        ) {
            buildRuntimeControlsState(
                models = availableModels,
                isLoadingModels = isLoadingModels,
                selectedModelId = selectedModelId,
                selectedReasoningEffort = selectedReasoningEffort,
                selectedAccessMode = selectedAccessMode,
                selectedServiceTier = selectedServiceTier,
                loadingLabel = runtimeLoadingLabel,
                modelFallbackLabel = runtimeModelFallbackLabel,
                noModelsLabel = runtimeNoModelsLabel,
                autoLabel = runtimeAutoLabel,
                normalTierLabel = runtimeNormalLabel,
                reasoningEffortTitles = reasoningEffortTitles,
            )
        }
    val draftWithMentions =
        remember(draft, mentionChips) {
            mergeMentionChipsIntoDraft(draft, mentionChips)
        }
    val structuredSkillMentions =
        remember(mentionChips) {
            mentionChipsToSkillMentions(mentionChips)
        }
    val structuredFileMentions =
        remember(mentionChips) {
            mentionChipsToFileMentions(mentionChips)
        }
    val composerModel =
        remember(
            ready,
            sending,
            draftWithMentions,
            composerAttachments,
            mentionChips,
            voiceControls.phase,
            isThreadRunning,
            voiceControls.isTranscribing,
        ) {
            listOf<TurnComposerEvent>(
                TurnComposerEvent.SetEnabled(ready),
                TurnComposerEvent.SetSending(sending),
                TurnComposerEvent.SetDraftText(draftWithMentions),
                TurnComposerEvent.SetReadyAttachmentCount(
                    composerAttachments.count {
                        it.state is TurnComposerAttachmentState.ReadyImage ||
                            it.state is TurnComposerAttachmentState.ReadyFile
                    },
                ),
                TurnComposerEvent.SetHasBlockingAttachments(
                    composerAttachments.any {
                        it.state == TurnComposerAttachmentState.Loading ||
                            it.state is TurnComposerAttachmentState.Failed
                    },
                ),
                TurnComposerEvent.SetVoicePhase(voiceControls.phase),
                TurnComposerEvent.SetThreadRunning(isThreadRunning),
                TurnComposerEvent.SetTranscribing(voiceControls.isTranscribing),
            ).fold(TurnComposerModel()) { state, evt ->
                TurnComposerReducer.reduce(state, evt)
            }
        }
    val composerLocks = remember(composerModel) { composerModel.deriveInteractionLocks() }

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
                MessageList(
                    messages = visibleMessages,
                    listState = listState,
                    commandExecutionDetailsByItemId = commandExecutionDetailsByItemId,
                    onOpenFullMessage = { fullTimelineMessage = it },
                    isAssistantTurnActive = isThreadRunning,
                    activeTurnId = activeTurnId,
                    hiddenEarlierCount = hiddenEarlierCount,
                    canLoadOlderRemoteHistory = canLoadOlderRemoteHistory,
                    isLoadingOlderHistory = isLoadingOlderHistory,
                    olderHistoryError = olderHistoryError,
                    contentPadding =
                        PaddingValues(
                            top = TurnConversationMessageListTopPadding,
                            bottom = 18.dp,
                            start = 2.dp,
                            end = 2.dp,
                        ),
                    onLoadEarlierMessages =
                        if (hiddenEarlierCount > 0 || canLoadOlderRemoteHistory) {
                            {
                                if (canLoadOlderRemoteHistory && hiddenEarlierCount <= TIMELINE_LOAD_EARLIER_PAGE) {
                                    scope.launch { runCatching { repository.loadOlderThreadHistory(threadId) } }
                                } else {
                                    visibleTailCount =
                                        (visibleTailCount + TIMELINE_LOAD_EARLIER_PAGE)
                                            .coerceAtMost(messages.size)
                                    if (BuildConfig.DEBUG) {
                                        Log.d(
                                            STARTUP_TRACE_TAG,
                                            "timeline loadEarlier thread=$threadId visibleTail=$visibleTailCount total=${messages.size}",
                                        )
                                    }
                                }
                            }
                        } else {
                            null
                        },
                    assistantUndoChangeSetsByMessageId = assistantUndoChangeSetsByMessageId,
                    applyingUndoChangeSetIds = applyingUndoChangeSetIds,
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
                    forkThreadEnabled =
                        ready &&
                            connectionState is ConnectionState.Connected &&
                            !isThreadRunning &&
                            !forkingThread,
                    modifier =
                        Modifier
                            .fillMaxSize()
                            .blur(timelineBlurRadius)
                            .alpha(timelineContentAlpha),
                )
                SmartScrollNavigationCta(
                    state = smartScrollNavigationState,
                    onNavigate = { requestedIndex ->
                        val targetIndex =
                            requestedIndex.coerceIn(
                                minimumValue = 0,
                                maximumValue = (listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0),
                            )
                        scope.launch {
                            val distanceItems = kotlin.math.abs(targetIndex - listState.firstVisibleItemIndex)
                            if (distanceItems >= SMART_SCROLL_FADE_JUMP_DISTANCE_ITEMS) {
                                timelineContentVisible = false
                                delay(90L)
                                listState.scrollToItem(targetIndex)
                                delay(120L)
                                timelineContentVisible = true
                            } else {
                                listState.animateScrollToItem(targetIndex)
                            }
                            if (targetIndex >= (listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)) {
                                shouldAutoFollowBottom = true
                            } else {
                                shouldAutoFollowBottom = false
                            }
                        }
                    },
                    modifier =
                        Modifier
                            .align(Alignment.BottomCenter)
                            .padding(bottom = 14.dp),
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
                model = composerModel,
                isPlanModeEnabled = isPlanModeEnabled,
                runtimeControls = runtimeControls,
                mentionChips = mentionChips,
                autocomplete = autocompleteState,
                onDraftChange = { next ->
                    draft = next
                    val target = reviewTarget
                    if (target != null && next.trim() != reviewDraftText(target, reviewBaseBranch)) {
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
                    val replaced =
                        TurnComposerTrailingTokens.replaceTrailingSegment(
                            text = draft,
                            replacement = item.replacementText,
                            parse = trailingToken,
                        )
                    draft = replaced.text
                    when (item.payload.kind) {
                        ComposerMentionKind.File,
                        ComposerMentionKind.Skill,
                        ComposerMentionKind.Plugin,
                        -> {
                            if (mentionChips.none { it.kind == item.payload.kind && it.semanticValue == item.payload.semanticValue }) {
                                mentionChips = mentionChips + item.payload
                            }
                        }
                        ComposerMentionKind.SlashCommand -> {
                            when {
                                item.payload.semanticValue.equals("fork", ignoreCase = true) -> {
                                    draft = replaced.text.removeSuffix("/fork ").trimEnd()
                                    showForkThreadSheet = true
                                    lastError = null
                                }
                                item.payload.semanticValue.equals("feedback", ignoreCase = true) -> {
                                    draft = replaced.text.removeSuffix("/feedback ").trimEnd()
                                    showFeedbackDialog = true
                                    lastError = null
                                }
                                item.payload.semanticValue.equals("compact", ignoreCase = true) -> {
                                    draft = (replaced.text.trimEnd() + " /compact").trim()
                                    mentionChips =
                                        mentionChips.filterNot { chip ->
                                            chip.kind == ComposerMentionKind.SlashCommand &&
                                                chip.semanticValue.equals("compact", ignoreCase = true)
                                        }
                                    lastError = null
                                }
                                item.payload.semanticValue.equals("review", ignoreCase = true) -> {
                                    selectReviewTarget(CodexReviewTarget.uncommittedChanges)
                                }
                                item.payload.semanticValue.equals("review-base", ignoreCase = true) -> {
                                    val branch = defaultReviewBaseBranch
                                    if (branch == null) {
                                        draft = replaced.text.removeSuffix("/review-base ").trimEnd()
                                        lastError = reviewNoDefaultBranchMessage
                                    } else {
                                        selectReviewTarget(CodexReviewTarget.baseBranch, branch)
                                    }
                                }
                            }
                        }
                    }
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
                                    runtimeControls.accessMode.enabled,
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
                    voiceControls.cancelActiveWork()
                    lastError = null
                    val activeReviewTarget = reviewTarget
                    if (activeReviewTarget != null) {
                        if (isThreadRunning) {
                            lastError = reviewRunningUnavailableMessage
                            return@TurnComposerBar
                        }
                        val activeReviewBaseBranch = resolvedReviewBaseBranch
                        if (activeReviewTarget.name == "baseBranch" && activeReviewBaseBranch == null) {
                            lastError = reviewNoBaseBranchAvailableMessage
                            return@TurnComposerBar
                        }
                        if (composerAttachments.isNotEmpty()) {
                            lastError = reviewNoAttachmentsMessage
                            return@TurnComposerBar
                        }
                        sending = true
                        scope.launch {
                            runCatching {
                                repository.startReview(
                                    threadId = threadId,
                                    target = activeReviewTarget,
                                    baseBranch = activeReviewBaseBranch,
                                )
                            }.onSuccess {
                                sending = false
                                draft = ""
                                mentionChips = emptyList()
                                clearReviewTarget()
                            }.onFailure { e ->
                                sending = false
                                lastError =
                                    formatTurnSendError(e)
                            }
                        }
                        return@TurnComposerBar
                    }
                    val draftText =
                        appendFileAttachmentsToDraft(
                            baseText = draftWithMentions,
                            files = readyComposerFileAttachments,
                            binarySummary = attachmentFileBinarySummary,
                        )
                    val attachmentsToSend = readyComposerImageAttachments
                    val collaborationMode =
                        if (isPlanModeEnabled) {
                            CodexCollaborationModeKind.plan
                        } else {
                            null
                        }
                    dispatchTurn(
                        text = draftText,
                        attachments = attachmentsToSend,
                        skillMentions = structuredSkillMentions,
                        fileMentions = structuredFileMentions,
                        collaborationMode = collaborationMode,
                        fromQueue = false,
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
    TurnConversationPaneSheetHost(
        showForkThreadSheet = showForkThreadSheet,
        projectPath = activeThread?.cwd,
        forkingThread = forkingThread,
        onDismissForkThread = {
            if (!forkingThread) showForkThreadSheet = false
        },
        onConfirmForkThread = {
            scope.launch {
                forkingThread = true
                runCatching {
                    val forked = repository.forkThread(threadId, targetProjectPath = activeThread?.cwd)
                    repository.setActiveThreadId(forked.id)
                    showForkThreadSheet = false
                    lastError = null
                }.onFailure { e ->
                    lastError =
                        formatTurnSendError(e)
                }
                forkingThread = false
            }
        },
        showFeedbackDialog = showFeedbackDialog,
        onDismissFeedbackDialog = { showFeedbackDialog = false },
        onSubmitFeedback = { showFeedbackDialog = false },
        showWorktreeHandoffSheet = showWorktreeHandoffSheet,
        isWorktreeProject = activeThread?.isManagedWorktreeProject == true,
        isHandingOffWorktree = isHandingOffWorktree,
        loadedGitBranchSummary = loadedGitBranchSummary,
        defaultReviewBaseBranch = defaultReviewBaseBranch,
        sourceProjectPath = gitCwd,
        localTargetPath = localWorktreeHandoffTargetPath,
        associatedWorktreePath = repository.associatedManagedWorktreePathFor(threadId),
        worktreeHandoffError = worktreeHandoffError,
        onDismissWorktreeHandoff = {
            if (!isHandingOffWorktree) showWorktreeHandoffSheet = false
        },
        onConfirmWorktreeHandoff = { selectedBaseBranch ->
            handoffCurrentThread(selectedBaseBranch)
        },
        showPlanDetailsSheet = showPlanDetailsSheet,
        visiblePlanAccessoryMessage = visiblePlanAccessoryMessage,
        canApplyPlan = !isThreadRunning && !sending,
        onDismissPlanDetails = { showPlanDetailsSheet = false },
        onApplyPlanDetails = {
            applyPlanToComposer()
            if (!hasComposerDraftContent) {
                showPlanDetailsSheet = false
            }
        },
        fullTimelineMessage = fullTimelineMessage,
        onDismissFullTimelineMessage = { fullTimelineMessage = null },
    )
}
