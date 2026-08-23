package com.smeltery.agnt.mobile.ui.turn.toolbar

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.CodexThreadGoal
import com.smeltery.agnt.mobile.core.model.CodexThreadGoalBudgetUpdate
import com.smeltery.agnt.mobile.core.model.CodexThreadGoalStatus

@Composable
internal fun ThreadGoalControl(
    goal: CodexThreadGoal?,
    enabled: Boolean,
    busy: Boolean,
    errorMessage: String?,
    onSetGoal: (objective: String?, status: CodexThreadGoalStatus?, budget: CodexThreadGoalBudgetUpdate) -> Unit,
    onClearGoal: () -> Unit,
    onDismissError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var showEditor by remember(goal?.threadId, goal?.objective) { mutableStateOf(false) }
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ThreadGoalChip(
            goal = goal,
            enabled = enabled && !busy,
            onClick = { showEditor = true },
            modifier = Modifier.weight(1f, fill = false),
        )
        if (goal != null) {
            val paused = goal.status == CodexThreadGoalStatus.Paused
            TextButton(
                onClick = {
                    onSetGoal(
                        null,
                        if (paused) CodexThreadGoalStatus.Active else CodexThreadGoalStatus.Paused,
                        CodexThreadGoalBudgetUpdate.Keep,
                    )
                },
                enabled = enabled && !busy,
            ) {
                Text(stringResource(if (paused) R.string.thread_goal_resume else R.string.thread_goal_pause))
            }
        }
    }
    if (showEditor) {
        ThreadGoalEditorDialog(
            goal = goal,
            busy = busy,
            onDismiss = { showEditor = false },
            onSave = { objective, budget ->
                onSetGoal(objective, if (goal?.status == CodexThreadGoalStatus.Paused) CodexThreadGoalStatus.Active else null, budget)
                showEditor = false
            },
            onClear = {
                onClearGoal()
                showEditor = false
            },
        )
    }
    if (errorMessage != null) {
        AlertDialog(
            onDismissRequest = onDismissError,
            confirmButton = {
                TextButton(onClick = onDismissError) {
                    Text(stringResource(R.string.generic_ok))
                }
            },
            title = { Text(stringResource(R.string.thread_goal_error_title)) },
            text = { Text(errorMessage) },
        )
    }
}

@Composable
private fun ThreadGoalChip(
    goal: CodexThreadGoal?,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val attention =
        goal?.status == CodexThreadGoalStatus.Blocked ||
            goal?.status == CodexThreadGoalStatus.Failed ||
            goal?.status == CodexThreadGoalStatus.UsageLimited ||
            goal?.status == CodexThreadGoalStatus.BudgetLimited
    val background =
        when {
            goal == null -> colors.surfaceVariant.copy(alpha = 0.62f)
            attention -> colors.errorContainer
            goal.status == CodexThreadGoalStatus.Paused -> colors.secondaryContainer
            else -> colors.primaryContainer
        }
    val foreground =
        when {
            goal == null -> colors.onSurfaceVariant
            attention -> colors.onErrorContainer
            goal.status == CodexThreadGoalStatus.Paused -> colors.onSecondaryContainer
            else -> colors.onPrimaryContainer
        }
    val label = if (goal != null) goalLabel(goal) else stringResource(R.string.thread_goal_set)
    Row(
        modifier =
            modifier
                .clip(RoundedCornerShape(999.dp))
                .background(background)
                .clickable(enabled = enabled, onClick = onClick)
                .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spacer(
            modifier =
                Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(foreground),
        )
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = foreground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ThreadGoalEditorDialog(
    goal: CodexThreadGoal?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (String?, CodexThreadGoalBudgetUpdate) -> Unit,
    onClear: () -> Unit,
) {
    var objective by remember(goal?.objective) { mutableStateOf(goal?.objective.orEmpty()) }
    var budget by remember(goal?.tokenBudget) { mutableStateOf(goal?.tokenBudget?.toString().orEmpty()) }
    val trimmedObjective = objective.trim()
    val budgetUpdate =
        remember(budget) {
            val normalized = budget.trim()
            when {
                normalized.isEmpty() -> CodexThreadGoalBudgetUpdate.Keep
                normalized == "-" -> CodexThreadGoalBudgetUpdate.Clear
                else ->
                    normalized
                        .replace(",", "")
                        .toLongOrNull()
                        ?.takeIf { it > 0 }
                        ?.let(CodexThreadGoalBudgetUpdate::Set)
            }
        }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (goal == null) R.string.thread_goal_new_title else R.string.thread_goal_edit_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = objective,
                    onValueChange = { objective = it },
                    label = { Text(stringResource(R.string.thread_goal_objective)) },
                    minLines = 2,
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = budget,
                    onValueChange = { budget = it },
                    label = { Text(stringResource(R.string.thread_goal_token_budget)) },
                    supportingText = { Text(stringResource(R.string.thread_goal_token_budget_hint)) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(
                onClick = { onSave(trimmedObjective.takeIf { it.isNotEmpty() }, budgetUpdate ?: CodexThreadGoalBudgetUpdate.Keep) },
                enabled = !busy && (goal != null || trimmedObjective.isNotEmpty()) && budgetUpdate != null,
            ) {
                Text(stringResource(if (goal == null) R.string.thread_goal_start else R.string.thread_goal_save))
            }
        },
        dismissButton = {
            Row {
                if (goal != null) {
                    OutlinedButton(onClick = onClear, enabled = !busy) {
                        Text(stringResource(R.string.thread_goal_clear))
                    }
                    Spacer(Modifier.width(8.dp))
                }
                FilledTonalButton(onClick = onDismiss, enabled = !busy) {
                    Text(stringResource(R.string.generic_cancel))
                }
            }
        },
    )
}

@Composable
private fun goalLabel(goal: CodexThreadGoal): String {
    val status =
        when (goal.status) {
            CodexThreadGoalStatus.Active -> stringResource(R.string.thread_goal_status_active)
            CodexThreadGoalStatus.Paused -> stringResource(R.string.thread_goal_status_paused)
            CodexThreadGoalStatus.Completed -> stringResource(R.string.thread_goal_status_completed)
            CodexThreadGoalStatus.Failed -> stringResource(R.string.thread_goal_status_failed)
            CodexThreadGoalStatus.Blocked -> stringResource(R.string.thread_goal_status_blocked)
            CodexThreadGoalStatus.UsageLimited -> stringResource(R.string.thread_goal_status_usage_limited)
            CodexThreadGoalStatus.BudgetLimited -> stringResource(R.string.thread_goal_status_budget_limited)
        }
    val remaining = CodexThreadGoal.remainingBudget(goal)
    return if (remaining != null) "$status · ${CodexThreadGoal.formatTokenCount(remaining)} left" else status
}
