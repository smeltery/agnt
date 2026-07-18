package com.dotbrains.agnt.mobile.ui.turn

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import com.dotbrains.agnt.mobile.core.model.CodexReviewTarget
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.data.GitBranchDisplaySummary
import com.dotbrains.agnt.mobile.data.gitWorkingDirectoryForGitActions
import com.dotbrains.agnt.mobile.ui.turn.toolbar.GitBranchPaneState
import com.dotbrains.agnt.mobile.ui.turn.toolbar.resolveReviewBaseBranch
import com.dotbrains.agnt.mobile.ui.turn.toolbar.reviewSelectableDefaultBranch

internal data class TurnConversationPaneGitReviewContext(
    val activeThread: CodexThread?,
    val gitCwd: String?,
    val reviewTarget: CodexReviewTarget?,
    val loadedGitBranchSummary: GitBranchDisplaySummary?,
    val defaultReviewBaseBranch: String?,
    val resolvedReviewBaseBranch: String?,
    val localWorktreeHandoffTargetPath: String?,
)

@Composable
internal fun rememberTurnConversationPaneGitReviewContext(
    threadId: String,
    threads: List<CodexThread>,
    reviewTargetName: String?,
    reviewBaseBranch: String?,
    gitBranchPaneState: GitBranchPaneState,
): TurnConversationPaneGitReviewContext {
    val activeThread = remember(threadId, threads) { threads.firstOrNull { it.id == threadId } }
    val gitCwd = remember(activeThread) { activeThread.gitWorkingDirectoryForGitActions() }
    val reviewTarget = remember(reviewTargetName) { reviewTargetName?.let { runCatching { CodexReviewTarget.valueOf(it) }.getOrNull() } }
    val loadedGitBranchSummary = (gitBranchPaneState as? GitBranchPaneState.Loaded)?.summary
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
            preferredBranch?.let { summary.worktreePathByBranch[it]?.trim()?.takeIf { path -> path.isNotEmpty() } }
                ?: summary.worktreePathByBranch.values
                    .firstOrNull { it.isNotBlank() }
                    ?.trim()
        }
    return TurnConversationPaneGitReviewContext(
        activeThread = activeThread,
        gitCwd = gitCwd,
        reviewTarget = reviewTarget,
        loadedGitBranchSummary = loadedGitBranchSummary,
        defaultReviewBaseBranch = defaultReviewBaseBranch,
        resolvedReviewBaseBranch = resolvedReviewBaseBranch,
        localWorktreeHandoffTargetPath = localWorktreeHandoffTargetPath,
    )
}
