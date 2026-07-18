package com.dotbrains.agnt.mobile.ui.shell

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.agntBuildPullRequestUrl
import com.dotbrains.agnt.mobile.data.agntResolveCommitMessage
import com.dotbrains.agnt.mobile.services.git.GitActionsService
import com.dotbrains.agnt.mobile.ui.home.GitActionProgressPhase
import kotlinx.coroutines.withTimeout

internal suspend fun executeMainShellGitActionSheet(
    repository: CodexRepository,
    context: Context,
    submission: GitActionSheetSubmission,
    cwd: String,
    timeoutMs: Long,
    setBusy: (Boolean) -> Unit,
    setError: (String?) -> Unit,
    setProgressMessage: (String?) -> Unit,
    setProgressPhase: (GitActionProgressPhase?) -> Unit,
    setIncludesPush: (Boolean) -> Unit,
    setIncludesPullRequest: (Boolean) -> Unit,
    closeSheet: () -> Unit,
    onFailure: (Throwable) -> Unit,
    onRefresh: () -> Unit,
) {
    setBusy(true)
    setError(null)
    try {
        withTimeout(timeoutMs) {
            val git = GitActionsService(repository, cwd)
            when (submission.nextStep) {
                GitActionNextStep.commit -> {
                    setProgressMessage(null)
                    setIncludesPush(false)
                    setIncludesPullRequest(false)
                    setProgressPhase(GitActionProgressPhase.resolvingCommitMessage)
                    val commitMessage = resolveMainShellCommitMessage(git, submission.commitMessage)
                    setProgressPhase(GitActionProgressPhase.committing)
                    git.commit(commitMessage)
                    setProgressPhase(GitActionProgressPhase.done)
                }
                GitActionNextStep.commitAndPush -> {
                    setProgressMessage(null)
                    setIncludesPush(true)
                    setIncludesPullRequest(false)
                    setProgressPhase(GitActionProgressPhase.resolvingCommitMessage)
                    val commitMessage = resolveMainShellCommitMessage(git, submission.commitMessage)
                    setProgressPhase(GitActionProgressPhase.committing)
                    git.commit(commitMessage)
                    setProgressPhase(GitActionProgressPhase.pushing)
                    git.push(submission.pushRemoteName)
                    setProgressPhase(GitActionProgressPhase.done)
                }
                GitActionNextStep.commitPushAndPullRequest -> {
                    setProgressMessage(null)
                    setIncludesPush(true)
                    setIncludesPullRequest(true)
                    setProgressPhase(GitActionProgressPhase.resolvingCommitMessage)
                    val commitMessage = resolveMainShellCommitMessage(git, submission.commitMessage)
                    setProgressPhase(GitActionProgressPhase.committing)
                    git.commit(commitMessage)
                    setProgressPhase(GitActionProgressPhase.pushing)
                    git.push(submission.pushRemoteName)
                    setProgressPhase(GitActionProgressPhase.preparingPullRequest)
                    openMainShellPullRequestUrl(context, git, submission)
                    setProgressPhase(GitActionProgressPhase.done)
                }
                GitActionNextStep.push -> {
                    setProgressMessage("Pushing branch...")
                    git.push(submission.pushRemoteName)
                    setProgressMessage("Pushed branch.")
                }
                GitActionNextStep.pushAndPullRequest -> {
                    setProgressMessage("Pushing branch...")
                    git.push(submission.pushRemoteName)
                    setProgressMessage("Preparing pull request...")
                    openMainShellPullRequestUrl(context, git, submission)
                    setProgressMessage("Pull request draft opened.")
                }
                GitActionNextStep.createPullRequest -> {
                    setProgressMessage("Preparing pull request...")
                    openMainShellPullRequestUrl(context, git, submission)
                    setProgressMessage("Pull request draft opened.")
                }
            }
        }
        setError(null)
        closeSheet()
    } catch (e: Throwable) {
        onFailure(e)
    } finally {
        setBusy(false)
        onRefresh()
    }
}

internal fun operationForMainShellSubmission(submission: GitActionSheetSubmission) =
    when (submission.nextStep) {
        GitActionNextStep.commit -> com.dotbrains.agnt.mobile.core.model.TurnGitPreflightOperation.commit
        GitActionNextStep.commitAndPush,
        GitActionNextStep.push,
        -> com.dotbrains.agnt.mobile.core.model.TurnGitPreflightOperation.push
        GitActionNextStep.commitPushAndPullRequest,
        GitActionNextStep.pushAndPullRequest,
        GitActionNextStep.createPullRequest,
        -> com.dotbrains.agnt.mobile.core.model.TurnGitPreflightOperation.createPullRequest
    }

private suspend fun resolveMainShellCommitMessage(
    git: GitActionsService,
    rawMessage: String,
): String? = agntResolveCommitMessage(rawMessage) { git.generateCommitMessage().fullMessage }

private suspend fun openMainShellPullRequestUrl(
    context: Context,
    git: GitActionsService,
    submission: GitActionSheetSubmission,
) {
    val st = git.status()
    val bw = git.branchesWithStatus()
    val branch = st.currentBranch?.trim().orEmpty()
    val base = submission.baseBranch.trim().ifEmpty { bw.defaultBranch?.trim().orEmpty() }
    if (branch.isEmpty() || base.isEmpty()) throw IllegalStateException("Could not determine branch or default for PR.")
    val draft =
        if (submission.pullRequestTitle.isBlank() || submission.pullRequestBody.isBlank()) {
            runCatching { git.generatePullRequestDraft(baseBranch = base) }.getOrNull()
        } else {
            null
        }
    val title = submission.pullRequestTitle.trim().ifEmpty { draft?.title?.trim().orEmpty() }
    val body = submission.pullRequestBody.trim().ifEmpty { draft?.body?.trim().orEmpty() }
    val ownerRepo =
        git
            .remoteUrl()
            .ownerRepo
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: throw IllegalStateException("Could not read Git remote (GitHub PR link needs origin).")
    val url = agntBuildPullRequestUrl(ownerRepo, branch, base, title, body)
    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
}
