package com.smeltery.agnt.mobile.ui.turn

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.AIChangeSet
import com.smeltery.agnt.mobile.core.model.CodexMessage
import com.smeltery.agnt.mobile.core.model.CodexMessageRole
import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.core.model.TurnUsageSheetLogic
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.data.GitBranchDisplaySummary
import com.smeltery.agnt.mobile.ui.turn.composer.formatTurnSendError
import com.smeltery.agnt.mobile.ui.turn.recovery.TurnFeedbackDialog
import com.smeltery.agnt.mobile.ui.turn.timeline.TurnRichMarkdownBody
import com.smeltery.agnt.mobile.ui.turn.toolbar.ForkThreadActionSheet
import com.smeltery.agnt.mobile.ui.turn.toolbar.PlanDetailsActionSheet
import com.smeltery.agnt.mobile.ui.turn.toolbar.WorktreeHandoffActionSheet
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

@Composable
internal fun TurnConversationPaneSheetHost(
    showForkThreadSheet: Boolean,
    projectPath: String?,
    forkingThread: Boolean,
    onDismissForkThread: () -> Unit,
    onConfirmForkThread: () -> Unit,
    showFeedbackDialog: Boolean,
    onDismissFeedbackDialog: () -> Unit,
    onSubmitFeedback: () -> Unit,
    showWorktreeHandoffSheet: Boolean,
    isWorktreeProject: Boolean,
    isHandingOffWorktree: Boolean,
    loadedGitBranchSummary: GitBranchDisplaySummary?,
    defaultReviewBaseBranch: String?,
    sourceProjectPath: String?,
    localTargetPath: String?,
    associatedWorktreePath: String?,
    worktreeHandoffError: String?,
    onDismissWorktreeHandoff: () -> Unit,
    onConfirmWorktreeHandoff: (String?) -> Unit,
    showPlanDetailsSheet: Boolean,
    visiblePlanAccessoryMessage: CodexMessage?,
    canApplyPlan: Boolean,
    onDismissPlanDetails: () -> Unit,
    onApplyPlanDetails: () -> Unit,
    fullTimelineMessage: CodexMessage?,
    onDismissFullTimelineMessage: () -> Unit,
) {
    ForkThreadActionSheet(
        visible = showForkThreadSheet,
        projectPath = projectPath,
        inProgress = forkingThread,
        onDismiss = onDismissForkThread,
        onConfirm = onConfirmForkThread,
    )
    if (showFeedbackDialog) {
        TurnFeedbackDialog(
            onDismiss = onDismissFeedbackDialog,
            onSubmit = { onSubmitFeedback() },
        )
    }
    WorktreeHandoffActionSheet(
        visible = showWorktreeHandoffSheet,
        isWorktreeProject = isWorktreeProject,
        inProgress = isHandingOffWorktree,
        availableBaseBranches = loadedGitBranchSummary?.branches.orEmpty(),
        defaultBaseBranch = defaultReviewBaseBranch,
        currentBranch = loadedGitBranchSummary?.currentBranch,
        sourceProjectPath = sourceProjectPath,
        localTargetPath = localTargetPath,
        associatedWorktreePath = associatedWorktreePath,
        hasAssociatedWorktree = associatedWorktreePath != null,
        errorMessage = worktreeHandoffError,
        onDismiss = onDismissWorktreeHandoff,
        onConfirm = onConfirmWorktreeHandoff,
    )
    PlanDetailsActionSheet(
        visible = showPlanDetailsSheet,
        message = visiblePlanAccessoryMessage,
        canApplyPlan = canApplyPlan,
        onDismiss = onDismissPlanDetails,
        onApplyPlan = onApplyPlanDetails,
    )
    FullTimelineMessageSheet(
        message = fullTimelineMessage,
        onDismiss = onDismissFullTimelineMessage,
    )
}

