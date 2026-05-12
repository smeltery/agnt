package com.dotbrains.agnt.mobile.ui.navigation

import com.dotbrains.agnt.mobile.AppContainer
import com.dotbrains.agnt.mobile.core.config.FeatureFlags
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.ui.about.AboutScreen
import com.dotbrains.agnt.mobile.ui.about.WhatsNewScreen
import com.dotbrains.agnt.mobile.ui.home.RootReconnectUiState
import com.dotbrains.agnt.mobile.ui.home.HomeMainContent
import com.dotbrains.agnt.mobile.ui.archived.ArchivedChatsScreen
import com.dotbrains.agnt.mobile.ui.beta.TesterHqScreen
import com.dotbrains.agnt.mobile.ui.settings.SettingsScreen

@Composable
fun AppNavHost(
    navController: NavHostController,
    repository: CodexRepository,
    reconnectUiState: RootReconnectUiState = RootReconnectUiState(),
    onReconnectSavedPairing: () -> Unit = {},
    onWakeSavedComputer: () -> Unit = {},
    onOpenPairingScanner: () -> Unit = {},
    onGitContextChanged: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    NavHost(
        navController = navController,
        startDestination = AppRoutes.Home,
        modifier = modifier,
    ) {
        composable(AppRoutes.Home) {
            HomeMainContent(
                repository = repository,
                reconnectUiState = reconnectUiState,
                onReconnectSavedPairing = onReconnectSavedPairing,
                onWakeSavedComputer = onWakeSavedComputer,
                onOpenPairingScanner = onOpenPairingScanner,
                onGitContextChanged = onGitContextChanged,
            )
        }
        composable(AppRoutes.Settings) {
            SettingsScreen(
                repository = repository,
                onNavigateBack = { navController.popBackStack() },
                onNavigateToAbout = { navController.navigate(AppRoutes.About) },
                onNavigateToWhatsNew = { navController.navigate(AppRoutes.WhatsNew) },
                onNavigateToTesterHq = {
                    if (FeatureFlags.betaEngagementEnabled) {
                        navController.navigate(AppRoutes.TesterHq)
                    }
                },
            )
        }
        composable(AppRoutes.Archived) {
            ArchivedChatsScreen(
                repository = repository,
                onNavigateBack = { navController.popBackStack() },
            )
        }
        composable(AppRoutes.About) {
            AboutScreen(onNavigateBack = { navController.popBackStack() })
        }
        composable(AppRoutes.WhatsNew) {
            WhatsNewScreen(onNavigateBack = { navController.popBackStack() })
        }
        composable(AppRoutes.TesterHq) {
            TesterHqScreen(
                repository = AppContainer.betaEngagementRepository,
                onNavigateBack = { navController.popBackStack() },
            )
        }
    }
}
