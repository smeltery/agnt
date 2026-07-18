package com.dotbrains.agnt.mobile.ui.settings

import android.Manifest
import android.content.Context
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.notification.LocalNotificationSettings

@Composable
internal fun SettingsNotificationSection(context: Context) {
    var refreshNonce by remember { mutableStateOf(0) }
    var requestedInSession by remember { mutableStateOf(false) }
    val lifecycleOwner = LocalLifecycleOwner.current
    val permissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            requestedInSession = true
            refreshNonce++
        }
    DisposableEffect(lifecycleOwner) {
        val observer =
            LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME) {
                    refreshNonce++
                }
            }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val permissionStatus =
        remember(refreshNonce, context) {
            LocalNotificationSettings.permissionStatus(context)
        }
    val notificationsEnabled =
        permissionStatus == LocalNotificationSettings.PermissionStatus.Granted ||
            permissionStatus == LocalNotificationSettings.PermissionStatus.NotRequired

    Text(
        text = stringResource(R.string.settings_notifications_hint),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.settings_notifications_run_completion_title),
                style = MaterialTheme.typography.bodyLarge,
            )
            Text(
                text =
                    stringResource(
                        if (notificationsEnabled) {
                            R.string.settings_notifications_status_enabled
                        } else {
                            R.string.settings_notifications_status_disabled
                        },
                    ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (notificationsEnabled) {
        Text(
            text = stringResource(R.string.settings_notifications_enabled_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    } else {
        Text(
            text = stringResource(R.string.settings_notifications_disabled_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (
            Build.VERSION.SDK_INT >= 33 &&
            permissionStatus == LocalNotificationSettings.PermissionStatus.RuntimePermissionRequired &&
            !requestedInSession
        ) {
            TextButton(
                onClick = { permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) },
            ) {
                Text(stringResource(R.string.settings_notifications_request_permission))
            }
        } else {
            TextButton(
                onClick = { openSystemNotificationSettings(context) },
            ) {
                Text(stringResource(R.string.settings_notifications_open_system_settings))
            }
        }
    }
}
