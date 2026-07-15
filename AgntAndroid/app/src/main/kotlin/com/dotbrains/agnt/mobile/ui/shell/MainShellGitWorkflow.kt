package com.dotbrains.agnt.mobile.ui.shell

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.GitBranchesWithStatusResult
import com.dotbrains.agnt.mobile.core.model.GitDiffTotals
import com.dotbrains.agnt.mobile.core.model.GitRepoSyncResult
import com.dotbrains.agnt.mobile.core.model.TurnGitActionKind
import com.dotbrains.agnt.mobile.core.model.TurnGitPreflightOperation
import com.dotbrains.agnt.mobile.core.model.TurnGitPreflightPolicy
import com.dotbrains.agnt.mobile.core.model.TurnGitSyncAlert
import com.dotbrains.agnt.mobile.core.model.TurnGitSyncAlertAction
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.RepoDiffLastTurnFileRow
import com.dotbrains.agnt.mobile.data.WorktreeFlowCoordinator
import com.dotbrains.agnt.mobile.data.WorktreeFlowHandoffOutcome
import com.dotbrains.agnt.mobile.data.gitWorkingDirectoryForGitActions
import com.dotbrains.agnt.mobile.services.git.GitActionsService
import com.dotbrains.agnt.mobile.ui.home.GitActionProgressBannerState
import com.dotbrains.agnt.mobile.ui.home.GitActionProgressPhase
import com.dotbrains.agnt.mobile.ui.turn.WorkspaceTextFilePreviewRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

