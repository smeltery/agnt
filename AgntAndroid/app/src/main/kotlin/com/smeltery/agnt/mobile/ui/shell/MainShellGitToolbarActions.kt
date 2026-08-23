package com.smeltery.agnt.mobile.ui.shell

import com.smeltery.agnt.mobile.core.model.GitRepoSyncResult
import com.smeltery.agnt.mobile.core.model.TurnGitActionKind
import com.smeltery.agnt.mobile.core.model.TurnGitPreflightOperation
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.services.git.GitActionsService
import com.smeltery.agnt.mobile.ui.home.GitActionProgressPhase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

internal fun handleMainShellGitToolbarAction(
    action: TurnGitActionKind,
    cwd: String?,
    repository: CodexRepository,
    scope: CoroutineScope,
    timeoutMs: Long,
    showGitControls: Boolean,
    showTurnStop: Boolean,
    gitActionBusy: Boolean,
    initializeRepository: () -> Unit,
    enqueuePreflight: (String, TurnGitPreflightOperation, GitRepoSyncResult?) -> Boolean,
    setSheetMode: (GitActionSheetMode?) -> Unit,
    setInitialNextStep: (GitActionNextStep?) -> Unit,
    setBusy: (Boolean) -> Unit,
    setError: (String?) -> Unit,
    setProgressMessage: (String?) -> Unit,
    setIncludesPush: (Boolean) -> Unit,
    setIncludesPullRequest: (Boolean) -> Unit,
    setProgressPhase: (GitActionProgressPhase?) -> Unit,
    setRepoStatus: (GitRepoSyncResult?) -> Unit,
    setRepoDiffTotals: (com.smeltery.agnt.mobile.core.model.GitDiffTotals?) -> Unit,
    onFailure: (Throwable) -> Unit,
    onRefresh: () -> Unit,
) {
    val workingDirectory = cwd ?: return
    if (action == TurnGitActionKind.discardRuntimeChangesAndSync) {
        enqueuePreflight(workingDirectory, TurnGitPreflightOperation.discardRuntimeChanges, null)
        return
    }
    if (!showGitControls || showTurnStop) return
    if (action == TurnGitActionKind.initialize) {
        initializeRepository()
        return
    }
    when (action) {
        TurnGitActionKind.commit -> {
            setSheetMode(GitActionSheetMode.commit)
            setInitialNextStep(GitActionNextStep.commit)
            return
        }
        TurnGitActionKind.push -> {
            setSheetMode(GitActionSheetMode.push)
            setInitialNextStep(GitActionNextStep.push)
            return
        }
        TurnGitActionKind.commitAndPush -> {
            setSheetMode(GitActionSheetMode.commit)
            setInitialNextStep(GitActionNextStep.commitAndPush)
            return
        }
        TurnGitActionKind.createPR -> {
            setSheetMode(GitActionSheetMode.createPullRequest)
            setInitialNextStep(GitActionNextStep.createPullRequest)
            return
        }
        TurnGitActionKind.previewCommitPushToast -> {
            if (gitActionBusy) return
            scope.launch {
                setBusy(true)
                setError(null)
                setProgressMessage(null)
                setIncludesPush(true)
                setIncludesPullRequest(false)
                setProgressPhase(GitActionProgressPhase.resolvingCommitMessage)
                delay(900)
                setProgressPhase(GitActionProgressPhase.committing)
                delay(900)
                setProgressPhase(GitActionProgressPhase.pushing)
                delay(900)
                setProgressPhase(GitActionProgressPhase.done)
                setBusy(false)
            }
            return
        }
        else -> Unit
    }
    scope.launch {
        setBusy(true)
        setError(null)
        try {
            withTimeout(timeoutMs) {
                val git = GitActionsService(repository, workingDirectory)
                when (action) {
                    TurnGitActionKind.syncNow -> {
                        val status = git.status()
                        setRepoStatus(status)
                        setRepoDiffTotals(status.workingTreeDiffTotals)
                        if (enqueuePreflight(workingDirectory, TurnGitPreflightOperation.syncUpdate, status)) return@withTimeout
                        when (status.state) {
                            "behind_only" -> git.pull()
                            else -> Unit
                        }
                    }
                    else -> Unit
                }
            }
        } catch (e: Throwable) {
            onFailure(e)
        } finally {
            setBusy(false)
            onRefresh()
        }
    }
}
