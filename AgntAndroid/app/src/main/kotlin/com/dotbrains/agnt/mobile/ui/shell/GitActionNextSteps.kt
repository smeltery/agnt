package com.dotbrains.agnt.mobile.ui.shell

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun GitActionNextSteps(
    mode: GitActionSheetMode,
    selected: GitActionNextStep,
    enabled: Boolean,
    onSelected: (GitActionNextStep) -> Unit,
) {
    val steps = nextStepsFor(mode)
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        steps.forEachIndexed { index, step ->
            GitActionNextStepRow(
                title = nextStepTitle(step),
                detail = nextStepDetail(step),
                selected = selected == step,
                enabled = enabled,
                onClick = { onSelected(step) },
            )
            if (index != steps.lastIndex) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    }
}

@Composable
private fun GitActionNextStepRow(
    title: String,
    detail: String?,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .clickable(enabled = enabled, onClick = onClick)
                .padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick, enabled = enabled)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (detail != null) {
                Text(
                    text = detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

internal fun nextStepsFor(mode: GitActionSheetMode): List<GitActionNextStep> =
    when (mode) {
        GitActionSheetMode.commit ->
            listOf(
                GitActionNextStep.commit,
                GitActionNextStep.commitAndPush,
                GitActionNextStep.commitPushAndPullRequest,
            )
        GitActionSheetMode.push ->
            listOf(
                GitActionNextStep.push,
                GitActionNextStep.pushAndPullRequest,
            )
        GitActionSheetMode.createPullRequest ->
            listOf(GitActionNextStep.createPullRequest)
    }

private fun nextStepTitle(step: GitActionNextStep): String =
    when (step) {
        GitActionNextStep.commit -> "Commit"
        GitActionNextStep.commitAndPush -> "Commit and push"
        GitActionNextStep.commitPushAndPullRequest -> "Commit, push and create PR"
        GitActionNextStep.push -> "Push"
        GitActionNextStep.pushAndPullRequest -> "Push and create PR"
        GitActionNextStep.createPullRequest -> "Create PR"
    }

private fun nextStepDetail(step: GitActionNextStep): String? =
    when (step) {
        GitActionNextStep.commitPushAndPullRequest,
        GitActionNextStep.pushAndPullRequest,
        GitActionNextStep.createPullRequest,
        -> "Opens GitHub with generated title and body if fields are empty."
        else -> null
    }

internal val GitActionNextStep.usesPushRemote: Boolean
    get() =
        when (this) {
            GitActionNextStep.commitAndPush,
            GitActionNextStep.push,
            -> true
            GitActionNextStep.commit,
            GitActionNextStep.commitPushAndPullRequest,
            GitActionNextStep.pushAndPullRequest,
            GitActionNextStep.createPullRequest,
            -> false
        }

internal fun canSubmit(
    mode: GitActionSheetMode,
    step: GitActionNextStep,
    baseBranch: String,
): Boolean =
    when (mode) {
        GitActionSheetMode.commit ->
            step != GitActionNextStep.commitPushAndPullRequest || baseBranch.isNotBlank()
        GitActionSheetMode.push ->
            step != GitActionNextStep.pushAndPullRequest || baseBranch.isNotBlank()
        GitActionSheetMode.createPullRequest -> baseBranch.isNotBlank()
    }
