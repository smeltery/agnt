package com.dotbrains.agnt.mobile.ui.turn.toolbar

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import com.dotbrains.agnt.mobile.core.model.CodexPlanStep
import com.dotbrains.agnt.mobile.core.model.CodexPlanStepStatus
import com.dotbrains.agnt.mobile.ui.theme.isAgentLightChrome

private const val PLAN_ACCESSORY_MAX_VISIBLE_STEPS = 4

/**
 * J13 polish: compact active-plan card pinned above composer with status, progress rail, and inline details toggle.
 */
@Composable
internal fun TurnPlanAccessoryCard(
    message: CodexMessage,
    expanded: Boolean = false,
    onToggleExpanded: (() -> Unit)? = null,
    canApplyPlan: Boolean = false,
    onApplyPlan: (() -> Unit)? = null,
    onOpenDetailsSheet: (() -> Unit)? = null,
    floating: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val snapshot = PlanAccessorySnapshot.fromMessage(message)
    val lightChrome = isAgentLightChrome()
    val statusTint =
        if (lightChrome) {
            when (snapshot.status) {
                PlanAccessoryStatus.Pending -> Color(0xFFD09A1E)
                PlanAccessoryStatus.InProgress -> Color(0xFFB88412)
                PlanAccessoryStatus.Completed -> Color(0xFF2E8F5B)
            }
        } else {
            when (snapshot.status) {
                PlanAccessoryStatus.Pending -> MaterialTheme.colorScheme.tertiary
                PlanAccessoryStatus.InProgress -> MaterialTheme.colorScheme.primary
                PlanAccessoryStatus.Completed -> MaterialTheme.colorScheme.secondary
            }
        }
    val planColor =
        if (lightChrome) {
            MaterialTheme.colorScheme.surface.copy(alpha = 0.94f)
        } else {
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.72f)
        }
    val contentTint = MaterialTheme.colorScheme.onSurface
    val secondaryContentTint = contentTint.copy(alpha = 0.72f)

    val cardTap = onOpenDetailsSheet ?: onToggleExpanded
    Surface(
        modifier =
            modifier
                .fillMaxWidth()
                .then(
                    if (cardTap != null) {
                        Modifier.clickable(onClick = cardTap)
                    } else {
                        Modifier
                    },
                ),
        shape = RoundedCornerShape(20.dp),
        color = planColor,
        contentColor = contentTint,
        border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline.copy(alpha = if (lightChrome) 0.34f else 0.18f)),
        shadowElevation = if (floating) 12.dp else 0.dp,
        tonalElevation = if (floating) 4.dp else 1.dp,
    ) {
        val bodyModifier =
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 11.dp)
                .then(
                    if (expanded) {
                        Modifier
                            .heightIn(max = 430.dp)
                            .verticalScroll(rememberScrollState())
                    } else {
                        Modifier
                    },
                )
        Column(
            modifier = bodyModifier,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier.size(22.dp),
                    contentAlignment = androidx.compose.ui.Alignment.Center,
                ) {
                    Surface(
                        shape = CircleShape,
                        color = statusTint.copy(alpha = 0.12f),
                        modifier = Modifier.size(22.dp),
                    ) {}
                    Surface(
                        shape = CircleShape,
                        color = statusTint,
                        modifier = Modifier.size(7.dp),
                    ) {}
                }
                Text(
                    text = stringResource(R.string.turn_timeline_kind_plan),
                    style = MaterialTheme.typography.labelMedium,
                    color = secondaryContentTint,
                )
                Text(
                    text = "·",
                    style = MaterialTheme.typography.bodySmall,
                    color = secondaryContentTint,
                )
                Text(
                    text =
                        when (snapshot.status) {
                            PlanAccessoryStatus.Pending -> stringResource(R.string.turn_plan_status_pending)
                            PlanAccessoryStatus.InProgress -> stringResource(R.string.turn_plan_status_in_progress)
                            PlanAccessoryStatus.Completed -> stringResource(R.string.turn_plan_status_completed)
                        },
                    style = MaterialTheme.typography.labelSmall,
                    color = statusTint,
                )
                if (snapshot.stepStatuses.isNotEmpty()) {
                    StepStatusRail(
                        statuses = snapshot.stepStatuses,
                        accent = statusTint,
                        completedTint = contentTint,
                    )
                }
                if (message.isStreaming) {
                    Text(
                        text = stringResource(R.string.turn_plan_status_streaming),
                        style = MaterialTheme.typography.labelSmall,
                        color = contentTint.copy(alpha = 0.82f),
                    )
                }
                Spacer(modifier = Modifier.weight(1f))
                snapshot.progressText?.let { progress ->
                    Text(
                        text = progress,
                        style = MaterialTheme.typography.labelMedium,
                        color = contentTint,
                    )
                }
                if (expanded && onToggleExpanded != null) {
                    FilterChip(
                        selected = expanded,
                        onClick = onToggleExpanded,
                        label = {
                            Text(
                                text =
                                    if (expanded) {
                                        stringResource(R.string.turn_plan_hide_details)
                                    } else {
                                        stringResource(R.string.turn_plan_show_details)
                                    },
                                style = MaterialTheme.typography.labelSmall,
                            )
                        },
                    )
                }
                if (expanded && onApplyPlan != null) {
                    FilterChip(
                        selected = false,
                        onClick = onApplyPlan,
                        enabled = canApplyPlan,
                        label = {
                            Text(
                                text = stringResource(R.string.turn_plan_apply_action),
                                style = MaterialTheme.typography.labelSmall,
                            )
                        },
                    )
                }
                if (expanded && onOpenDetailsSheet != null) {
                    FilterChip(
                        selected = false,
                        onClick = onOpenDetailsSheet,
                        label = {
                            Text(
                                text = stringResource(R.string.turn_plan_open_sheet),
                                style = MaterialTheme.typography.labelSmall,
                            )
                        },
                    )
                }
            }

            Text(
                text = snapshot.summary,
                style = MaterialTheme.typography.bodyMedium,
                color = contentTint,
                maxLines = if (expanded) 4 else 1,
            )

            if (expanded) {
                snapshot.steps.take(PLAN_ACCESSORY_MAX_VISIBLE_STEPS).forEachIndexed { index, step ->
                    val statusLabel =
                        when (step.status) {
                            CodexPlanStepStatus.inProgress -> stringResource(R.string.turn_plan_step_doing)
                            CodexPlanStepStatus.pending -> stringResource(R.string.turn_plan_step_todo)
                            CodexPlanStepStatus.completed -> stringResource(R.string.turn_plan_step_done)
                        }
                    Text(
                        text = "${index + 1}. [$statusLabel] ${step.step}",
                        style = MaterialTheme.typography.bodySmall,
                        color = contentTint.copy(alpha = 0.95f),
                    )
                }
                val hiddenStepCount = snapshot.steps.size - PLAN_ACCESSORY_MAX_VISIBLE_STEPS
                if (hiddenStepCount > 0) {
                    Text(
                        text = stringResource(R.string.turn_plan_more_steps, hiddenStepCount),
                        style = MaterialTheme.typography.labelSmall,
                        color = secondaryContentTint,
                    )
                }
            }
        }
    }
}

