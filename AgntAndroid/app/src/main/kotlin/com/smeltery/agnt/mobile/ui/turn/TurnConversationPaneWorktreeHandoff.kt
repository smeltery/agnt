package com.smeltery.agnt.mobile.ui.turn

import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.data.GitBranchDisplayMapper
import com.smeltery.agnt.mobile.data.WorktreeFlowCoordinator
import com.smeltery.agnt.mobile.data.WorktreeFlowHandoffOutcome
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal fun handleTurnWorktreeHandoff(
    selectedBaseBranch: String?,
    gitCwd: String?,
    isThreadRunning: Boolean,
    sending: Boolean,
    isHandingOffWorktree: Boolean,
    activeThread: CodexThread?,
    defaultReviewBaseBranch: String?,
    localWorktreeHandoffTargetPath: String?,
    repository: CodexRepository,
    threadId: String,
    scope: CoroutineScope,
    handoffMissingLocalMessage: String,
    handoffMissingBaseMessage: String,
    setWorktreeHandoffError: (String?) -> Unit,
    setShowWorktreeHandoffSheet: (Boolean) -> Unit,
    setHandingOffWorktree: (Boolean) -> Unit,
    afterMoved: () -> Unit,
) {
    val cwd = gitCwd
    if (cwd == null || isThreadRunning || sending || isHandingOffWorktree) return
    val isWorktreeProject = activeThread?.isManagedWorktreeProject == true
    val baseBranch = selectedBaseBranch?.trim()?.takeIf { it.isNotEmpty() } ?: defaultReviewBaseBranch
    val localTargetPath = localWorktreeHandoffTargetPath
    val associatedWorktreePath = repository.associatedManagedWorktreePathFor(threadId)
    if (isWorktreeProject && localTargetPath == null) {
        setWorktreeHandoffError(handoffMissingLocalMessage)
        return
    }
    if (!isWorktreeProject && baseBranch == null && associatedWorktreePath == null) {
        setWorktreeHandoffError(handoffMissingBaseMessage)
        setShowWorktreeHandoffSheet(true)
        return
    }
    scope.launch {
        setHandingOffWorktree(true)
        setWorktreeHandoffError(null)
        try {
            setShowWorktreeHandoffSheet(false)
            val outcome =
                runCatching {
                    val coordinator = WorktreeFlowCoordinator(repository)
                    if (isWorktreeProject) {
                        coordinator.handoffThreadToProjectPath(
                            threadId = threadId,
                            sourceProjectPath = cwd,
                            targetProjectPath = localTargetPath ?: error(handoffMissingLocalMessage),
                        )
                    } else {
                        coordinator.handoffThreadToWorktree(
                            threadId = threadId,
                            sourceProjectPath = cwd,
                            associatedWorktreePath = associatedWorktreePath,
                            baseBranchForNewWorktree = baseBranch,
                        )
                    }
                }.getOrElse { e ->
                    setWorktreeHandoffError(GitBranchDisplayMapper.userVisibleMessage(e))
                    return@launch
                }
            when (outcome) {
                is WorktreeFlowHandoffOutcome.Moved -> {
                    repository.setActiveThreadId(outcome.move.thread.id)
                    afterMoved()
                }
                WorktreeFlowHandoffOutcome.MissingAssociatedWorktree -> {
                    setWorktreeHandoffError(
                        "The associated worktree is no longer available. Create a new managed worktree to continue.",
                    )
                    setShowWorktreeHandoffSheet(true)
                }
            }
        } finally {
            setHandingOffWorktree(false)
        }
    }
}
