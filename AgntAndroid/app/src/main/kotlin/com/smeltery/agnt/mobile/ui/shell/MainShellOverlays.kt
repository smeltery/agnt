package com.smeltery.agnt.mobile.ui.shell

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.CodexBridgeUpdatePrompt
import com.smeltery.agnt.mobile.core.model.GitRepoSyncResult
import com.smeltery.agnt.mobile.core.model.PendingApprovalDecision
import com.smeltery.agnt.mobile.core.model.PendingApprovalRequest
import com.smeltery.agnt.mobile.core.model.PendingStructuredInputRequest
import com.smeltery.agnt.mobile.core.model.SystemNotice
import com.smeltery.agnt.mobile.core.model.TurnGitSyncAlert
import com.smeltery.agnt.mobile.core.model.TurnGitSyncAlertAction
import com.smeltery.agnt.mobile.data.RepoDiffLastTurnFileRow
import com.smeltery.agnt.mobile.services.workspace.WorkspaceTextFileService
import com.smeltery.agnt.mobile.ui.home.BridgeUpdateSheet
import com.smeltery.agnt.mobile.ui.turn.WorkspaceTextFilePreviewDialog
import com.smeltery.agnt.mobile.ui.turn.WorkspaceTextFilePreviewRequest

@Composable
internal fun MainShellOverlays(
    showPathDialog: Boolean,
    threadPathFull: String?,
    onDismissPathDialog: () -> Unit,
    onCopyThreadPath: (String) -> Unit,
    showRepoDiffSheet: Boolean,
    repoDiffSheetScope: GitRepoDiffScope,
    onRepoDiffScopeChange: (GitRepoDiffScope) -> Unit,
    repoDiffSheetLastTurnRows: List<RepoDiffLastTurnFileRow>,
    repoDiffSheetFullPatch: String,
    repoDiffSheetFullLoading: Boolean,
    repoDiffSheetFullError: String?,
    repoStatusSnapshot: GitRepoSyncResult?,
    repoDiffMarkdownFocusQuery: String?,
    onFocusPathQueryConsumed: () -> Unit,
    onDismissRepoDiffSheet: () -> Unit,
    gitActionSheetMode: GitActionSheetMode?,
    gitActionSheetInitialNextStep: GitActionNextStep?,
    defaultGitBaseBranch: String?,
    gitActionBusy: Boolean,
    onDismissGitActionSheet: () -> Unit,
    onSubmitGitActionSheet: (GitActionSheetSubmission) -> Unit,
    showGitInitPrompt: Boolean,
    gitInitError: String?,
    onInitializeRepository: () -> Unit,
    onDismissGitInitPrompt: () -> Unit,
    showNothingToCommit: Boolean,
    onDismissNothingToCommit: () -> Unit,
    gitSyncAlert: TurnGitSyncAlert?,
    onDismissGitSyncAlert: () -> Unit,
    onGitSyncAlertAction: (TurnGitSyncAlertAction) -> Unit,
    gitActionError: String?,
    onDismissGitActionError: () -> Unit,
    desktopHandoffError: String?,
    onDismissDesktopHandoffError: () -> Unit,
    worktreeHandoffError: String?,
    onDismissWorktreeHandoffError: () -> Unit,
    pendingApprovalRequest: PendingApprovalRequest?,
    onResolvePendingApproval: (PendingApprovalRequest, PendingApprovalDecision) -> Unit,
    pendingStructuredInputRequest: PendingStructuredInputRequest?,
    onSubmitStructuredInput: (PendingStructuredInputRequest, Map<String, List<String>>) -> Unit,
    onSkipStructuredInput: (PendingStructuredInputRequest) -> Unit,
    bridgeUpdatePrompt: CodexBridgeUpdatePrompt?,
    ready: Boolean,
    isUpdatingBridge: Boolean,
    bridgeUpdateError: String?,
    onDismissBridgeUpdate: () -> Unit,
    onUpdateBridge: () -> Unit,
    onRetryBridgeUpdate: () -> Unit,
    onScanNewQr: () -> Unit,
    systemNotices: List<SystemNotice>,
    onDismissSystemNotice: (String) -> Unit,
    workspaceTextFilePreview: WorkspaceTextFilePreviewRequest?,
    workspaceTextFileService: WorkspaceTextFileService,
    onDismissWorkspaceTextFilePreview: () -> Unit,
) {
    if (showPathDialog) {
        threadPathFull?.let { fullPath ->
            ThreadPathDialog(
                fullPath = fullPath,
                onDismiss = onDismissPathDialog,
                onCopy = { onCopyThreadPath(fullPath) },
            )
        }
    }

    GitRepoDiffBottomSheet(
        visible = showRepoDiffSheet,
        scope = repoDiffSheetScope,
        onScopeChange = onRepoDiffScopeChange,
        lastTurnRows = repoDiffSheetLastTurnRows,
        fullTreePatch = repoDiffSheetFullPatch,
        isFullTreeLoading = repoDiffSheetFullLoading,
        fullTreeError = repoDiffSheetFullError,
        gitStatus = repoStatusSnapshot,
        focusPathQuery = repoDiffMarkdownFocusQuery,
        onFocusPathQueryConsumed = onFocusPathQueryConsumed,
        onDismiss = onDismissRepoDiffSheet,
    )

    GitActionBottomSheet(
        visible = gitActionSheetMode != null,
        mode = gitActionSheetMode,
        initialNextStep = gitActionSheetInitialNextStep,
        status = repoStatusSnapshot,
        defaultBaseBranch = defaultGitBaseBranch,
        isBusy = gitActionBusy,
        onDismiss = onDismissGitActionSheet,
        onSubmit = onSubmitGitActionSheet,
    )

    if (showGitInitPrompt) {
        GitInitPromptDialog(
            isBusy = gitActionBusy,
            error = gitInitError,
            onInitialize = onInitializeRepository,
            onDismiss = onDismissGitInitPrompt,
        )
    }

    if (showNothingToCommit) {
        SimpleMessageDialog(
            title = stringResource(R.string.git_action_section_write),
            message = stringResource(R.string.git_nothing_to_commit),
            onDismiss = onDismissNothingToCommit,
        )
    }

    gitSyncAlert?.let { alert ->
        GitSyncAlertDialog(
            alert = alert,
            onDismiss = onDismissGitSyncAlert,
            onAction = onGitSyncAlertAction,
        )
    }

    gitActionError?.let { err ->
        SimpleMessageDialog(
            title = stringResource(R.string.git_error_title),
            message = err,
            onDismiss = onDismissGitActionError,
        )
    }

    desktopHandoffError?.let { error ->
        SimpleMessageDialog(
            title = stringResource(R.string.turn_open_desktop_error_title),
            message = error,
            onDismiss = onDismissDesktopHandoffError,
        )
    }

    worktreeHandoffError?.let { error ->
        SimpleMessageDialog(
            title = "Worktree handoff failed",
            message = error,
            onDismiss = onDismissWorktreeHandoffError,
        )
    }

    pendingApprovalRequest?.let { request ->
        PendingApprovalDialog(
            request = request,
            onResolve = { decision -> onResolvePendingApproval(request, decision) },
        )
    }

    pendingStructuredInputRequest?.let { request ->
        StructuredInputDialog(
            request = request,
            onSubmit = { answers -> onSubmitStructuredInput(request, answers) },
            onSkip = { onSkipStructuredInput(request) },
        )
    }

    BridgeUpdateSheet(
        visible = bridgeUpdatePrompt != null,
        title = bridgeUpdatePrompt?.title.orEmpty(),
        message = bridgeUpdatePrompt?.message.orEmpty(),
        installCommand = bridgeUpdatePrompt?.command,
        canUpdateBridge = ready,
        isUpdatingBridge = isUpdatingBridge,
        updateBridgeError = bridgeUpdateError,
        onDismiss = onDismissBridgeUpdate,
        onUpdateBridge = onUpdateBridge,
        onRetry = onRetryBridgeUpdate,
        onScanNewQr = onScanNewQr,
    )

    Box(modifier = Modifier.fillMaxSize()) {
        SystemNoticeHost(
            notices = systemNotices,
            onDismiss = onDismissSystemNotice,
            modifier =
                Modifier
                    .align(Alignment.BottomCenter)
                    .padding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom).asPaddingValues()),
        )
    }

    workspaceTextFilePreview?.let { request ->
        WorkspaceTextFilePreviewDialog(
            request = request,
            service = workspaceTextFileService,
            onDismiss = onDismissWorkspaceTextFilePreview,
        )
    }
}