@Composable
private fun StepStatusRail(
    statuses: List<CodexPlanStepStatus>,
    accent: Color,
    completedTint: Color,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        statuses.forEach { status ->
            val tint =
                when (status) {
                    CodexPlanStepStatus.pending -> MaterialTheme.colorScheme.outline.copy(alpha = 0.4f)
                    CodexPlanStepStatus.inProgress -> accent.copy(alpha = 0.8f)
                    CodexPlanStepStatus.completed -> completedTint.copy(alpha = 0.75f)
                }
            Surface(
                color = tint,
                shape = RoundedCornerShape(100),
                modifier = Modifier.size(width = 12.dp, height = 3.dp),
            ) {}
        }
    }
}

internal enum class PlanAccessoryStatus {
    Pending,
    InProgress,
    Completed,
}

internal data class PlanAccessorySnapshot(
    val summary: String,
    val status: PlanAccessoryStatus,
    val completedStepCount: Int,
    val totalStepCount: Int,
    val stepStatuses: List<CodexPlanStepStatus>,
    val steps: List<CodexPlanStep>,
) {
    val progressText: String?
        get() = if (totalStepCount > 0) "$completedStepCount/$totalStepCount" else null

    companion object {
        fun fromMessage(message: CodexMessage): PlanAccessorySnapshot {
            val steps = message.planState?.steps.orEmpty()
            val completed = steps.count { it.status == CodexPlanStepStatus.completed }
            return PlanAccessorySnapshot(
                summary = resolveSummary(message, steps),
                status = resolveStatus(steps, completed),
                completedStepCount = completed,
                totalStepCount = steps.size,
                stepStatuses = steps.map { it.status },
                steps = steps,
            )
        }

        private fun resolveStatus(
            steps: List<CodexPlanStep>,
            completedStepCount: Int,
        ): PlanAccessoryStatus {
            if (steps.any { it.status == CodexPlanStepStatus.inProgress }) return PlanAccessoryStatus.InProgress
            if (steps.isNotEmpty() && completedStepCount == steps.size) return PlanAccessoryStatus.Completed
            return PlanAccessoryStatus.Pending
        }

        private fun resolveSummary(
            message: CodexMessage,
            steps: List<CodexPlanStep>,
        ): String {
            steps.firstOrNull { it.status == CodexPlanStepStatus.inProgress }?.let { return it.step }
            steps.firstOrNull { it.status == CodexPlanStepStatus.pending }?.let { return it.step }
            steps.lastOrNull()?.let { return it.step }
            val explanation =
                message.planState
                    ?.explanation
                    ?.trim()
                    .orEmpty()
            if (explanation.isNotEmpty()) return explanation
            return message.text.trim().takeIf { it.isNotEmpty() } ?: "Open plan details"
        }
    }
}

internal fun selectPinnedPlanAccessoryMessage(messages: List<CodexMessage>): CodexMessage? =
    messages
        .asReversed()
        .firstOrNull { it.shouldDisplayPinnedPlanAccessory() }

internal fun selectCompletedPlanAccessoryMessage(messages: List<CodexMessage>): CodexMessage? =
    messages
        .asReversed()
        .firstOrNull { it.shouldDisplayCompletedPlanAccessory() }

internal fun CodexMessage.shouldDisplayPinnedPlanAccessory(): Boolean {
    if (role != CodexMessageRole.system || kind != CodexMessageKind.plan) return false
    if (isStreaming) return true
    val steps = planState?.steps.orEmpty()
    if (steps.isEmpty()) return false
    return steps.any { it.status != CodexPlanStepStatus.completed }
}

internal fun CodexMessage.shouldDisplayCompletedPlanAccessory(): Boolean {
    if (role != CodexMessageRole.system || kind != CodexMessageKind.plan || isStreaming) return false
    val steps = planState?.steps.orEmpty()
    return steps.isNotEmpty() && steps.all { it.status == CodexPlanStepStatus.completed }
}
