package com.smeltery.agnt.mobile.ui.shell

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.DrawerState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.smeltery.agnt.mobile.core.model.GitDiffTotals
import com.smeltery.agnt.mobile.core.model.TurnGitActionKind
import com.smeltery.agnt.mobile.core.transport.ConnectionState
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.ui.agent.ConversationHeader
import com.smeltery.agnt.mobile.ui.agent.SidebarDrawerContent
import com.smeltery.agnt.mobile.ui.home.GitActionProgressBannerState
import com.smeltery.agnt.mobile.ui.home.RootReconnectUiState
import com.smeltery.agnt.mobile.ui.home.ThreadCompletionBanner
import com.smeltery.agnt.mobile.ui.navigation.AppNavHost
import com.smeltery.agnt.mobile.ui.navigation.AppRoutes
import com.smeltery.agnt.mobile.ui.pet.PetCompanionHost
import com.smeltery.agnt.mobile.ui.turn.timeline.LocalOpenRepoDiffForMarkdownLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

@Composable
internal fun MainShellContent(
    modifier: Modifier,
    drawerState: DrawerState,
    drawerScope: CoroutineScope,
    repository: CodexRepository,
    navController: NavHostController,
    ready: Boolean,
    connectionState: ConnectionState,
    reconnectUiState: RootReconnectUiState,
    onOpenPairingScanner: () -> Unit,
    onReconnectSavedPairing: () -> Unit,
    onWakeSavedComputer: () -> Unit,
    showShellHeader: Boolean,
    activeThreadTitle: String,
    pathSubtitle: String?,
    threadPathFull: String?,
    onShowPathDialog: () -> Unit,
    showTurnStop: Boolean,
    repoDiffTotals: GitDiffTotals?,
    isLoadingRepoDiff: Boolean,
    showGitControls: Boolean,
    onOpenRepoDiffSheetFromHeader: () -> Unit,
    onGitAction: (TurnGitActionKind) -> Unit,
    gitActionBusy: Boolean,
    repoIsDirty: Boolean,
    gitActionEnabled: Boolean,
    gitInitialized: Boolean,
    showDesktopHandoff: Boolean,
    handingOffToDesktop: Boolean,
    showWorktreeHandoff: Boolean,
    handingOffWorktree: Boolean,
    isWorktreeProject: Boolean,
    onContinueDesktop: () -> Unit,
    onWorktreeHandoff: () -> Unit,
    onStopTurn: () -> Unit,
    gitCwd: String?,
    gitToastMessage: String?,
    gitProgressToast: GitActionProgressBannerState?,
    onDismissGitProgress: () -> Unit,
    onGitContextChanged: () -> Unit,
    onOpenRepoDiffFromMarkdown: (String) -> Unit,
) {
    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet {
                SidebarDrawerContent(
                    repository = repository,
                    navController = navController,
                    drawerScope = drawerScope,
                    drawerState = drawerState,
                    onOpenPairingScanner = onOpenPairingScanner,
                    onReconnectSavedPairing = onReconnectSavedPairing,
                    onWakeSavedComputer = onWakeSavedComputer,
                    closeDrawer = { drawerState.close() },
                    sessionReady = ready,
                    connectionState = connectionState,
                    reconnectUiState = reconnectUiState,
                )
            }
        },
    ) {
        Scaffold(
            modifier = modifier.fillMaxSize(),
            containerColor = MaterialTheme.colorScheme.background,
            // Home overlays ConversationHeader inside content; do not reserve root top-bar height.
            contentWindowInsets =
                WindowInsets.safeDrawing.only(
                    WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom,
                ),
        ) { innerPadding ->
            Box(
                modifier =
                    Modifier
                        .fillMaxSize()
                        .padding(innerPadding),
            ) {
                CompositionLocalProvider(
                    LocalOpenRepoDiffForMarkdownLink provides onOpenRepoDiffFromMarkdown,
                ) {
                    AppNavHost(
                        navController = navController,
                        repository = repository,
                        reconnectUiState = reconnectUiState,
                        onReconnectSavedPairing = onReconnectSavedPairing,
                        onWakeSavedComputer = onWakeSavedComputer,
                        onOpenPairingScanner = onOpenPairingScanner,
                        onGitContextChanged = onGitContextChanged,
                        modifier =
                            Modifier
                                .fillMaxSize()
                                .then(if (showShellHeader) Modifier.statusBarsPadding() else Modifier),
                    )
                }
                // Optional companion pet, drawn above content. Interaction is limited
                // to Home so drags don't fight other screens' gestures.
                PetCompanionHost(
                    bottomExclusionHeightDp = 140f,
                    isInteractionEnabled = showShellHeader,
                )
                if (showShellHeader) {
                    ConversationHeader(
                        title = activeThreadTitle,
                        pathSubtitle = pathSubtitle,
                        onPathClick =
                            threadPathFull?.let {
                                onShowPathDialog
                            },
                        showRunningPill = showTurnStop,
                        repoDiffTotals = repoDiffTotals,
                        isLoadingRepoDiff = isLoadingRepoDiff,
                        onTapRepoDiff =
                            if (repoDiffTotals?.hasChanges == true && showGitControls) {
                                {
                                    onOpenRepoDiffSheetFromHeader()
                                }
                            } else {
                                null
                            },
                        showGitActions = showGitControls,
                        onGitAction = onGitAction,
                        gitActionsBusy = gitActionBusy,
                        showsDiscardRuntimeRecovery = repoIsDirty,
                        isGitActionEnabled = gitActionEnabled,
                        isGitInitialized = gitInitialized,
                        showDesktopHandoff = showDesktopHandoff,
                        handingOffToDesktop = handingOffToDesktop,
                        showWorktreeHandoff = showWorktreeHandoff,
                        handingOffWorktree = handingOffWorktree,
                        isWorktreeProject = isWorktreeProject,
                        showTurnStop = showTurnStop,
                        onOpenDrawer = {
                            drawerScope.launch { drawerState.open() }
                        },
                        onContinueDesktop = onContinueDesktop,
                        onWorktreeHandoff = onWorktreeHandoff,
                        onStopTurn = onStopTurn,
                        // Surface the menu item whenever the active thread has a repo-bound
                        // cwd. Mirrors iOS `onTapTerminal = onOpenTerminal == nil ? nil : { onOpenTerminal?(gitWorkingDirectory) }`.
                        showOpenTerminalHere = !gitCwd.isNullOrBlank(),
                        onOpenTerminalHere =
                            gitCwd?.takeIf { it.isNotBlank() }?.let { cwd ->
                                { navController.navigate(AppRoutes.terminalRoute(cwd)) }
                            },
                        modifier = Modifier.align(Alignment.TopCenter),
                    )
                }
                if (showShellHeader) {
                    ThreadCompletionBanner(
                        bannerMessage = gitToastMessage,
                        gitProgress = gitProgressToast,
                        onTap = { },
                        onDismiss = onDismissGitProgress,
                        modifier =
                            Modifier
                                .align(Alignment.TopCenter)
                                .statusBarsPadding()
                                .padding(top = 128.dp),
                    )
                }
            }
        }
    }
}