@Composable
internal fun TurnConversationPaneSheetHostWithActions(
    threadId: String,
    repository: CodexRepository,
    scope: CoroutineScope,
    activeThread: CodexThread?,
    gitCwd: String?,
    showForkThreadSheet: Boolean,
    forkingThread: Boolean,
    showFeedbackDialog: Boolean,
    showWorktreeHandoffSheet: Boolean,
    isHandingOffWorktree: Boolean,
    loadedGitBranchSummary: GitBranchDisplaySummary?,
    defaultReviewBaseBranch: String?,
    localWorktreeHandoffTargetPath: String?,
    worktreeHandoffError: String?,
    showPlanDetailsSheet: Boolean,
    visiblePlanAccessoryMessage: CodexMessage?,
    isThreadRunning: Boolean,
    sending: Boolean,
    hasComposerDraftContent: Boolean,
    fullTimelineMessage: CodexMessage?,
    handoffCurrentThread: (String?) -> Unit,
    applyPlanToComposer: () -> Unit,
    setForkingThread: (Boolean) -> Unit,
    setShowForkThreadSheet: (Boolean) -> Unit,
    setShowFeedbackDialog: (Boolean) -> Unit,
    setShowWorktreeHandoffSheet: (Boolean) -> Unit,
    setShowPlanDetailsSheet: (Boolean) -> Unit,
    setFullTimelineMessage: (CodexMessage?) -> Unit,
    setLastError: (String?) -> Unit,
) {
    TurnConversationPaneSheetHost(
        showForkThreadSheet = showForkThreadSheet,
        projectPath = activeThread?.cwd,
        forkingThread = forkingThread,
        onDismissForkThread = {
            if (!forkingThread) setShowForkThreadSheet(false)
        },
        onConfirmForkThread = {
            scope.launch {
                setForkingThread(true)
                runCatching {
                    val forked = repository.forkThread(threadId, targetProjectPath = activeThread?.cwd)
                    repository.setActiveThreadId(forked.id)
                    setShowForkThreadSheet(false)
                    setLastError(null)
                }.onFailure { e ->
                    setLastError(formatTurnSendError(e))
                }
                setForkingThread(false)
            }
        },
        showFeedbackDialog = showFeedbackDialog,
        onDismissFeedbackDialog = { setShowFeedbackDialog(false) },
        onSubmitFeedback = { setShowFeedbackDialog(false) },
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
            if (!isHandingOffWorktree) setShowWorktreeHandoffSheet(false)
        },
        onConfirmWorktreeHandoff = handoffCurrentThread,
        showPlanDetailsSheet = showPlanDetailsSheet,
        visiblePlanAccessoryMessage = visiblePlanAccessoryMessage,
        canApplyPlan = !isThreadRunning && !sending,
        onDismissPlanDetails = { setShowPlanDetailsSheet(false) },
        onApplyPlanDetails = {
            applyPlanToComposer()
            if (!hasComposerDraftContent) {
                setShowPlanDetailsSheet(false)
            }
        },
        fullTimelineMessage = fullTimelineMessage,
        onDismissFullTimelineMessage = { setFullTimelineMessage(null) },
    )
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun FullTimelineMessageSheet(
    message: CodexMessage?,
    onDismiss: () -> Unit,
) {
    if (message == null) return
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement =
                androidx.compose.foundation.layout.Arrangement
                    .spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(R.string.turn_message_full_sheet_title),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            TurnRichMarkdownBody(
                markdown = message.text.trim(),
                contentColor = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.fillMaxWidth(),
                keyPrefix = "full-${message.id}",
            )
        }
    }
}

fun assistantUndoChangeSetsByMessageId(
    messages: List<CodexMessage>,
    changeSets: List<AIChangeSet>,
): Map<String, AIChangeSet> {
    if (messages.isEmpty() || changeSets.isEmpty()) return emptyMap()
    val readyChangeSets =
        changeSets.filter { TurnUsageSheetLogic.revertPrimaryEnabled(it, runtimeRevertRpcAvailable = true) }
    val byAssistantMessageId =
        readyChangeSets
            .mapNotNull { changeSet ->
                changeSet.assistantMessageId
                    ?.trim()
                    ?.takeIf { it.isNotEmpty() }
                    ?.let { it to changeSet }
            }.toMap()
    val byTurnId = readyChangeSets.associateBy { it.turnId }
    val mapped =
        messages
            .asSequence()
            .filter { it.role == CodexMessageRole.assistant }
            .mapNotNull { message ->
                val changeSet =
                    byAssistantMessageId[message.id]
                        ?: message.itemId?.let { byAssistantMessageId[it] }
                        ?: message.turnId?.let { byTurnId[it] }
                changeSet?.let { message.id to it }
            }.toMap()
    if (mapped.isNotEmpty()) return mapped
    val latestAssistant = messages.lastOrNull { it.role == CodexMessageRole.assistant }
    val latestReady = readyChangeSets.maxByOrNull { it.createdAt }
    return if (latestAssistant != null && latestReady != null) {
        mapOf(latestAssistant.id to latestReady)
    } else {
        emptyMap()
    }
}
