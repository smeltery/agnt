package com.dotbrains.agnt.mobile.ui.shell

import com.dotbrains.agnt.mobile.core.model.GitDiffTotals
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.RepoDiffLastTurnAggregator
import com.dotbrains.agnt.mobile.data.RepoDiffLastTurnFileRow
import com.dotbrains.agnt.mobile.services.git.GitActionsService
import com.dotbrains.agnt.mobile.ui.turn.WorkspaceTextFilePreviewRequest
import com.dotbrains.agnt.mobile.ui.turn.timeline.RepoMarkdownFileLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal fun prefetchMainShellRepoDiffFullTree(
    activeThreadId: String?,
    gitCwd: String?,
    cachedFullWorkingTreeDiff: Pair<String, String>?,
    repository: CodexRepository,
    scope: CoroutineScope,
    gitRepoDiffLoadErrorMessage: String,
    setFullPatch: (String) -> Unit,
    setFullLoading: (Boolean) -> Unit,
    setFullError: (String?) -> Unit,
    setCachedFullWorkingTreeDiff: (Pair<String, String>?) -> Unit,
) {
    val tid = activeThreadId
    val cwd = gitCwd
    if (tid != null && !cwd.isNullOrBlank()) {
        val cached = cachedFullWorkingTreeDiff?.takeIf { it.first == tid }
        setFullPatch(cached?.second.orEmpty())
        setFullLoading(cached == null || cached.second.isBlank())
        scope.launch {
            runCatching { GitActionsService(repository, cwd).diff() }
                .onSuccess {
                    setCachedFullWorkingTreeDiff(tid to it.patch)
                    setFullPatch(it.patch)
                }.onFailure {
                    val rawMessage = it.message.orEmpty()
                    val userVisibleMessage = rawMessage.withoutGitLineEndingWarnings().ifBlank { null }
                    setFullError(if (rawMessage.isNotBlank() && userVisibleMessage == null) null else userVisibleMessage ?: gitRepoDiffLoadErrorMessage)
                }
            setFullLoading(false)
        }
    } else {
        setFullPatch("")
        setFullLoading(false)
    }
}

internal fun openMainShellRepoDiffSheetFromHeader(
    threadMessages: List<com.dotbrains.agnt.mobile.core.model.CodexMessage>,
    prefetchFullTree: () -> Unit,
    setFocusQuery: (String?) -> Unit,
    setShowSheet: (Boolean) -> Unit,
    setScope: (GitRepoDiffScope) -> Unit,
    setFullError: (String?) -> Unit,
    setLastTurnRows: (List<RepoDiffLastTurnFileRow>) -> Unit,
) {
    setFocusQuery(null)
    setShowSheet(true)
    setScope(GitRepoDiffScope.LastTurn)
    setFullError(null)
    setLastTurnRows(RepoDiffLastTurnAggregator.fileRowsFromLastTurn(threadMessages))
    prefetchFullTree()
}

internal fun openMainShellRepoDiffSheetFromMarkdown(
    link: String,
    repoDiffTotals: GitDiffTotals?,
    showGitControls: Boolean,
    activeThreadId: String?,
    threadPathFull: String?,
    threadMessages: List<com.dotbrains.agnt.mobile.core.model.CodexMessage>,
    prefetchFullTree: () -> Unit,
    setWorkspaceTextFilePreview: (WorkspaceTextFilePreviewRequest?) -> Unit,
    setFocusQuery: (String?) -> Unit,
    setShowSheet: (Boolean) -> Unit,
    setScope: (GitRepoDiffScope) -> Unit,
    setFullError: (String?) -> Unit,
    setLastTurnRows: (List<RepoDiffLastTurnFileRow>) -> Unit,
) {
    if (repoDiffTotals?.hasChanges != true || !showGitControls || activeThreadId == null) {
        val normalizedPath = RepoMarkdownFileLink.normalizePath(link).takeIf { it.isNotBlank() } ?: return
        setWorkspaceTextFilePreview(WorkspaceTextFilePreviewRequest(path = normalizedPath, cwd = threadPathFull))
        return
    }
    val query = RepoMarkdownFileLink.canonicalFilenameQuery(link)
    setFocusQuery(query)
    val lastRows = RepoDiffLastTurnAggregator.fileRowsFromLastTurn(threadMessages)
    setLastTurnRows(lastRows)
    setScope(if (lastRows.any { RepoMarkdownFileLink.rowMatchesQuery(it.path, query) }) GitRepoDiffScope.LastTurn else GitRepoDiffScope.FullWorkingTree)
    setFullError(null)
    prefetchFullTree()
    setShowSheet(true)
}

private fun String.withoutGitLineEndingWarnings(): String =
    lineSequence()
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .filterNot { it.isGitLineEndingWarning() }
        .joinToString("\n")

private fun String.isGitLineEndingWarning(): Boolean =
    startsWith("warning: in the working copy of ") &&
        contains("LF will be replaced by CRLF the next time Git touches it")
