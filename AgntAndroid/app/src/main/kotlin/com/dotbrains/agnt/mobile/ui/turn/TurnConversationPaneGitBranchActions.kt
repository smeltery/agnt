package com.dotbrains.agnt.mobile.ui.turn

import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.GitBranchesWithStatusResult
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.GitBranchDisplayMapper
import com.dotbrains.agnt.mobile.data.TurnWorktreePathRouting
import com.dotbrains.agnt.mobile.services.git.GitActionsService
import com.dotbrains.agnt.mobile.ui.turn.toolbar.GitBranchPaneState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal fun handleTurnGitCheckout(
    selectedBranch: String,
    cwd: String?,
    gitBranchPaneState: GitBranchPaneState,
    checkoutElsewhereBlockedMessage: String,
    activeThread: CodexThread?,
    threads: List<CodexThread>,
    threadId: String,
    repository: CodexRepository,
    scope: CoroutineScope,
    setSwitchingGitBranch: (Boolean) -> Unit,
    setGitBranchCheckoutError: (String?) -> Unit,
    hydrateGitContextAfterMutation: suspend (String) -> Unit,
) {
    val loaded = gitBranchPaneState as? GitBranchPaneState.Loaded
    if (cwd == null || loaded == null) return
    val summary = loaded.summary
    val elsewhereSet = summary.branchesCheckedOutElsewhere.toSet()
    val elsewherePathRaw = summary.worktreePathByBranch[selectedBranch]?.trim()
    val selectedElsewhereUnresolved =
        elsewhereSet.contains(selectedBranch) &&
            elsewherePathRaw.isNullOrEmpty()
    if (selectedElsewhereUnresolved) {
        setGitBranchCheckoutError(checkoutElsewhereBlockedMessage)
        return
    }
    if (elsewhereSet.contains(selectedBranch) && !elsewherePathRaw.isNullOrEmpty()) {
        val targetComparable =
            TurnWorktreePathRouting.comparableGitProjectPath(
                CodexThread.normalizeProjectPath(elsewherePathRaw) ?: elsewherePathRaw,
            ) ?: return
        val cwdComparable = TurnWorktreePathRouting.comparableGitProjectPath(activeThread?.cwd ?: cwd)
        if (cwdComparable != null && targetComparable == cwdComparable) {
            setGitBranchCheckoutError(null)
            return
        }
        val siblingElsewhere =
            TurnWorktreePathRouting.liveThreadAtProjectPath(
                elsewherePathRaw,
                threads,
                threadId,
            )
        scope.launch {
            setSwitchingGitBranch(true)
            setGitBranchCheckoutError(null)
            runCatching {
                val targetNormalized = CodexThread.normalizeProjectPath(elsewherePathRaw) ?: elsewherePathRaw
                if (siblingElsewhere != null) {
                    repository.setActiveThreadId(siblingElsewhere.id)
                    hydrateGitContextAfterMutation(siblingElsewhere.id)
                } else {
                    repository.moveThreadToProjectPath(threadId, targetNormalized)
                    hydrateGitContextAfterMutation(threadId)
                }
            }.onFailure { e ->
                setGitBranchCheckoutError(GitBranchDisplayMapper.userVisibleMessage(e))
            }
            setSwitchingGitBranch(false)
        }
        return
    }
    scope.launch {
        setSwitchingGitBranch(true)
        setGitBranchCheckoutError(null)
        runCatching { GitActionsService(repository, cwd).checkout(selectedBranch) }
            .onSuccess { hydrateGitContextAfterMutation(threadId) }
            .onFailure { e ->
                setGitBranchCheckoutError(GitBranchDisplayMapper.userVisibleMessage(e))
            }
        setSwitchingGitBranch(false)
    }
}

internal fun handleTurnGitCreateBranch(
    branchName: String,
    cwd: String?,
    gitBranchPaneState: GitBranchPaneState,
    repository: CodexRepository,
    scope: CoroutineScope,
    setSwitchingGitBranch: (Boolean) -> Unit,
    setGitBranchCheckoutError: (String?) -> Unit,
    setGitBranchPaneState: (GitBranchPaneState) -> Unit,
    hydrateGitContextAfterMutation: suspend () -> Unit,
) {
    val loaded = gitBranchPaneState as? GitBranchPaneState.Loaded ?: return
    if (cwd == null || branchName.isBlank()) return
    scope.launch {
        setSwitchingGitBranch(true)
        setGitBranchCheckoutError(null)
        runCatching {
            GitActionsService(repository, cwd).createBranch(branchName.trim())
        }.onSuccess {
            val createdBranch = it.branch.trim()
            val previous = loaded.summary
            val nextSummary =
                GitBranchDisplayMapper.summaryFrom(
                    GitBranchesWithStatusResult(
                        branches =
                            (previous.branches + createdBranch)
                                .filter { branch -> branch.isNotBlank() }
                                .distinct(),
                        branchesCheckedOutElsewhere = previous.branchesCheckedOutElsewhere.toSet(),
                        worktreePathByBranch = previous.worktreePathByBranch,
                        localCheckoutPath = null,
                        currentBranch = createdBranch.ifEmpty { previous.currentBranch },
                        defaultBranch = previous.defaultBranch,
                        status = it.status,
                    ),
                )
            setGitBranchPaneState(GitBranchPaneState.Loaded(nextSummary))
            hydrateGitContextAfterMutation()
        }.onFailure { e ->
            setGitBranchCheckoutError(GitBranchDisplayMapper.userVisibleMessage(e))
        }
        setSwitchingGitBranch(false)
    }
}
