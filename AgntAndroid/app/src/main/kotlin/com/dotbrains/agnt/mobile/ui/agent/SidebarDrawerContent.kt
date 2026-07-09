package com.dotbrains.agnt.mobile.ui.agent

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.transport.ConnectionState
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.ui.draft.NewChatDraftSource
import com.dotbrains.agnt.mobile.ui.home.RootReconnectRecoveryAction
import com.dotbrains.agnt.mobile.ui.home.RootReconnectUiState
import com.dotbrains.agnt.mobile.ui.mydevices.MyDeviceRowModel
import com.dotbrains.agnt.mobile.ui.mydevices.MyDevicesPresentation
import com.dotbrains.agnt.mobile.ui.mydevices.TrustedDevicePresentationContext
import com.dotbrains.agnt.mobile.ui.navigation.AppRoutes
import com.dotbrains.agnt.mobile.ui.sidebar.SidebarScreen
import com.dotbrains.agnt.mobile.ui.theme.AgntDropdownMenu
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import com.composables.icons.lucide.R as LucideR

/**
 * Drawer sheet body: brand, search + threads (iOS-style list), footer links, Mac connection strip.
 * SwiftUI reference: [SidebarView](CodexMobile/CodexMobile/Views/SidebarView.swift).
 */
@Composable
fun SidebarDrawerContent(
    repository: CodexRepository,
    navController: NavHostController,
    drawerScope: CoroutineScope,
    drawerState: DrawerState,
    onOpenPairingScanner: () -> Unit,
    onReconnectSavedPairing: () -> Unit,
    onWakeSavedComputer: () -> Unit,
    closeDrawer: suspend () -> Unit,
    sessionReady: Boolean,
    connectionState: ConnectionState,
    reconnectUiState: RootReconnectUiState,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val trustedDevices by repository.trustedDevices.collectAsStateWithLifecycle()
    val switchingDeviceId by repository.switchingDeviceId.collectAsStateWithLifecycle()
    val currentTrustedMacDeviceId by repository.currentTrustedMacDeviceId.collectAsStateWithLifecycle()
    val previousTrustedMacDeviceId by repository.previousTrustedMacDeviceId.collectAsStateWithLifecycle()
    val relayMacDeviceId by repository.relayMacDeviceId.collectAsStateWithLifecycle()
    val trustedDeviceContext =
        remember(
            trustedDevices,
            currentTrustedMacDeviceId,
            previousTrustedMacDeviceId,
            relayMacDeviceId,
            connectionState,
            switchingDeviceId,
        ) {
            TrustedDevicePresentationContext(
                records = trustedDevices,
                currentTrustedMacDeviceId = currentTrustedMacDeviceId,
                previousTrustedMacDeviceId = previousTrustedMacDeviceId,
                relayMacDeviceId = relayMacDeviceId,
                isConnected = connectionState is ConnectionState.Connected,
                switchingDeviceId = switchingDeviceId,
            )
        }
    val quickSwitchRows = remember(trustedDeviceContext) { MyDevicesPresentation.switcherRows(trustedDeviceContext) }
    val activeDevice = remember(trustedDeviceContext) { MyDevicesPresentation.activeSwitcherRow(trustedDeviceContext) }
    val showDeviceSwitcher = MyDevicesPresentation.shouldShowDeviceSwitcher(trustedDeviceContext)
    var deviceMenuExpanded by remember { mutableStateOf(false) }
    var pendingSwitchDevice by remember { mutableStateOf<MyDeviceRowModel?>(null) }

    Box(
        modifier =
            modifier
                .fillMaxHeight()
                .fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.fillMaxHeight().fillMaxWidth(),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 12.dp),
            ) {
                Icon(
                    painter = painterResource(LucideR.drawable.lucide_ic_terminal),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(28.dp),
                )
                Text(
                    text = stringResource(R.string.app_name),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onBackground,
                    modifier = Modifier.weight(1f),
                )
                IconButton(
                    onClick = {
                        scope.launch { runCatching { repository.refreshThreads() } }
                    },
                ) {
                    Icon(
                        painter = painterResource(LucideR.drawable.lucide_ic_refresh_cw),
                        contentDescription = stringResource(R.string.cd_refresh_thread_list),
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            HorizontalDivider(modifier = Modifier.padding(horizontal = 0.dp))
            SidebarScreen(
                repository = repository,
                onOpenArchivedChats = {
                    drawerScope.launch {
                        closeDrawer()
                        navController.navigate(AppRoutes.Archived)
                    }
                },
                onThreadSelected = closeDrawer,
                onOpenNewChatDraft = {
                    drawerScope.launch {
                        closeDrawer()
                        navController.navigate(AppRoutes.newChatDraftRoute(NewChatDraftSource.generalChat.name))
                    }
                },
                modifier =
                    Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp),
            )
            HorizontalDivider()
            activeDevice?.takeIf { showDeviceSwitcher }?.let { activeDevice ->
                SidebarDeviceQuickSwitcher(
                    activeDevice = activeDevice,
                    devices = quickSwitchRows,
                    switchingDeviceId = switchingDeviceId,
                    expanded = deviceMenuExpanded,
                    onExpandedChange = { deviceMenuExpanded = it },
                    onChooseDevice = { device ->
                        deviceMenuExpanded = false
                        pendingSwitchDevice = device
                    },
                    onOpenMyDevices = {
                        deviceMenuExpanded = false
                        drawerScope.launch {
                            closeDrawer()
                            navController.navigate(AppRoutes.MyDevices)
                        }
                    },
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                )
                HorizontalDivider()
            }
            Column(
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp),
            ) {
                if (!sessionReady && connectionState !is ConnectionState.Connected) {
                    TextButton(
                        onClick = {
                            if (reconnectUiState.attempt == null) {
                                drawerScope.launch {
                                    closeDrawer()
                                    if (reconnectUiState.recoveryAction == RootReconnectRecoveryAction.ScanNewQr) {
                                        onOpenPairingScanner()
                                    } else if (reconnectUiState.wakeDisplayAvailable) {
                                        onWakeSavedComputer()
                                    } else {
                                        onReconnectSavedPairing()
                                    }
                                }
                            }
                        },
                        enabled = reconnectUiState.attempt == null,
                        modifier = Modifier.fillMaxWidth(),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                    ) {
                        Text(
                            text =
                                when {
                                    reconnectUiState.attempt != null ->
                                        if (reconnectUiState.isWakingDisplay) {
                                            stringResource(R.string.nav_reconnect_waking)
                                        } else {
                                            stringResource(R.string.nav_reconnect_connecting)
                                        }
                                    reconnectUiState.lastErrorMessage != null &&
                                        reconnectUiState.recoveryAction == RootReconnectRecoveryAction.ScanNewQr ->
                                        stringResource(R.string.nav_reconnect_scan_new_qr)
                                    reconnectUiState.wakeDisplayAvailable -> stringResource(R.string.nav_reconnect_wake)
                                    reconnectUiState.lastErrorMessage != null ->
                                        stringResource(R.string.nav_reconnect_retry)
                                    else -> stringResource(R.string.nav_reconnect)
                                },
                            style = MaterialTheme.typography.labelLarge,
                            textAlign = TextAlign.Start,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
            Box(
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .padding(start = 4.dp, end = 8.dp, top = 4.dp, bottom = 10.dp),
            ) {
                Row(
                    modifier = Modifier.align(Alignment.CenterStart),
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    IconButton(
                        onClick = {
                            drawerScope.launch {
                                closeDrawer()
                                navController.navigate(AppRoutes.Settings)
                            }
                        },
                    ) {
                        Icon(
                            painter = painterResource(LucideR.drawable.lucide_ic_settings),
                            contentDescription = stringResource(R.string.nav_settings),
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    IconButton(
                        onClick = {
                            drawerScope.launch {
                                closeDrawer()
                                navController.navigate(AppRoutes.terminalRoute())
                            }
                        },
                    ) {
                        Icon(
                            painter = painterResource(LucideR.drawable.lucide_ic_terminal),
                            contentDescription = stringResource(R.string.nav_terminal),
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    IconButton(
                        onClick = {
                            drawerScope.launch {
                                closeDrawer()
                                navController.navigate(AppRoutes.MyDevices)
                            }
                        },
                    ) {
                        Icon(
                            painter = painterResource(LucideR.drawable.lucide_ic_monitor_smartphone),
                            contentDescription = stringResource(R.string.my_devices_open_cd),
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    IconButton(
                        onClick = {
                            drawerScope.launch {
                                closeDrawer()
                                onOpenPairingScanner()
                            }
                        },
                    ) {
                        Icon(
                            painter = painterResource(LucideR.drawable.lucide_ic_scan_qr_code),
                            contentDescription = stringResource(R.string.nav_pairing_scan),
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
                Text(
                    text = drawerFooterStatus(connectionState, sessionReady),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.End,
                    modifier =
                        Modifier
                            .align(Alignment.CenterEnd)
                            .padding(start = 104.dp),
                )
            }
        }
    }

    pendingSwitchDevice?.let { device ->
        AlertDialog(
            onDismissRequest = { pendingSwitchDevice = null },
            title = { Text(stringResource(R.string.my_devices_switch_confirm_title)) },
            text = { Text(stringResource(R.string.my_devices_switch_confirm_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingSwitchDevice = null
                        drawerScope.launch {
                            repository.switchToTrustedDevice(device.deviceId)
                            closeDrawer()
                        }
                    },
                ) {
                    Text(stringResource(R.string.my_devices_switch))
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingSwitchDevice = null }) {
                    Text(stringResource(R.string.my_devices_cancel))
                }
            },
        )
    }
}

@Composable
private fun SidebarDeviceQuickSwitcher(
    activeDevice: MyDeviceRowModel,
    devices: List<MyDeviceRowModel>,
    switchingDeviceId: String?,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onChooseDevice: (MyDeviceRowModel) -> Unit,
    onOpenMyDevices: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier) {
        Row(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .clickable(enabled = switchingDeviceId == null) { onExpandedChange(true) }
                    .padding(horizontal = 4.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                painter = painterResource(LucideR.drawable.lucide_ic_monitor_smartphone),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = activeDevice.compactDisplayName,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = activeDevice.menuSubtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(
                painter = painterResource(LucideR.drawable.lucide_ic_chevrons_up_down),
                contentDescription = stringResource(R.string.my_devices_sidebar_switcher_cd),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
        AgntDropdownMenu(
            expanded = expanded,
            onDismissRequest = { onExpandedChange(false) },
        ) {
            devices.forEach { device ->
                val enabled = switchingDeviceId == null && !device.isCurrent && !device.isSwitching
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(
                                text = device.compactDisplayName,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = device.menuSubtitle,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                    onClick = { onChooseDevice(device) },
                    enabled = enabled,
                    leadingIcon = {
                        Icon(
                            painter = painterResource(LucideR.drawable.lucide_ic_monitor),
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                    },
                    trailingIcon = {
                        if (device.isCurrent) {
                            Icon(
                                painter = painterResource(LucideR.drawable.lucide_ic_check),
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    },
                )
            }
            HorizontalDivider()
            DropdownMenuItem(
                text = { Text(stringResource(R.string.my_devices_title)) },
                onClick = onOpenMyDevices,
                leadingIcon = {
                    Icon(
                        painter = painterResource(LucideR.drawable.lucide_ic_settings),
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                },
            )
        }
    }
}

@Composable
private fun drawerFooterStatus(
    conn: ConnectionState,
    sessionReady: Boolean,
): String =
    when (conn) {
        ConnectionState.Offline -> stringResource(R.string.sidebar_bridge_offline)
        ConnectionState.Connecting -> stringResource(R.string.sidebar_bridge_connecting)
        ConnectionState.Connected ->
            if (sessionReady) {
                stringResource(R.string.sidebar_footer_connected_mac)
            } else {
                stringResource(R.string.sidebar_bridge_connecting)
            }
        is ConnectionState.Error ->
            stringResource(R.string.sidebar_bridge_error, conn.message)
    }
