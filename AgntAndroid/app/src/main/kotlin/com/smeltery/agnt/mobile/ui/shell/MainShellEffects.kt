package com.smeltery.agnt.mobile.ui.shell

import androidx.compose.material3.DrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.navigation.NavController
import androidx.navigation.NavHostController
import com.smeltery.agnt.mobile.AppContainer
import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.core.shortcut.AgntShortcutAction
import com.smeltery.agnt.mobile.core.shortcut.AgntShortcutPublisher
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.ui.draft.NewChatDraftSource
import com.smeltery.agnt.mobile.ui.home.RootViewModel
import com.smeltery.agnt.mobile.ui.navigation.AppRoutes
import kotlinx.coroutines.launch

@Composable
internal fun MainShellEffects(
    viewModel: RootViewModel,
    repository: CodexRepository,
    navController: NavHostController,
    drawerState: DrawerState,
    ready: Boolean,
    activeThreadId: String?,
    threads: List<CodexThread>,
    hasSidebarSnapshot: Boolean,
) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val currentReady by rememberUpdatedState(ready)
    var backgroundedWhileReady by remember { mutableStateOf(false) }

    DisposableEffect(lifecycleOwner) {
        val observer =
            LifecycleEventObserver { _, event ->
                when (event) {
                    Lifecycle.Event.ON_STOP -> {
                        if (currentReady) {
                            backgroundedWhileReady = true
                        }
                    }
                    Lifecycle.Event.ON_RESUME -> {
                        viewModel.onAppForegrounded()
                        if (backgroundedWhileReady) {
                            backgroundedWhileReady = false
                        }
                    }
                    else -> Unit
                }
            }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(Unit) {
        viewModel.onAppLaunched()
    }

    LaunchedEffect(ready) {
        if (ready) {
            viewModel.restoreActiveThreadIfNeeded()
        }
    }

    LaunchedEffect(activeThreadId) {
        val id = activeThreadId
        if (!id.isNullOrBlank()) {
            viewModel.persistActiveThreadId(id)
        }
    }

    LaunchedEffect(context, threads) {
        AgntShortcutPublisher.publish(context, threads)
    }

    LaunchedEffect(navController, repository) {
        suspend fun routeShortcut(action: AgntShortcutAction) {
            when (action) {
                AgntShortcutAction.NewChat -> {
                    navController.navigate(AppRoutes.newChatDraftRoute(NewChatDraftSource.generalChat.name)) {
                        launchSingleTop = true
                    }
                }
                is AgntShortcutAction.OpenThread -> {
                    repository.setActiveThreadId(action.threadId)
                    navController.popBackStack(AppRoutes.Home, inclusive = false)
                }
            }
        }
        AppContainer.consumePendingShortcutLaunch()?.let { routeShortcut(it) }
        AppContainer.shortcutLaunches.collect {
            AppContainer.consumePendingShortcutLaunch()
            routeShortcut(it)
        }
    }

    LaunchedEffect(drawerState, ready, hasSidebarSnapshot) {
        snapshotFlow { drawerState.isOpen }
            .collect { open ->
                if (open && ready && !hasSidebarSnapshot) {
                    runCatching { repository.refreshThreads() }
                }
            }
    }

    DisposableEffect(navController, drawerState, scope) {
        val listener =
            NavController.OnDestinationChangedListener { _, _, _ ->
                if (drawerState.isOpen) {
                    scope.launch { drawerState.close() }
                }
            }
        navController.addOnDestinationChangedListener(listener)
        onDispose {
            navController.removeOnDestinationChangedListener(listener)
        }
    }
}