@Composable
internal fun rememberMainShellGitWorkflow(
    repository: CodexRepository,
    scope: CoroutineScope,
    context: Context,
    ready: Boolean,
    activeThreadId: String?,
    threads: List<CodexThread>,
    activeThread: CodexThread?,
    threadMessages: List<CodexMessage>,
    threadPathFull: String?,
    showTurnStop: Boolean,
    gitRepoDiffLoadErrorMessage: String,
    gitInitInitializingMessage: String,
    gitInitInitializedMessage: String,
    gitStatusLoadingToast: String,
    setWorkspaceTextFilePreview: (WorkspaceTextFilePreviewRequest?) -> Unit,
): MainShellGitWorkflow {
    var handingOffWorktree by remember { mutableStateOf(false) }
    var worktreeHandoffError by remember { mutableStateOf<String?>(null) }
    var repoStatusSnapshot by remember { mutableStateOf<GitRepoSyncResult?>(null) }
    var branchesWithStatusSnapshot by remember { mutableStateOf<GitBranchesWithStatusResult?>(null) }
    var repoDiffTotals by remember { mutableStateOf<GitDiffTotals?>(null) }
    var defaultGitBaseBranch by remember { mutableStateOf<String?>(null) }
    var isLoadingRepoDiff by remember { mutableStateOf(false) }
    var gitToolbarRefreshNonce by remember { mutableStateOf(0) }
    var showRepoDiffSheet by remember { mutableStateOf(false) }
    var repoDiffSheetScope by remember { mutableStateOf(GitRepoDiffScope.LastTurn) }
    var cachedFullWorkingTreeDiff by remember { mutableStateOf<Pair<String, String>?>(null) }
    var repoDiffSheetLastTurnRows by remember { mutableStateOf<List<RepoDiffLastTurnFileRow>>(emptyList()) }
    var repoDiffSheetFullPatch by remember { mutableStateOf("") }
    var repoDiffSheetFullLoading by remember { mutableStateOf(false) }
    var repoDiffSheetFullError by remember { mutableStateOf<String?>(null) }
    var repoDiffMarkdownFocusQuery by remember { mutableStateOf<String?>(null) }
    var gitActionBusy by remember { mutableStateOf(false) }
    var gitActionError by remember { mutableStateOf<String?>(null) }
    var gitActionProgressMessage by remember { mutableStateOf<String?>(null) }
    var gitActionProgressPhase by remember { mutableStateOf<GitActionProgressPhase?>(null) }
    var gitActionProgressIncludesPush by remember { mutableStateOf(true) }
    var gitActionProgressIncludesPullRequest by remember { mutableStateOf(false) }
    var gitActionSheetMode by remember { mutableStateOf<GitActionSheetMode?>(null) }
    var gitActionSheetInitialNextStep by remember { mutableStateOf<GitActionNextStep?>(null) }
    var showGitInitPrompt by remember { mutableStateOf(false) }
    var gitInitError by remember { mutableStateOf<String?>(null) }
    var gitSyncAlert by remember { mutableStateOf<TurnGitSyncAlert?>(null) }
    var pendingGitOperation by remember { mutableStateOf<PendingGitOperation?>(null) }
    var showNothingToCommit by remember { mutableStateOf(false) }

    val gitCwd = remember(activeThread) { activeThread?.gitWorkingDirectoryForGitActions() }
    val showGitControls = ready && !gitCwd.isNullOrBlank()
    val isWorktreeProject = activeThread?.isManagedWorktreeProject == true
    val associatedWorktreePath = remember(activeThreadId, threads) { activeThreadId?.let { repository.associatedManagedWorktreePathFor(it) } }
    val localWorktreeHandoffTargetPath =
        remember(branchesWithStatusSnapshot) { mainShellLocalWorktreeHandoffTargetPath(branchesWithStatusSnapshot) }
    val showWorktreeHandoff =
        shouldShowMainShellWorktreeHandoff(
            showGitControls = showGitControls,
            ready = ready,
            activeThreadId = activeThreadId,
            showTurnStop = showTurnStop,
            handingOffWorktree = handingOffWorktree,
            isWorktreeProject = isWorktreeProject,
            localWorktreeHandoffTargetPath = localWorktreeHandoffTargetPath,
            associatedWorktreePath = associatedWorktreePath,
            defaultGitBaseBranch = defaultGitBaseBranch,
        )
    val gitToastMessage = if (isLoadingRepoDiff && showGitControls && gitActionProgressPhase == null) gitStatusLoadingToast else null
    val gitProgressToast =
        gitActionProgressPhase?.let {
            GitActionProgressBannerState(
                phase = it,
                includesPush = gitActionProgressIncludesPush,
                includesPullRequest = gitActionProgressIncludesPullRequest,
            )
        }

    fun enqueueRepoDiffFullTreePrefetch() {
        prefetchMainShellRepoDiffFullTree(
            activeThreadId = activeThreadId,
            gitCwd = gitCwd,
            cachedFullWorkingTreeDiff = cachedFullWorkingTreeDiff,
            repository = repository,
            scope = scope,
            gitRepoDiffLoadErrorMessage = gitRepoDiffLoadErrorMessage,
            setFullPatch = { repoDiffSheetFullPatch = it },
            setFullLoading = { repoDiffSheetFullLoading = it },
            setFullError = { repoDiffSheetFullError = it },
            setCachedFullWorkingTreeDiff = { cachedFullWorkingTreeDiff = it },
        )
    }

    fun openRepoDiffSheetFromHeader() {
        openMainShellRepoDiffSheetFromHeader(
            threadMessages = threadMessages,
            prefetchFullTree = ::enqueueRepoDiffFullTreePrefetch,
            setFocusQuery = { repoDiffMarkdownFocusQuery = it },
            setShowSheet = { showRepoDiffSheet = it },
            setScope = { repoDiffSheetScope = it },
            setFullError = { repoDiffSheetFullError = it },
            setLastTurnRows = { repoDiffSheetLastTurnRows = it },
        )
    }

    fun openRepoDiffSheetFromMarkdown(link: String) {
        openMainShellRepoDiffSheetFromMarkdown(
            link = link,
            repoDiffTotals = repoDiffTotals,
            showGitControls = showGitControls,
            activeThreadId = activeThreadId,
            threadPathFull = threadPathFull,
            threadMessages = threadMessages,
            prefetchFullTree = ::enqueueRepoDiffFullTreePrefetch,
            setWorkspaceTextFilePreview = setWorkspaceTextFilePreview,
            setFocusQuery = { repoDiffMarkdownFocusQuery = it },
            setShowSheet = { showRepoDiffSheet = it },
            setScope = { repoDiffSheetScope = it },
            setFullError = { repoDiffSheetFullError = it },
            setLastTurnRows = { repoDiffSheetLastTurnRows = it },
        )
    }

    LaunchedEffect(activeThreadId, gitToolbarRefreshNonce) {
        cachedFullWorkingTreeDiff = null
    }

    fun handleGitActionFailure(
        e: Throwable,
        onNothingToCommit: () -> Unit,
    ) {
        handleMainShellGitActionFailure(
            error = e,
            setProgressMessage = { gitActionProgressMessage = it },
            setProgressPhase = { gitActionProgressPhase = it },
            resetProgressIncludes = {
                gitActionProgressIncludesPush = true
                gitActionProgressIncludesPullRequest = false
            },
            onNothingToCommit = onNothingToCommit,
            setGitSyncAlert = { gitSyncAlert = it },
            clearPendingGitOperation = { pendingGitOperation = null },
            setGitActionError = { gitActionError = it },
        )
    }

    fun enqueueGitPreflightIfNeeded(
        cwd: String,
        operation: TurnGitPreflightOperation,
        submission: GitActionSheetSubmission? = null,
        status: GitRepoSyncResult? = repoStatusSnapshot,
        branches: GitBranchesWithStatusResult? = branchesWithStatusSnapshot,
    ): Boolean {
        val alert = TurnGitPreflightPolicy.alertFor(status, branches, operation) ?: return false
        pendingGitOperation = PendingGitOperation(operation = operation, cwd = cwd, submission = submission)
        gitSyncAlert = alert
        return true
    }

    suspend fun executeGitActionSheetNow(
        submission: GitActionSheetSubmission,
        cwd: String,
    ) {
        executeMainShellGitActionSheet(
            repository = repository,
            context = context,
            submission = submission,
            cwd = cwd,
            timeoutMs = MAIN_SHELL_GIT_OPERATION_TIMEOUT_MS,
            setBusy = { gitActionBusy = it },
            setError = { gitActionError = it },
            setProgressMessage = { gitActionProgressMessage = it },
            setProgressPhase = { gitActionProgressPhase = it },
            setIncludesPush = { gitActionProgressIncludesPush = it },
            setIncludesPullRequest = { gitActionProgressIncludesPullRequest = it },
            closeSheet = {
                gitActionSheetMode = null
                gitActionSheetInitialNextStep = null
            },
            onFailure = { e -> handleGitActionFailure(e) { showNothingToCommit = true } },
            onRefresh = { gitToolbarRefreshNonce++ },
        )
    }

    MainShellGitProgressDismissEffect(
        message = gitActionProgressMessage,
        phase = gitActionProgressPhase,
        busy = gitActionBusy,
        setMessage = { gitActionProgressMessage = it },
        setPhase = { gitActionProgressPhase = it },
    )

    fun continuePendingGitOperation(commitFirst: Boolean = false) {
        val pending = pendingGitOperation ?: return
        gitSyncAlert = null
        pendingGitOperation = null
        scope.launch {
            gitActionBusy = true
            gitActionError = null
            try {
                withTimeout(MAIN_SHELL_GIT_OPERATION_TIMEOUT_MS) {
                    val git = GitActionsService(repository, pending.cwd)
                    if (commitFirst) git.commit("WIP before continuing")
                    val submission = pending.submission
                    if (submission != null) {
                        gitActionBusy = false
                        executeGitActionSheetNow(submission, pending.cwd)
                    } else if (pending.operation is TurnGitPreflightOperation.CreateManagedWorktree) {
                        gitActionBusy = false
                        val tid = activeThreadId ?: return@withTimeout
                        val baseBranch = pending.operation.baseBranch
                        handingOffWorktree = true
                        worktreeHandoffError = null
                        try {
                            val outcome =
                                WorktreeFlowCoordinator(repository).handoffThreadToWorktree(
                                    threadId = tid,
                                    sourceProjectPath = pending.cwd,
                                    associatedWorktreePath = associatedWorktreePath,
                                    baseBranchForNewWorktree = baseBranch,
                                )
                            when (outcome) {
                                is WorktreeFlowHandoffOutcome.Moved -> repository.setActiveThreadId(outcome.move.thread.id)
                                WorktreeFlowHandoffOutcome.MissingAssociatedWorktree ->
                                    worktreeHandoffError = "The associated worktree is no longer available. Open the thread to create a new managed worktree."
                            }
                        } catch (e: Throwable) {
                            worktreeHandoffError = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
                        } finally {
                            handingOffWorktree = false
                        }
                    }
                }
            } catch (e: Throwable) {
                handleGitActionFailure(e) { showNothingToCommit = true }
            } finally {
                if (gitActionBusy) {
                    gitActionBusy = false
                    gitToolbarRefreshNonce++
                }
            }
        }
    }

    fun initializeRepositoryForCurrentThread() {
        val cwd = gitCwd ?: return
        if (repoStatusSnapshot?.isRepo == true) return
        if (!showGitControls || gitActionBusy) return
        scope.launch {
            gitActionBusy = true
            gitActionProgressMessage = gitInitInitializingMessage
            gitInitError = null
            try {
                withTimeout(MAIN_SHELL_GIT_OPERATION_TIMEOUT_MS) {
                    val git = GitActionsService(repository, cwd)
                    val result = git.initializeRepository()
                    val refreshedStatus = result.status ?: runCatching { git.status() }.getOrNull()
                    repoStatusSnapshot = refreshedStatus
                    repoDiffTotals = refreshedStatus?.workingTreeDiffTotals
                    branchesWithStatusSnapshot = runCatching { git.branchesWithStatus() }.getOrNull()
                    defaultGitBaseBranch = branchesWithStatusSnapshot?.defaultBranch
                    showGitInitPrompt = false
                    gitActionProgressMessage = gitInitInitializedMessage
                }
            } catch (e: Throwable) {
                gitActionProgressMessage = null
                gitInitError = e.message?.ifBlank { null } ?: e.toString()
            } finally {
                gitActionBusy = false
                gitToolbarRefreshNonce++
            }
        }
    }

    fun pullRebaseForPendingGitOperation() {
        val cwd = pendingGitOperation?.cwd ?: gitCwd ?: return
        gitSyncAlert = null
        pendingGitOperation = null
        scope.launch {
            gitActionBusy = true
            gitActionError = null
            runCatching {
                withTimeout(MAIN_SHELL_GIT_OPERATION_TIMEOUT_MS) {
                    val result = GitActionsService(repository, cwd).pull()
                    result.status?.let {
                        repoStatusSnapshot = it
                        repoDiffTotals = it.workingTreeDiffTotals
                    }
                }
            }.onFailure { e -> handleGitActionFailure(e) { showNothingToCommit = true } }
            gitActionBusy = false
            gitToolbarRefreshNonce++
        }
    }

    fun discardRuntimeChangesForPendingGitOperation() {
        val cwd = pendingGitOperation?.cwd ?: gitCwd ?: return
        gitSyncAlert = null
        pendingGitOperation = null
        scope.launch {
            gitActionBusy = true
            gitActionError = null
            runCatching {
                withTimeout(MAIN_SHELL_GIT_OPERATION_TIMEOUT_MS) {
                    val result = GitActionsService(repository, cwd).resetToRemoteDiscardRuntime()
                    result.status?.let {
                        repoStatusSnapshot = it
                        repoDiffTotals = it.workingTreeDiffTotals
                    }
                }
            }.onFailure { e -> handleGitActionFailure(e) { showNothingToCommit = true } }
            gitActionBusy = false
            gitToolbarRefreshNonce++
        }
    }

    fun handoffCurrentThreadWorktree(skipPreflight: Boolean = false) {
        handoffMainShellCurrentThreadWorktree(
            activeThreadId = activeThreadId,
            cwd = gitCwd,
            showGitControls = showGitControls,
            showTurnStop = showTurnStop,
            handingOffWorktree = handingOffWorktree,
            isWorktreeProject = isWorktreeProject,
            associatedWorktreePath = associatedWorktreePath,
            localWorktreeHandoffTargetPath = localWorktreeHandoffTargetPath,
            defaultGitBaseBranch = defaultGitBaseBranch,
            branchesWithStatusSnapshot = branchesWithStatusSnapshot,
            repoStatusSnapshot = repoStatusSnapshot,
            repository = repository,
            scope = scope,
            skipPreflight = skipPreflight,
            setPendingGitOperation = { pendingGitOperation = it },
            setGitSyncAlert = { gitSyncAlert = it },
            setHandingOffWorktree = { handingOffWorktree = it },
            setWorktreeHandoffError = { worktreeHandoffError = it },
            onRefresh = { gitToolbarRefreshNonce++ },
        )
    }

    fun handleGitAction(action: TurnGitActionKind) {
        handleMainShellGitToolbarAction(
            action = action,
            cwd = gitCwd,
            repository = repository,
            scope = scope,
            timeoutMs = MAIN_SHELL_GIT_OPERATION_TIMEOUT_MS,
            showGitControls = showGitControls,
            showTurnStop = showTurnStop,
            gitActionBusy = gitActionBusy,
            initializeRepository = ::initializeRepositoryForCurrentThread,
            enqueuePreflight = { cwd, operation, status ->
                enqueueGitPreflightIfNeeded(cwd = cwd, operation = operation, status = status)
            },
            setSheetMode = { gitActionSheetMode = it },
            setInitialNextStep = { gitActionSheetInitialNextStep = it },
            setBusy = { gitActionBusy = it },
            setError = { gitActionError = it },
            setProgressMessage = { gitActionProgressMessage = it },
            setIncludesPush = { gitActionProgressIncludesPush = it },
            setIncludesPullRequest = { gitActionProgressIncludesPullRequest = it },
            setProgressPhase = { gitActionProgressPhase = it },
            setRepoStatus = { repoStatusSnapshot = it },
            setRepoDiffTotals = { repoDiffTotals = it },
            onFailure = { e -> handleGitActionFailure(e) { showNothingToCommit = true } },
            onRefresh = { gitToolbarRefreshNonce++ },
        )
    }

    fun executeGitActionSheet(submission: GitActionSheetSubmission) {
        val cwd = gitCwd ?: return
        if (!showGitControls || showTurnStop || gitActionBusy) return
        if (enqueueGitPreflightIfNeeded(cwd, operationForMainShellSubmission(submission), submission)) return
        scope.launch { executeGitActionSheetNow(submission, cwd) }
    }

    MainShellGitContextRefreshEffect(
        repository = repository,
        ready = ready,
        activeThreadId = activeThreadId,
        threads = threads,
        refreshNonce = gitToolbarRefreshNonce,
        setRepoStatus = { repoStatusSnapshot = it },
        setBranchesWithStatus = { branchesWithStatusSnapshot = it },
        setRepoDiffTotals = { repoDiffTotals = it },
        setDefaultBaseBranch = { defaultGitBaseBranch = it },
        setLoadingRepoDiff = { isLoadingRepoDiff = it },
    )

    return MainShellGitWorkflow(
        gitCwd = gitCwd,
        showGitControls = showGitControls,
        isWorktreeProject = isWorktreeProject,
        handingOffWorktree = handingOffWorktree,
        worktreeHandoffError = worktreeHandoffError,
        repoStatusSnapshot = repoStatusSnapshot,
        repoDiffTotals = repoDiffTotals,
        defaultGitBaseBranch = defaultGitBaseBranch,
        isLoadingRepoDiff = isLoadingRepoDiff,
        showWorktreeHandoff = showWorktreeHandoff,
        gitToastMessage = gitToastMessage,
        gitProgressToast = gitProgressToast,
        showRepoDiffSheet = showRepoDiffSheet,
        repoDiffSheetScope = repoDiffSheetScope,
        repoDiffSheetLastTurnRows = repoDiffSheetLastTurnRows,
        repoDiffSheetFullPatch = repoDiffSheetFullPatch,
        repoDiffSheetFullLoading = repoDiffSheetFullLoading,
        repoDiffSheetFullError = repoDiffSheetFullError,
        repoDiffMarkdownFocusQuery = repoDiffMarkdownFocusQuery,
        gitActionBusy = gitActionBusy,
        gitActionError = gitActionError,
        gitActionSheetMode = gitActionSheetMode,
        gitActionSheetInitialNextStep = gitActionSheetInitialNextStep,
        showGitInitPrompt = showGitInitPrompt,
        gitInitError = gitInitError,
        gitSyncAlert = gitSyncAlert,
        showNothingToCommit = showNothingToCommit,
        openRepoDiffSheetFromHeader = ::openRepoDiffSheetFromHeader,
        openRepoDiffSheetFromMarkdown = ::openRepoDiffSheetFromMarkdown,
        handleGitAction = ::handleGitAction,
        handoffCurrentThreadWorktree = { handoffCurrentThreadWorktree() },
        dismissGitProgress = {
            if (gitActionProgressMessage != null) gitActionProgressMessage = null
            if (gitActionProgressPhase != null) gitActionProgressPhase = null
        },
        refreshGitContext = { gitToolbarRefreshNonce++ },
        setRepoDiffSheetScope = { repoDiffSheetScope = it },
        dismissRepoDiffSheet = {
            showRepoDiffSheet = false
            repoDiffMarkdownFocusQuery = null
        },
        consumeFocusPathQuery = { repoDiffMarkdownFocusQuery = null },
        dismissGitActionSheet = {
            gitActionSheetMode = null
            gitActionSheetInitialNextStep = null
        },
        executeGitActionSheet = ::executeGitActionSheet,
        initializeRepositoryForCurrentThread = ::initializeRepositoryForCurrentThread,
        dismissGitInitPrompt = {
            if (!gitActionBusy) {
                showGitInitPrompt = false
                gitInitError = null
            }
        },
        dismissNothingToCommit = { showNothingToCommit = false },
        dismissGitSyncAlert = {
            gitSyncAlert = null
            pendingGitOperation = null
        },
        handleGitSyncAlertAction = { action ->
            when (action) {
                TurnGitSyncAlertAction.dismissOnly -> {
                    gitSyncAlert = null
                    pendingGitOperation = null
                }
                TurnGitSyncAlertAction.pullRebase -> pullRebaseForPendingGitOperation()
                TurnGitSyncAlertAction.continuePendingGitOperation,
                TurnGitSyncAlertAction.continueGitBranchOperation,
                -> continuePendingGitOperation()
                TurnGitSyncAlertAction.commitAndContinuePendingGitOperation,
                TurnGitSyncAlertAction.commitAndContinueGitBranchOperation,
                -> continuePendingGitOperation(commitFirst = true)
                TurnGitSyncAlertAction.discardRuntimeChanges -> discardRuntimeChangesForPendingGitOperation()
            }
        },
        dismissGitActionError = { gitActionError = null },
        dismissWorktreeHandoffError = { worktreeHandoffError = null },
    )
}
