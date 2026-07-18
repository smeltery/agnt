package com.dotbrains.agnt.mobile.ui.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.GitBranchesWithStatusResult
import com.dotbrains.agnt.mobile.core.model.GitDiffTotals
import com.dotbrains.agnt.mobile.core.model.GitRepoSyncResult
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.gitWorkingDirectoryForGitActions
import com.dotbrains.agnt.mobile.services.git.GitActionsService
import com.dotbrains.agnt.mobile.ui.home.GitActionProgressPhase
import kotlinx.coroutines.delay

@Composable
internal fun MainShellGitProgressDismissEffect(
    message: String?,
    phase: GitActionProgressPhase?,
    busy: Boolean,
    setMessage: (String?) -> Unit,
    setPhase: (GitActionProgressPhase?) -> Unit,
) {
    LaunchedEffect(message, phase, busy) {
        if (!busy && (!message.isNullOrBlank() || phase == GitActionProgressPhase.done)) {
            delay(3_500)
            if (message == message && phase == phase) {
                setMessage(null)
                setPhase(null)
            }
        }
    }
}

@Composable
internal fun MainShellGitContextRefreshEffect(
    repository: CodexRepository,
    ready: Boolean,
    activeThreadId: String?,
    threads: List<CodexThread>,
    refreshNonce: Int,
    setRepoStatus: (GitRepoSyncResult?) -> Unit,
    setBranchesWithStatus: (GitBranchesWithStatusResult?) -> Unit,
    setRepoDiffTotals: (GitDiffTotals?) -> Unit,
    setDefaultBaseBranch: (String?) -> Unit,
    setLoadingRepoDiff: (Boolean) -> Unit,
) {
    fun clear() {
        setRepoStatus(null)
        setBranchesWithStatus(null)
        setRepoDiffTotals(null)
        setDefaultBaseBranch(null)
        setLoadingRepoDiff(false)
    }

    LaunchedEffect(activeThreadId, ready, threads, refreshNonce) {
        if (!ready) {
            clear()
            return@LaunchedEffect
        }
        val tid = activeThreadId
        if (tid.isNullOrBlank()) {
            clear()
            return@LaunchedEffect
        }
        val cwd = threads.firstOrNull { it.id == tid }?.gitWorkingDirectoryForGitActions()
        if (cwd == null) {
            clear()
            return@LaunchedEffect
        }
        setRepoStatus(null)
        setLoadingRepoDiff(true)
        val git = GitActionsService(repository, cwd)
        val status = runCatching { git.status() }.getOrNull()
        val branches = runCatching { git.branchesWithStatus() }.getOrNull()
        setRepoStatus(status)
        setBranchesWithStatus(branches)
        setRepoDiffTotals(status?.workingTreeDiffTotals)
        setDefaultBaseBranch(branches?.defaultBranch)
        setLoadingRepoDiff(false)
    }
}
