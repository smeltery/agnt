package com.dotbrains.agnt.mobile.ui.shell

import com.dotbrains.agnt.mobile.core.model.GitBranchesWithStatusResult
import com.dotbrains.agnt.mobile.core.model.GitRepoSyncResult
import com.dotbrains.agnt.mobile.core.model.GitWorktreeChangeTransferMode
import com.dotbrains.agnt.mobile.core.model.TurnGitPreflightOperation
import com.dotbrains.agnt.mobile.core.model.TurnGitPreflightPolicy
import com.dotbrains.agnt.mobile.core.model.TurnGitSyncAlert
import com.dotbrains.agnt.mobile.core.model.TurnGitSyncAlertAction
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.WorktreeFlowCoordinator
import com.dotbrains.agnt.mobile.data.WorktreeFlowHandoffOutcome
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal fun shouldShowMainShellWorktreeHandoff(
    showGitControls: Boolean,
    ready: Boolean,
    activeThreadId: String?,
    showTurnStop: Boolean,
    handingOffWorktree: Boolean,
    isWorktreeProject: Boolean,
    localWorktreeHandoffTargetPath: String?,
    associatedWorktreePath: String?,
    defaultGitBaseBranch: String?,
): Boolean =
    showGitControls &&
        ready &&
        activeThreadId != null &&
        !showTurnStop &&
        !handingOffWorktree &&
        (
            (isWorktreeProject && localWorktreeHandoffTargetPath != null) ||
                (!isWorktreeProject && (associatedWorktreePath != null || defaultGitBaseBranch != null))
        )

internal fun mainShellLocalWorktreeHandoffTargetPath(branches: GitBranchesWithStatusResult?): String? {
    branches ?: return null
    val preferredBranch = branches.defaultBranch ?: branches.currentBranch
    return preferredBranch?.let { branches.worktreePathByBranch[it]?.trim()?.takeIf { path -> path.isNotEmpty() } }
        ?: branches.worktreePathByBranch.values
            .firstOrNull { it.isNotBlank() }
            ?.trim()
}

internal fun handoffMainShellCurrentThreadWorktree(
    activeThreadId: String?,
    cwd: String?,
    showGitControls: Boolean,
    showTurnStop: Boolean,
    handingOffWorktree: Boolean,
    isWorktreeProject: Boolean,
    associatedWorktreePath: String?,
    localWorktreeHandoffTargetPath: String?,
    defaultGitBaseBranch: String?,
    branchesWithStatusSnapshot: GitBranchesWithStatusResult?,
    repoStatusSnapshot: GitRepoSyncResult?,
    repository: CodexRepository,
    scope: CoroutineScope,
    skipPreflight: Boolean = false,
    setPendingGitOperation: (PendingGitOperation?) -> Unit,
    setGitSyncAlert: (TurnGitSyncAlert?) -> Unit,
    setHandingOffWorktree: (Boolean) -> Unit,
    setWorktreeHandoffError: (String?) -> Unit,
    onRefresh: () -> Unit,
) {
    val tid = activeThreadId ?: return
    val workingDirectory = cwd ?: return
    if (!showGitControls || showTurnStop || handingOffWorktree) return
    val baseBranch = defaultGitBaseBranch?.trim()?.takeIf { it.isNotEmpty() } ?: branchesWithStatusSnapshot?.currentBranch?.trim()?.takeIf { it.isNotEmpty() }
    val localTarget = localWorktreeHandoffTargetPath
    if (isWorktreeProject && localTarget == null) {
        setGitSyncAlert(
            TurnGitSyncAlert.withDefaultButtons(
                title = "Worktree handoff unavailable",
                message = "Could not resolve the paired Local checkout for this worktree.",
                action = TurnGitSyncAlertAction.dismissOnly,
            ),
        )
        return
    }
    if (!isWorktreeProject && associatedWorktreePath == null && baseBranch == null) {
        setGitSyncAlert(
            TurnGitSyncAlert.withDefaultButtons(
                title = "Worktree handoff unavailable",
                message = "Could not determine a base branch for the managed worktree.",
                action = TurnGitSyncAlertAction.dismissOnly,
            ),
        )
        return
    }
    val preflightBranches = branchesWithStatusSnapshot
    if (!skipPreflight && !isWorktreeProject && associatedWorktreePath == null && preflightBranches != null && baseBranch != null) {
        val operation = TurnGitPreflightOperation.createManagedWorktree(baseBranch = baseBranch, changeTransfer = GitWorktreeChangeTransferMode.move)
        val alert = TurnGitPreflightPolicy.alertFor(status = repoStatusSnapshot ?: preflightBranches.status, branches = preflightBranches, operation = operation)
        if (alert != null) {
            setPendingGitOperation(PendingGitOperation(operation = operation, cwd = workingDirectory))
            setGitSyncAlert(alert)
            return
        }
    }
    scope.launch {
        setHandingOffWorktree(true)
        setWorktreeHandoffError(null)
        try {
            val coordinator = WorktreeFlowCoordinator(repository)
            val outcome =
                if (isWorktreeProject) {
                    coordinator.handoffThreadToProjectPath(threadId = tid, sourceProjectPath = workingDirectory, targetProjectPath = localTarget ?: error("Missing local checkout path."))
                } else {
                    coordinator.handoffThreadToWorktree(threadId = tid, sourceProjectPath = workingDirectory, associatedWorktreePath = associatedWorktreePath, baseBranchForNewWorktree = baseBranch)
                }
            when (outcome) {
                is WorktreeFlowHandoffOutcome.Moved -> {
                    repository.setActiveThreadId(outcome.move.thread.id)
                    onRefresh()
                }
                WorktreeFlowHandoffOutcome.MissingAssociatedWorktree ->
                    setWorktreeHandoffError("The associated worktree is no longer available. Open the thread to create a new managed worktree.")
            }
        } catch (e: Throwable) {
            setWorktreeHandoffError(e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName)
        } finally {
            setHandingOffWorktree(false)
        }
    }
}
