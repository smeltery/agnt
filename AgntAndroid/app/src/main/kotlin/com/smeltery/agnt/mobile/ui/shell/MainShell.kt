package com.smeltery.agnt.mobile.ui.shell

import android.content.ClipData
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.toClipEntry
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.services.agent.connection.DesktopHandoffService
import com.smeltery.agnt.mobile.services.workspace.WorkspaceTextFileService
import com.smeltery.agnt.mobile.ui.LocalCodexRepository
import com.smeltery.agnt.mobile.ui.agent.truncatePathMiddle
import com.smeltery.agnt.mobile.ui.home.RootViewModel
import com.smeltery.agnt.mobile.ui.navigation.AppRoutes
import com.smeltery.agnt.mobile.ui.turn.WorkspaceTextFilePreviewRequest
import kotlinx.coroutines.launch

private const val GIT_OPERATION_TIMEOUT_MS = 150_000L

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainShell(
    viewModel: RootViewModel,
    onOpenPairingScanner: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val repository = LocalCodexRepository.current
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val navController = rememberNavController()
    val currentBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = currentBackStackEntry?.destination?.route
    val showShellHeader = currentRoute == AppRoutes.Home

    // Hoisted out of scope.launch so they re-cache on configuration change.
    val gitRepoDiffLoadErrorMessage = stringResource(R.string.git_repo_diff_load_error)
    val gitInitInitializingMessage = stringResource(R.string.git_init_initializing)
    val gitInitInitializedMessage = stringResource(R.string.git_init_initialized)

    val ready by repository.isSessionReady.collectAsStateWithLifecycle()
    val activeThreadId by repository.activeThreadId.collectAsStateWithLifecycle()
    val threads by repository.threads.collectAsStateWithLifecycle()
    val runningTurnByThread by repository.runningTurnIdByThread.collectAsStateWithLifecycle()
    val protectedRunningFallback by repository.protectedRunningFallbackThreadIds.collectAsStateWithLifecycle()
    val pendingApprovalRequest by repository.pendingApprovalRequest.collectAsStateWithLifecycle()
    val pendingStructuredInputRequest by repository.pendingStructuredInputRequest.collectAsStateWithLifecycle()
    val bridgeUpdatePrompt by repository.bridgeUpdatePrompt.collectAsStateWithLifecycle()
    val systemNotices by repository.systemNotices.collectAsStateWithLifecycle()
    val connectionState by repository.connectionState.collectAsStateWithLifecycle()
    val reconnectUiState by viewModel.reconnectUiState.collectAsStateWithLifecycle()
    val messagesByThread by repository.messagesByThread.collectAsStateWithLifecycle()
    val handoffFallbackMessage = stringResource(R.string.turn_open_desktop_failed_fallback)
    val appName = stringResource(R.string.app_name)
    val gitStatusLoadingToast = stringResource(R.string.git_status_loading_toast)
    val bridgeUpdateFailedFallback = stringResource(R.string.bridge_update_failed_fallback)
    val context = LocalContext.current
    var desktopHandoffError by remember { mutableStateOf<String?>(null) }
    var bridgeUpdateError by remember { mutableStateOf<String?>(null) }
    var isUpdatingBridge by remember { mutableStateOf(false) }
    var handingOffToDesktop by remember { mutableStateOf(false) }
    var showPathDialog by remember { mutableStateOf(false) }
    var workspaceTextFilePreview by remember { mutableStateOf<WorkspaceTextFilePreviewRequest?>(null) }
    val workspaceTextFileService = remember(repository) { WorkspaceTextFileService(repository) }
    val clipboard = LocalClipboard.current
    val showTurnStop =
        ready &&
            activeThreadId?.let { tid ->
                runningTurnByThread.containsKey(tid) || protectedRunningFallback.contains(tid)
            } == true
    val showDesktopHandoff = ready && !activeThreadId.isNullOrBlank()
    val activeThread =
        remember(activeThreadId, threads) {
            activeThreadId?.let { id -> threads.firstOrNull { it.id == id } }
        }
    val activeThreadTitle =
        remember(activeThreadId, threads, appName) {
            activeThreadId
                ?.let { id -> threads.firstOrNull { it.id == id }?.displayTitle }
                ?.takeIf { it.isNotBlank() }
                ?: appName
        }
    val threadPathFull =
        remember(activeThread) {
            activeThread?.cwd?.trim()?.takeIf { it.isNotEmpty() }
        }
    val pathSubtitle =
        remember(threadPathFull) {
            threadPathFull?.let { truncatePathMiddle(it) }
        }
    val threadMessages =
        remember(activeThreadId, messagesByThread) {
            activeThreadId?.let { tid -> messagesByThread[tid] }.orEmpty()
        }
    val gitWorkflow =
        rememberMainShellGitWorkflow(
            repository = repository,
            scope = scope,
            context = context,
            ready = ready,
            activeThreadId = activeThreadId,
            threads = threads,
            activeThread = activeThread,
            threadMessages = threadMessages,
            threadPathFull = threadPathFull,
            showTurnStop = showTurnStop,
            gitRepoDiffLoadErrorMessage = gitRepoDiffLoadErrorMessage,
            gitInitInitializingMessage = gitInitInitializingMessage,
            gitInitInitializedMessage = gitInitInitializedMessage,
            gitStatusLoadingToast = gitStatusLoadingToast,
            setWorkspaceTextFilePreview = { workspaceTextFilePreview = it },
        )
    val gitCwd = gitWorkflow.gitCwd
    val showGitControls = gitWorkflow.showGitControls
    val isWorktreeProject = gitWorkflow.isWorktreeProject
    val repoStatusSnapshot = gitWorkflow.repoStatusSnapshot
    val repoDiffTotals = gitWorkflow.repoDiffTotals
    val gitActionBusy = gitWorkflow.gitActionBusy

    val hasSidebarSnapshot = threads.isNotEmpty()
    MainShellEffects(
        viewModel = viewModel,
        repository = repository,
        navController = navController,
        drawerState = drawerState,
        ready = ready,
        activeThreadId = activeThreadId,
        threads = threads,
        hasSidebarSnapshot = hasSidebarSnapshot,
    )

    MainShellContent(
        modifier = modifier,
        drawerState = drawerState,
        drawerScope = scope,
        repository = repository,
        navController = navController,
        ready = ready,
        connectionState = connectionState,
        reconnectUiState = reconnectUiState,
        onOpenPairingScanner = onOpenPairingScanner,
        onReconnectSavedPairing = viewModel::reconnectSavedPairingManually,
        onWakeSavedComputer = viewModel::wakeSavedComputerDisplay,
        showShellHeader = showShellHeader,
        activeThreadTitle = activeThreadTitle,
        pathSubtitle = pathSubtitle,
        threadPathFull = threadPathFull,
        onShowPathDialog = { showPathDialog = true },
        showTurnStop = showTurnStop,
        repoDiffTotals = repoDiffTotals,
        isLoadingRepoDiff = gitWorkflow.isLoadingRepoDiff,
        showGitControls = showGitControls,
        onOpenRepoDiffSheetFromHeader = gitWorkflow.openRepoDiffSheetFromHeader,
        onGitAction = gitWorkflow.handleGitAction,
        gitActionBusy = gitActionBusy,
        repoIsDirty = repoStatusSnapshot?.isDirty == true,
        gitActionEnabled = showGitControls && !showTurnStop,
        gitInitialized = repoStatusSnapshot?.isRepo == true,
        showDesktopHandoff = showDesktopHandoff,
        handingOffToDesktop = handingOffToDesktop,
        showWorktreeHandoff = gitWorkflow.showWorktreeHandoff,
        handingOffWorktree = gitWorkflow.handingOffWorktree,
        isWorktreeProject = isWorktreeProject,
        onContinueDesktop = {
            val tid = activeThreadId
            if (tid != null) {
                handingOffToDesktop = true
                desktopHandoffError = null
                scope.launch {
                    runCatching { DesktopHandoffService(repository).continueOnDesktop(tid) }
                        .onFailure { error -> desktopHandoffError = error.message ?: handoffFallbackMessage }
                    handingOffToDesktop = false
                }
            }
        },
        onWorktreeHandoff = gitWorkflow.handoffCurrentThreadWorktree,
        onStopTurn = {
            val tid = activeThreadId
            if (tid != null) {
                scope.launch { runCatching { repository.interruptTurn(threadId = tid) } }
            }
        },
        gitCwd = gitCwd,
        gitToastMessage = gitWorkflow.gitToastMessage,
        gitProgressToast = gitWorkflow.gitProgressToast,
        onDismissGitProgress = gitWorkflow.dismissGitProgress,
        onGitContextChanged = gitWorkflow.refreshGitContext,
        onOpenRepoDiffFromMarkdown = gitWorkflow.openRepoDiffSheetFromMarkdown,
    )

    MainShellOverlays(
        showPathDialog = showPathDialog,
        threadPathFull = threadPathFull,
        onDismissPathDialog = { showPathDialog = false },
        onCopyThreadPath = { fullPath ->
            scope.launch {
                clipboard.setClipEntry(
                    ClipData.newPlainText("thread-path", fullPath).toClipEntry(),
                )
                showPathDialog = false
            }
        },
        showRepoDiffSheet = gitWorkflow.showRepoDiffSheet,
        repoDiffSheetScope = gitWorkflow.repoDiffSheetScope,
        onRepoDiffScopeChange = gitWorkflow.setRepoDiffSheetScope,
        repoDiffSheetLastTurnRows = gitWorkflow.repoDiffSheetLastTurnRows,
        repoDiffSheetFullPatch = gitWorkflow.repoDiffSheetFullPatch,
        repoDiffSheetFullLoading = gitWorkflow.repoDiffSheetFullLoading,
        repoDiffSheetFullError = gitWorkflow.repoDiffSheetFullError,
        repoStatusSnapshot = repoStatusSnapshot,
        repoDiffMarkdownFocusQuery = gitWorkflow.repoDiffMarkdownFocusQuery,
        onFocusPathQueryConsumed = gitWorkflow.consumeFocusPathQuery,
        onDismissRepoDiffSheet = gitWorkflow.dismissRepoDiffSheet,
        gitActionSheetMode = gitWorkflow.gitActionSheetMode,
        gitActionSheetInitialNextStep = gitWorkflow.gitActionSheetInitialNextStep,
        defaultGitBaseBranch = gitWorkflow.defaultGitBaseBranch,
        gitActionBusy = gitActionBusy,
        onDismissGitActionSheet = gitWorkflow.dismissGitActionSheet,
        onSubmitGitActionSheet = gitWorkflow.executeGitActionSheet,
        showGitInitPrompt = gitWorkflow.showGitInitPrompt,
        gitInitError = gitWorkflow.gitInitError,
        onInitializeRepository = gitWorkflow.initializeRepositoryForCurrentThread,
        onDismissGitInitPrompt = gitWorkflow.dismissGitInitPrompt,
        showNothingToCommit = gitWorkflow.showNothingToCommit,
        onDismissNothingToCommit = gitWorkflow.dismissNothingToCommit,
        gitSyncAlert = gitWorkflow.gitSyncAlert,
        onDismissGitSyncAlert = gitWorkflow.dismissGitSyncAlert,
        onGitSyncAlertAction = gitWorkflow.handleGitSyncAlertAction,
        gitActionError = gitWorkflow.gitActionError,
        onDismissGitActionError = gitWorkflow.dismissGitActionError,
        desktopHandoffError = desktopHandoffError,
        onDismissDesktopHandoffError = { desktopHandoffError = null },
        worktreeHandoffError = gitWorkflow.worktreeHandoffError,
        onDismissWorktreeHandoffError = gitWorkflow.dismissWorktreeHandoffError,
        pendingApprovalRequest = pendingApprovalRequest,
        onResolvePendingApproval = { request, decision ->
            scope.launch { runCatching { repository.resolvePendingApproval(request.id, decision) } }
        },
        pendingStructuredInputRequest = pendingStructuredInputRequest,
        onSubmitStructuredInput = { request, answers ->
            scope.launch { repository.resolvePendingStructuredInput(request.id, answers) }
        },
        onSkipStructuredInput = { request ->
            scope.launch { repository.resolvePendingStructuredInput(request.id, emptyMap()) }
        },
        bridgeUpdatePrompt = bridgeUpdatePrompt,
        ready = ready,
        isUpdatingBridge = isUpdatingBridge,
        bridgeUpdateError = bridgeUpdateError,
        onDismissBridgeUpdate = {
            bridgeUpdateError = null
            repository.dismissBridgeUpdatePrompt()
        },
        onUpdateBridge = {
            if (!isUpdatingBridge) {
                bridgeUpdateError = null
                isUpdatingBridge = true
                scope.launch {
                    try {
                        repository.updateBridgePackageAndRestart()
                        repository.dismissBridgeUpdatePrompt()
                        viewModel.retryBridgeConnectionAfterUpdate()
                    } catch (error: Exception) {
                        bridgeUpdateError =
                            error.message?.takeIf { it.isNotBlank() }
                                ?: bridgeUpdateFailedFallback
                    } finally {
                        isUpdatingBridge = false
                    }
                }
            }
        },
        onRetryBridgeUpdate = {
            bridgeUpdateError = null
            viewModel.retryBridgeConnectionAfterUpdate()
        },
        onScanNewQr = {
            bridgeUpdateError = null
            repository.dismissBridgeUpdatePrompt()
            onOpenPairingScanner()
        },
        systemNotices = systemNotices,
        onDismissSystemNotice = { id -> repository.dismissSystemNotice(id) },
        workspaceTextFilePreview = workspaceTextFilePreview,
        workspaceTextFileService = workspaceTextFileService,
        onDismissWorkspaceTextFilePreview = { workspaceTextFilePreview = null },
    )
}
