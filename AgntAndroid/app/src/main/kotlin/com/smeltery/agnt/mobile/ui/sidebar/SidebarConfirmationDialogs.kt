package com.smeltery.agnt.mobile.ui.sidebar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.CodexThread

@Composable
internal fun SidebarDeleteLocalThreadDialog(
    target: CodexThread?,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onConfirm: (CodexThread) -> Unit,
) {
    target ?: return
    AlertDialog(
        onDismissRequest = {
            if (!busy) onDismiss()
        },
        title = { Text(stringResource(R.string.sidebar_thread_delete_local_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.sidebar_thread_delete_local_message, target.displayTitle))
                SidebarDialogError(error)
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = { onConfirm(target) },
            ) {
                Text(
                    text =
                        if (busy) {
                            stringResource(R.string.sidebar_thread_delete_local_deleting)
                        } else {
                            stringResource(R.string.sidebar_thread_delete_local_confirm)
                        },
                    color = MaterialTheme.colorScheme.error,
                )
            }
        },
        dismissButton = {
            TextButton(
                enabled = !busy,
                onClick = onDismiss,
            ) {
                Text(stringResource(android.R.string.cancel))
            }
        },
    )
}

@Composable
internal fun SidebarArchiveGroupDialog(
    group: SidebarThreadGroup?,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onConfirm: (SidebarThreadGroup) -> Unit,
) {
    group ?: return
    AlertDialog(
        onDismissRequest = {
            if (!busy) onDismiss()
        },
        title = { Text(stringResource(R.string.sidebar_project_archive_title, group.label)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.sidebar_project_archive_message))
                SidebarDialogError(error)
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = { onConfirm(group) },
            ) {
                Text(
                    text =
                        if (busy) {
                            stringResource(R.string.sidebar_project_archive_busy)
                        } else {
                            stringResource(R.string.sidebar_project_archive_confirm)
                        },
                )
            }
        },
        dismissButton = {
            TextButton(
                enabled = !busy,
                onClick = onDismiss,
            ) {
                Text(stringResource(android.R.string.cancel))
            }
        },
    )
}

@Composable
internal fun SidebarDeleteLocalGroupDialog(
    group: SidebarThreadGroup?,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onConfirm: (SidebarThreadGroup) -> Unit,
) {
    group ?: return
    AlertDialog(
        onDismissRequest = {
            if (!busy) onDismiss()
        },
        title = { Text(stringResource(R.string.sidebar_project_delete_local_title, group.label)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.sidebar_project_delete_local_message))
                SidebarDialogError(error)
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = { onConfirm(group) },
            ) {
                Text(
                    text =
                        if (busy) {
                            stringResource(R.string.sidebar_project_delete_local_busy)
                        } else {
                            stringResource(R.string.sidebar_project_delete_local_confirm)
                        },
                    color = MaterialTheme.colorScheme.error,
                )
            }
        },
        dismissButton = {
            TextButton(
                enabled = !busy,
                onClick = onDismiss,
            ) {
                Text(stringResource(android.R.string.cancel))
            }
        },
    )
}

@Composable
private fun SidebarDialogError(error: String?) {
    error ?: return
    Text(
        text = error,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
    )
}
