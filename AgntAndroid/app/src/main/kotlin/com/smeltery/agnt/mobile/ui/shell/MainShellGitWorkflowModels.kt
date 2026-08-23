package com.smeltery.agnt.mobile.ui.shell

import com.smeltery.agnt.mobile.core.model.GitDiffTotals
import com.smeltery.agnt.mobile.core.model.GitRepoSyncResult
import com.smeltery.agnt.mobile.core.model.TurnGitActionKind
import com.smeltery.agnt.mobile.core.model.TurnGitPreflightOperation
import com.smeltery.agnt.mobile.core.model.TurnGitSyncAlert
import com.smeltery.agnt.mobile.core.model.TurnGitSyncAlertAction
import com.smeltery.agnt.mobile.data.RepoDiffLastTurnFileRow
import com.smeltery.agnt.mobile.ui.home.GitActionProgressBannerState

internal const val MAIN_SHELL_GIT_OPERATION_TIMEOUT_MS = 150_000L

internal data class MainShellGitWorkflow(
    val gitCwd: String?,
    val showGitControls: Boolean,
    val isWorktreeProject: Boolean,
    val handingOffWorktree: Boolean,
    val worktreeHandoffError: String?,
    val repoStatusSnapshot: GitRepoSyncResult?,
    val repoDiffTotals: GitDiffTotals?,
    val defaultGitBaseBranch: String?,
    val isLoadingRepoDiff: Boolean,
    val showWorktreeHandoff: Boolean,
    val gitToastMessage: String?,
    val gitProgressToast: GitActionProgressBannerState?,
    val showRepoDiffSheet: Boolean,
    val repoDiffSheetScope: GitRepoDiffScope,
    val repoDiffSheetLastTurnRows: List<RepoDiffLastTurnFileRow>,
    val repoDiffSheetFullPatch: String,
    val repoDiffSheetFullLoading: Boolean,
    val repoDiffSheetFullError: String?,
    val repoDiffMarkdownFocusQuery: String?,
    val gitActionBusy: Boolean,
    val gitActionError: String?,
    val gitActionSheetMode: GitActionSheetMode?,
    val gitActionSheetInitialNextStep: GitActionNextStep?,
    val showGitInitPrompt: Boolean,
    val gitInitError: String?,
    val gitSyncAlert: TurnGitSyncAlert?,
    val showNothingToCommit: Boolean,
    val openRepoDiffSheetFromHeader: () -> Unit,
    val openRepoDiffSheetFromMarkdown: (String) -> Unit,
    val handleGitAction: (TurnGitActionKind) -> Unit,
    val handoffCurrentThreadWorktree: () -> Unit,
    val dismissGitProgress: () -> Unit,
    val refreshGitContext: () -> Unit,
    val setRepoDiffSheetScope: (GitRepoDiffScope) -> Unit,
    val dismissRepoDiffSheet: () -> Unit,
    val consumeFocusPathQuery: () -> Unit,
    val dismissGitActionSheet: () -> Unit,
    val executeGitActionSheet: (GitActionSheetSubmission) -> Unit,
    val initializeRepositoryForCurrentThread: () -> Unit,
    val dismissGitInitPrompt: () -> Unit,
    val dismissNothingToCommit: () -> Unit,
    val dismissGitSyncAlert: () -> Unit,
    val handleGitSyncAlertAction: (TurnGitSyncAlertAction) -> Unit,
    val dismissGitActionError: () -> Unit,
    val dismissWorktreeHandoffError: () -> Unit,
)

internal data class PendingGitOperation(
    val operation: TurnGitPreflightOperation,
    val cwd: String,
    val submission: GitActionSheetSubmission? = null,
)
