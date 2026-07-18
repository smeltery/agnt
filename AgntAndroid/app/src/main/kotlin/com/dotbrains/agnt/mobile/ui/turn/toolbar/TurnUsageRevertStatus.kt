package com.dotbrains.agnt.mobile.ui.turn.toolbar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.AIChangeSet
import com.dotbrains.agnt.mobile.core.model.AIChangeSetStatus
import com.dotbrains.agnt.mobile.core.model.AssistantRevertPrimaryBlockReason
import com.dotbrains.agnt.mobile.core.model.TurnUsageSheetLogic
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.services.agent.review.AiChangeSetRevertService
import kotlinx.coroutines.launch

@Composable
internal fun AssistantRevertStatusBlock(
    changeSets: List<AIChangeSet>,
    repository: CodexRepository,
    threadCwd: String?,
    onChangeSetsUpdated: () -> Unit,
    markChangeSetReverted: (changeSetId: String) -> Unit,
    recordChangeSetRevertError: (changeSetId: String, errorMessage: String) -> Unit,
) {
    Text(
        text = stringResource(R.string.turn_usage_revert_title),
        style = MaterialTheme.typography.titleSmall,
    )
    if (changeSets.isEmpty()) {
        Text(
            text = stringResource(R.string.turn_usage_revert_empty),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }

    val runtimeRevertRpcAvailable = true
    val revertService = remember(repository) { AiChangeSetRevertService(repository) }
    val scope = rememberCoroutineScope()
    var expandedIds by remember(changeSets) { mutableStateOf(emptySet<String>()) }
    var applyingIds by remember(changeSets) { mutableStateOf(emptySet<String>()) }
    var actionErrors by remember(changeSets) { mutableStateOf<Map<String, String>>(emptyMap()) }
    changeSets.take(6).forEach { changeSet ->
        val statusLabel =
            when (changeSet.status) {
                AIChangeSetStatus.collecting -> stringResource(R.string.turn_usage_revert_status_collecting)
                AIChangeSetStatus.ready -> stringResource(R.string.turn_usage_revert_status_ready)
                AIChangeSetStatus.reverted -> stringResource(R.string.turn_usage_revert_status_reverted)
                AIChangeSetStatus.failed -> stringResource(R.string.turn_usage_revert_status_failed)
                AIChangeSetStatus.notRevertable -> stringResource(R.string.turn_usage_revert_status_not_revertable)
            }
        val blockReason = TurnUsageSheetLogic.revertPrimaryBlockReason(changeSet, runtimeRevertRpcAvailable)
        val blockReasonMessage =
            when (blockReason) {
                AssistantRevertPrimaryBlockReason.RuntimeEndpointUnavailable ->
                    stringResource(R.string.turn_usage_revert_reason_runtime_unavailable)
                AssistantRevertPrimaryBlockReason.AlreadyReverted ->
                    stringResource(R.string.turn_usage_revert_reason_already_reverted)
                AssistantRevertPrimaryBlockReason.StatusNotReady ->
                    stringResource(R.string.turn_usage_revert_reason_not_ready)
                AssistantRevertPrimaryBlockReason.MissingInversePatch ->
                    stringResource(R.string.turn_usage_revert_reason_missing_inverse)
                AssistantRevertPrimaryBlockReason.NotRevertableStatus ->
                    stringResource(R.string.turn_usage_revert_reason_not_revertable)
                AssistantRevertPrimaryBlockReason.ChangeSetFailed ->
                    stringResource(R.string.turn_usage_revert_reason_failed)
                null -> null
            }
        val isExpanded = changeSet.id in expandedIds
        val isApplying = changeSet.id in applyingIds
        val actionError = actionErrors[changeSet.id]
        val workingDirectory = changeSet.repoRoot ?: threadCwd
        val blockReasonOverride =
            when {
                workingDirectory.isNullOrBlank() ->
                    stringResource(R.string.turn_usage_revert_reason_missing_cwd)
                else -> null
            }

        Surface(
            modifier = Modifier.fillMaxWidth(),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
            shape = MaterialTheme.shapes.small,
        ) {
            Column(
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = stringResource(R.string.turn_usage_revert_item_title, changeSet.turnId.takeLast(8)),
                        style = MaterialTheme.typography.labelLarge,
                    )
                    Spacer(modifier = Modifier.weight(1f))
                    Text(
                        text = statusLabel,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    text =
                        stringResource(
                            R.string.turn_usage_revert_item_metrics,
                            changeSet.fileChanges.size,
                            changeSet.fileChanges.sumOf { it.additions },
                            changeSet.fileChanges.sumOf { it.deletions },
                        ),
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(
                        onClick = {
                            expandedIds =
                                if (isExpanded) {
                                    expandedIds - changeSet.id
                                } else {
                                    expandedIds + changeSet.id
                                }
                        },
                    ) {
                        Text(
                            if (isExpanded) {
                                stringResource(R.string.turn_usage_revert_hide_details)
                            } else {
                                stringResource(R.string.turn_usage_revert_show_details)
                            },
                        )
                    }
                    Spacer(modifier = Modifier.weight(1f))
                    TextButton(
                        onClick = {
                            if (workingDirectory.isNullOrBlank() || isApplying) return@TextButton
                            scope.launch {
                                applyingIds = applyingIds + changeSet.id
                                actionErrors = actionErrors - changeSet.id
                                val result =
                                    runCatching {
                                        revertService.apply(changeSet = changeSet, workingDirectory = workingDirectory)
                                    }
                                result
                                    .onSuccess { applyResult ->
                                        if (applyResult.success) {
                                            markChangeSetReverted(changeSet.id)
                                        } else {
                                            val message =
                                                applyResult.unsupportedReasons.firstOrNull()
                                                    ?: applyResult.conflicts.firstOrNull()?.message
                                                    ?: "Patch revert failed."
                                            recordChangeSetRevertError(changeSet.id, message)
                                            actionErrors = actionErrors + (changeSet.id to message)
                                        }
                                        onChangeSetsUpdated()
                                    }.onFailure { error ->
                                        val message = error.message ?: "Patch revert failed."
                                        recordChangeSetRevertError(changeSet.id, message)
                                        actionErrors = actionErrors + (changeSet.id to message)
                                        onChangeSetsUpdated()
                                    }
                                applyingIds = applyingIds - changeSet.id
                            }
                        },
                        enabled =
                            !isApplying &&
                                !workingDirectory.isNullOrBlank() &&
                                TurnUsageSheetLogic.revertPrimaryEnabled(changeSet, runtimeRevertRpcAvailable),
                    ) {
                        Text(stringResource(R.string.turn_usage_revert_action))
                    }
                }
                if (blockReasonOverride != null || blockReasonMessage != null) {
                    Text(
                        text = blockReasonOverride ?: blockReasonMessage.orEmpty(),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (actionError != null) {
                    Text(
                        text = actionError,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (isExpanded) {
                    changeSet.unsupportedReasons.take(3).forEach { reason ->
                        Text(
                            text = "- $reason",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    changeSet.fileChanges.take(5).forEach { fileChange ->
                        Text(
                            text =
                                stringResource(
                                    R.string.turn_usage_revert_item_file_line,
                                    fileChange.path,
                                    fileChange.additions,
                                    fileChange.deletions,
                                ),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
        }
    }
    if (changeSets.size > 6) {
        Text(
            text = stringResource(R.string.turn_usage_revert_more, changeSets.size - 6),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
