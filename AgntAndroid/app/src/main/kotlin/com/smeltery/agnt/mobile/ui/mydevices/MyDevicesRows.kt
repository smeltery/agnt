package com.smeltery.agnt.mobile.ui.mydevices

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.smeltery.agnt.mobile.R

@Composable
internal fun MyDevicesSectionHeader(
    text: String,
    modifier: Modifier = Modifier,
) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(start = 4.dp, bottom = 4.dp),
    )
}

@Composable
internal fun MyDevicesGroupedCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
    ) {
        Column {
            content()
        }
    }
}

@Composable
internal fun CurrentDeviceRow(
    device: MyDeviceRowModel,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier =
            modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        DeviceAvatar(device = device, diameter = 40.dp)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = device.primaryName,
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            DeviceStatusSubtitle(device = device)
        }
    }
}

@Composable
internal fun PairedDeviceRow(
    device: MyDeviceRowModel,
    enabled: Boolean,
    onSwitch: () -> Unit,
    menuExpanded: Boolean,
    onMenuExpandedChange: (Boolean) -> Unit,
    onScanQr: () -> Unit,
    onPairWithCode: () -> Unit,
    onToggleMenuVisibility: (Boolean) -> Unit,
    onForget: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .clickable(enabled = enabled, onClick = onSwitch)
                    .padding(start = 14.dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            DeviceAvatar(device = device, diameter = 40.dp)
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = device.primaryName,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                DeviceStatusSubtitle(device = device)
            }
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(22.dp),
            )
            IconButton(
                onClick = { onMenuExpandedChange(true) },
                enabled = enabled,
                modifier = Modifier.size(40.dp),
            ) {
                Icon(
                    imageVector = Icons.Outlined.MoreHoriz,
                    contentDescription = stringResource(R.string.my_devices_device_actions_cd),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        val showInMenu = MyDeviceMenuVisibilityStore.isVisible(device.deviceId)
        DropdownMenu(
            expanded = menuExpanded,
            onDismissRequest = { onMenuExpandedChange(false) },
        ) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.my_devices_scan_qr)) },
                onClick = onScanQr,
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.my_devices_pair_code)) },
                onClick = onPairWithCode,
            )
            DropdownMenuItem(
                text = {
                    Text(
                        if (showInMenu) {
                            stringResource(R.string.my_devices_hide_from_menu)
                        } else {
                            stringResource(R.string.my_devices_show_in_menu)
                        },
                    )
                },
                onClick = {
                    onToggleMenuVisibility(!showInMenu)
                    onMenuExpandedChange(false)
                },
            )
            DropdownMenuItem(
                text = {
                    Text(
                        text = stringResource(R.string.my_devices_forget),
                        color = MaterialTheme.colorScheme.error,
                    )
                },
                onClick = onForget,
            )
        }
    }
}

@Composable
private fun DeviceAvatar(
    device: MyDeviceRowModel,
    diameter: Dp,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier =
            modifier
                .size(diameter)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.6f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Icons.Outlined.Computer,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(diameter * 0.45f),
        )
        if (device.isConnected) {
            Box(
                modifier =
                    Modifier
                        .align(Alignment.BottomEnd)
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary),
            )
        }
    }
}

@Composable
private fun DeviceStatusSubtitle(
    device: MyDeviceRowModel,
    modifier: Modifier = Modifier,
) {
    Text(
        text = device.menuSubtitle,
        style = MaterialTheme.typography.bodySmall,
        color =
            if (device.isConnected) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier,
    )
}

@Composable
internal fun DeviceSwitchingOverlay(
    deviceName: String?,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier =
            modifier
                .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.35f)),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            tonalElevation = 6.dp,
            modifier = Modifier.padding(horizontal = 32.dp),
        ) {
            Column(
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
                Text(
                    text = stringResource(R.string.my_devices_switching_title),
                    style = MaterialTheme.typography.titleSmall,
                )
                deviceName?.let { name ->
                    Text(
                        text = name,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onCancel) {
                    Text(stringResource(R.string.my_devices_cancel))
                }
            }
        }
    }
}
