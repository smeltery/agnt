package com.smeltery.agnt.mobile.ui.mydevices

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.ui.theme.agntScreenTopAppBarColors
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MyDevicesScreen(
    repository: CodexRepository,
    onNavigateBack: () -> Unit,
    onScanQrCode: () -> Unit,
    onPairWithCode: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BackHandler(onBack = onNavigateBack)
    val scope = rememberCoroutineScope()

    val trustedDevices by repository.trustedDevices.collectAsStateWithLifecycle()
    val switchingDeviceId by repository.switchingDeviceId.collectAsStateWithLifecycle()
    val deviceSwitchNotice by repository.deviceSwitchNotice.collectAsStateWithLifecycle()
    val currentTrustedMacDeviceId by repository.currentTrustedMacDeviceId.collectAsStateWithLifecycle()
    val previousTrustedMacDeviceId by repository.previousTrustedMacDeviceId.collectAsStateWithLifecycle()
    val relayMacDeviceId by repository.relayMacDeviceId.collectAsStateWithLifecycle()
    val connectionState by repository.connectionState.collectAsStateWithLifecycle()
    val runningTurnByThread by repository.runningTurnIdByThread.collectAsStateWithLifecycle()
    val protectedRunningFallback by repository.protectedRunningFallbackThreadIds.collectAsStateWithLifecycle()

    var visibilityRevision by remember { mutableStateOf(0) }
    var pendingForgetDeviceId by remember { mutableStateOf<String?>(null) }
    var pendingSwitchDeviceId by remember { mutableStateOf<String?>(null) }
    var menuDeviceId by remember { mutableStateOf<String?>(null) }

    val trustedDeviceContext =
        remember(
            trustedDevices,
            currentTrustedMacDeviceId,
            previousTrustedMacDeviceId,
            relayMacDeviceId,
            connectionState,
            switchingDeviceId,
            visibilityRevision,
        ) {
            TrustedDevicePresentationContext(
                records = trustedDevices,
                currentTrustedMacDeviceId = currentTrustedMacDeviceId,
                previousTrustedMacDeviceId = previousTrustedMacDeviceId,
                relayMacDeviceId = relayMacDeviceId,
                isConnected = connectionState.isConnectedNow(),
                switchingDeviceId = switchingDeviceId,
            )
        }
    val devices = remember(trustedDeviceContext) { MyDevicesPresentation.rowModels(trustedDeviceContext) }
    val currentDevice = remember(devices) { devices.firstOrNull { it.isCurrent } }
    val pairedDevices = remember(devices) { devices.filterNot { it.isCurrent } }
    val isSwitching = switchingDeviceId != null
    val requiresSwitchConfirmation =
        remember(runningTurnByThread, protectedRunningFallback) {
            runningTurnByThread.isNotEmpty() || protectedRunningFallback.isNotEmpty()
        }

    fun requestSwitch(deviceId: String) {
        if (isSwitching || deviceId == currentTrustedMacDeviceId) return
        if (requiresSwitchConfirmation) {
            pendingSwitchDeviceId = deviceId
        } else {
            scope.launch { runCatching { repository.switchToTrustedDevice(deviceId) } }
        }
    }

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.my_devices_title)) },
                colors = agntScreenTopAppBarColors(),
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.cd_navigate_back),
                        )
                    }
                },
            )
        },
        bottomBar = {
            Surface(
                tonalElevation = 0.dp,
                shadowElevation = 0.dp,
                color = MaterialTheme.colorScheme.background,
            ) {
                TextButton(
                    onClick = {
                        if (!isSwitching) {
                            onNavigateBack()
                            onScanQrCode()
                        }
                    },
                    enabled = !isSwitching,
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .navigationBarsPadding()
                            .padding(horizontal = 16.dp, vertical = 12.dp)
                            .clip(RoundedCornerShape(28.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f)),
                ) {
                    Text(
                        text = stringResource(R.string.my_devices_scan_qr_code),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        },
    ) { innerPadding ->
        Box(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(innerPadding),
        ) {
            Column(
                modifier =
                    Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                deviceSwitchNotice?.takeIf { it.isNotBlank() }?.let { notice ->
                    Text(
                        text = notice,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                currentDevice?.let { device ->
                    MyDevicesSectionHeader(text = stringResource(R.string.my_devices_current_device))
                    MyDevicesGroupedCard {
                        CurrentDeviceRow(device = device)
                    }
                }

                MyDevicesSectionHeader(text = stringResource(R.string.my_devices_paired_devices))
                MyDevicesGroupedCard {
                    if (pairedDevices.isEmpty()) {
                        Text(
                            text = stringResource(R.string.my_devices_no_paired),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                        )
                    } else {
                        pairedDevices.forEachIndexed { index, device ->
                            if (index > 0) {
                                HorizontalDivider(
                                    modifier = Modifier.padding(start = 64.dp),
                                    color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f),
                                )
                            }
                            PairedDeviceRow(
                                device = device,
                                enabled = !isSwitching,
                                onSwitch = { requestSwitch(device.deviceId) },
                                menuExpanded = menuDeviceId == device.deviceId,
                                onMenuExpandedChange = { expanded ->
                                    menuDeviceId = if (expanded) device.deviceId else null
                                },
                                onScanQr = {
                                    menuDeviceId = null
                                    onNavigateBack()
                                    onScanQrCode()
                                },
                                onPairWithCode = {
                                    menuDeviceId = null
                                    onNavigateBack()
                                    onPairWithCode()
                                },
                                onToggleMenuVisibility = { visible ->
                                    MyDeviceMenuVisibilityStore.setVisible(visible, device.deviceId)
                                    visibilityRevision++
                                },
                                onForget = {
                                    menuDeviceId = null
                                    pendingForgetDeviceId = device.deviceId
                                },
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.size(8.dp))
            }

            if (isSwitching) {
                DeviceSwitchingOverlay(
                    deviceName = devices.firstOrNull { it.deviceId == switchingDeviceId }?.compactDisplayName,
                    onCancel = {
                        scope.launch { runCatching { repository.cancelDeviceSwitch() } }
                    },
                    modifier = Modifier.matchParentSize(),
                )
            }
        }
    }

    pendingSwitchDeviceId?.let { deviceId ->
        AlertDialog(
            onDismissRequest = { pendingSwitchDeviceId = null },
            title = { Text(stringResource(R.string.my_devices_switch_confirm_title)) },
            text = { Text(stringResource(R.string.my_devices_switch_confirm_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        scope.launch { runCatching { repository.switchToTrustedDevice(deviceId) } }
                        pendingSwitchDeviceId = null
                    },
                ) {
                    Text(stringResource(R.string.my_devices_switch))
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingSwitchDeviceId = null }) {
                    Text(stringResource(android.R.string.cancel))
                }
            },
        )
    }

    pendingForgetDeviceId?.let { deviceId ->
        AlertDialog(
            onDismissRequest = { pendingForgetDeviceId = null },
            title = { Text(stringResource(R.string.my_devices_forget_title)) },
            text = { Text(stringResource(R.string.my_devices_forget_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        repository.forgetTrustedDevice(deviceId)
                        pendingForgetDeviceId = null
                        visibilityRevision++
                    },
                ) {
                    Text(stringResource(R.string.my_devices_forget))
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingForgetDeviceId = null }) {
                    Text(stringResource(android.R.string.cancel))
                }
            },
        )
    }
}
