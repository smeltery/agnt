package com.dotbrains.agnt.mobile.ui.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.PendingApprovalDecision
import com.dotbrains.agnt.mobile.core.model.PendingApprovalRequest
import com.dotbrains.agnt.mobile.core.model.TurnGitSyncAlert
import com.dotbrains.agnt.mobile.core.model.TurnGitSyncAlertAction
import com.dotbrains.agnt.mobile.core.model.TurnGitSyncAlertButtonRole

@Composable
internal fun ThreadPathDialog(
    fullPath: String,
    onDismiss: () -> Unit,
    onCopy: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.turn_thread_path_dialog_title)) },
        text = {
            SelectionContainer {
                Text(
                    text = fullPath,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onCopy) {
                Text(stringResource(R.string.turn_thread_path_copy))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(android.R.string.cancel))
            }
        },
    )
}

@Composable
internal fun GitInitPromptDialog(
    isBusy: Boolean,
    error: String?,
    onInitialize: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = {
            if (!isBusy) onDismiss()
        },
        title = { Text(stringResource(R.string.git_init_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.git_init_message))
                error?.let { err ->
                    Text(
                        text = err,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = onInitialize,
                enabled = !isBusy,
            ) {
                Text(
                    text =
                        if (isBusy) {
                            stringResource(R.string.git_init_initializing)
                        } else {
                            stringResource(R.string.git_init_initialize)
                        },
                )
            }
        },
        dismissButton = {
            TextButton(
                onClick = {
                    if (!isBusy) onDismiss()
                },
                enabled = !isBusy,
            ) {
                Text(stringResource(android.R.string.cancel))
            }
        },
    )
}

@Composable
internal fun SimpleMessageDialog(
    title: String,
    message: String,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(message) },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(android.R.string.ok))
            }
        },
    )
}

@Composable
internal fun GitSyncAlertDialog(
    alert: TurnGitSyncAlert,
    onAction: (TurnGitSyncAlertAction) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(alert.title) },
        text = { Text(alert.message) },
        confirmButton = {
            Column {
                alert.buttons
                    .filter { it.role != TurnGitSyncAlertButtonRole.cancel }
                    .forEach { button ->
                        TextButton(onClick = { onAction(button.action) }) {
                            Text(
                                text = button.title,
                                color =
                                    if (button.role == TurnGitSyncAlertButtonRole.destructive) {
                                        MaterialTheme.colorScheme.error
                                    } else {
                                        MaterialTheme.colorScheme.primary
                                    },
                            )
                        }
                    }
                if (alert.buttons.none { it.role != TurnGitSyncAlertButtonRole.cancel }) {
                    TextButton(onClick = onDismiss) {
                        Text(stringResource(android.R.string.ok))
                    }
                }
            }
        },
        dismissButton = {
            val cancel = alert.buttons.firstOrNull { it.role == TurnGitSyncAlertButtonRole.cancel }
            if (cancel != null && alert.buttons.size > 1) {
                TextButton(onClick = onDismiss) {
                    Text(cancel.title)
                }
            }
        },
    )
}

@Composable
internal fun PendingApprovalDialog(
    request: PendingApprovalRequest,
    onResolve: (PendingApprovalDecision) -> Unit,
) {
    val supportsSession = PendingRequestPresentation.supportsAcceptForSession(request.method)

    AlertDialog(
        onDismissRequest = { onResolve(PendingApprovalDecision.Decline) },
        title = { Text(stringResource(R.string.approval_dialog_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val cmdLine =
                    request.command
                        ?.trim()
                        ?.takeIf { it.isNotEmpty() }
                        ?.let { c -> stringResource(R.string.approval_command_line, c) }
                val message =
                    PendingRequestPresentation.approvalMessageOrNull(
                        request.reason,
                        cmdLine,
                    )
                Text(
                    text = message ?: stringResource(R.string.approval_default_body),
                )
                Text(
                    text = stringResource(PendingRequestPresentation.approvalKindTitleRes(request.method)),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            if (supportsSession) {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    TextButton(
                        onClick = { onResolve(PendingApprovalDecision.Accept) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(stringResource(R.string.approval_approve))
                    }
                    TextButton(
                        onClick = { onResolve(PendingApprovalDecision.AcceptForSession) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(stringResource(R.string.approval_approve_for_session))
                    }
                    TextButton(
                        onClick = { onResolve(PendingApprovalDecision.Decline) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(stringResource(R.string.approval_decline))
                    }
                }
            } else {
                TextButton(onClick = { onResolve(PendingApprovalDecision.Accept) }) {
                    Text(stringResource(R.string.approval_approve))
                }
            }
        },
        dismissButton = {
            if (!supportsSession) {
                TextButton(onClick = { onResolve(PendingApprovalDecision.Decline) }) {
                    Text(stringResource(R.string.approval_decline))
                }
            }
        },
    )
}
