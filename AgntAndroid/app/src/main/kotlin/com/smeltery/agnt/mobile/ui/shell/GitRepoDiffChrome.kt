package com.smeltery.agnt.mobile.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.AIUnifiedPatchParser
import com.smeltery.agnt.mobile.core.model.GitRepoSyncResult
import com.smeltery.agnt.mobile.ui.agent.truncatePathMiddle
import com.smeltery.agnt.mobile.ui.theme.AgntGitAddition
import com.composables.icons.lucide.R as LucideR

@Composable
internal fun GitRepoDiffSegmentedTabs(
    selectedTab: GitRepoDiffUiTab,
    onSelected: (GitRepoDiffUiTab) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .border(0.5.dp, colors.outlineVariant.copy(alpha = 0.42f), RoundedCornerShape(14.dp))
                .background(colors.surfaceVariant.copy(alpha = 0.28f))
                .padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        GitRepoDiffUiTab.entries.forEach { tab ->
            val selected = tab == selectedTab
            Box(
                modifier =
                    Modifier
                        .weight(1f)
                        .height(48.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(
                            if (selected) {
                                colors.primaryContainer.copy(alpha = 0.42f)
                            } else {
                                colors.surface.copy(alpha = 0.02f)
                            },
                        ).clickable { onSelected(tab) },
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = stringResource(tab.stringRes),
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                        color =
                            if (selected) {
                                colors.onSurface
                            } else {
                                colors.onSurfaceVariant
                            },
                    )
                    Spacer(Modifier.height(5.dp))
                    Box(
                        modifier =
                            Modifier
                                .width(72.dp)
                                .height(3.dp)
                                .clip(RoundedCornerShape(2.dp))
                                .background(
                                    if (selected) {
                                        colors.primary
                                    } else {
                                        colors.primary.copy(alpha = 0f)
                                    },
                                ),
                    )
                }
            }
        }
    }
}

@Composable
internal fun GitRepoDiffScopePill(
    selected: Boolean,
    onClick: () -> Unit,
    iconRes: Int,
    label: String,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    Surface(
        modifier = modifier.height(48.dp),
        shape = RoundedCornerShape(18.dp),
        color =
            if (selected) {
                colors.primaryContainer
            } else {
                colors.surface
            },
        contentColor =
            if (selected) {
                colors.onPrimaryContainer
            } else {
                colors.onSurfaceVariant
            },
        border =
            androidx.compose.foundation.BorderStroke(
                0.5.dp,
                if (selected) colors.primary.copy(alpha = 0.24f) else colors.outlineVariant.copy(alpha = 0.36f),
            ),
        onClick = onClick,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                painter = painterResource(iconRes),
                contentDescription = null,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = label,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                maxLines = 1,
            )
        }
    }
}

@Composable
internal fun GitRepoDiffMessage(
    text: String,
    modifier: Modifier = Modifier,
    isError: Boolean = false,
) {
    Box(
        modifier = modifier.fillMaxWidth(),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color =
                if (isError) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
        )
    }
}

@Composable
internal fun GitRepoDiffContent(
    uiTab: GitRepoDiffUiTab,
    rows: List<GitRepoDiffRenderableRow>,
    gitStatus: GitRepoSyncResult?,
    edits: SnapshotStateMap<String, TextFieldValue>,
    reviewLazyListState: LazyListState,
    markdownExpandRowStableKey: String?,
    modifier: Modifier = Modifier,
) {
    when (uiTab) {
        GitRepoDiffUiTab.Summary ->
            LazyColumn(
                modifier = modifier,
                contentPadding = PaddingValues(vertical = 2.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(rows, key = { it.stableKey }) { row ->
                    GitRepoDiffSummaryRow(
                        path = row.displayPath,
                        chunk = row.chunk,
                        gitStatus = gitStatus,
                    )
                }
            }
        GitRepoDiffUiTab.Review ->
            LazyColumn(
                modifier = modifier,
                state = reviewLazyListState,
                contentPadding = PaddingValues(vertical = 2.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(rows, key = { it.stableKey }) { row ->
                    GitRepoDiffExpandableFile(
                        rowKey = row.stableKey,
                        path = row.displayPath,
                        chunk = row.chunk,
                        gitStatus = gitStatus,
                        edits = edits,
                        expandForMarkdownFocus =
                            markdownExpandRowStableKey != null &&
                                row.stableKey == markdownExpandRowStableKey,
                    )
                }
            }
    }
}

@Composable
private fun GitRepoDiffSummaryRow(
    path: String,
    chunk: String,
    gitStatus: GitRepoSyncResult?,
) {
    val (adds, dels) =
        androidx.compose.runtime.remember(chunk) { AIUnifiedPatchParser.additionsDeletionsForDisplay(chunk) }
    val gitFile = androidx.compose.runtime.remember(path, gitStatus) { findGitStatusForPatchPath(path, gitStatus?.files.orEmpty()) }
    val staging = gitFile?.let { GitPathStagingUi.fromPorcelain(it.status) }

    Surface(
        modifier =
            Modifier
                .fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.72f),
        border =
            androidx.compose.foundation.BorderStroke(
                0.5.dp,
                MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f),
            ),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            GitRepoDiffFileTile()
            Text(
                text = truncatePathMiddle(path, maxLen = 42),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            staging?.let { GitRepoDiffStagingBadge(staging = it) }
            GitRepoDiffStatBadge(text = "+$adds", positive = true)
            GitRepoDiffStatBadge(text = "-$dels", positive = false)
        }
    }
}

@Composable
internal fun GitRepoDiffStagingDot(staging: GitPathStagingUi) {
    val label =
        when {
            staging.isUntracked -> stringResource(R.string.git_repo_diff_staging_untracked)
            staging.staged && staging.unstaged -> stringResource(R.string.git_repo_diff_staging_mixed)
            staging.staged && !staging.unstaged -> stringResource(R.string.git_repo_diff_staging_staged_only)
            !staging.staged && staging.unstaged -> stringResource(R.string.git_repo_diff_staging_unstaged_only)
            else -> null
        }
    if (label != null) {
        Text(
            text = "· $label",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
internal fun GitRepoDiffFileTile() {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f),
    ) {
        Box(
            modifier = Modifier.size(44.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                painter = painterResource(LucideR.drawable.lucide_ic_file_diff),
                contentDescription = null,
                modifier = Modifier.size(22.dp),
                tint = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }
    }
}

@Composable
internal fun GitRepoDiffStatBadge(
    text: String,
    positive: Boolean,
) {
    Surface(
        shape = RoundedCornerShape(8.dp),
        color =
            if (positive) {
                AgntGitAddition.copy(alpha = 0.16f)
            } else {
                MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.62f)
            },
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
            color =
                if (positive) {
                    AgntGitAddition
                } else {
                    MaterialTheme.colorScheme.onErrorContainer
                },
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            maxLines = 1,
        )
    }
}

@Composable
internal fun GitRepoDiffStagingBadge(staging: GitPathStagingUi) {
    val label =
        when {
            staging.isUntracked -> stringResource(R.string.git_repo_diff_staging_untracked)
            staging.staged && staging.unstaged -> stringResource(R.string.git_repo_diff_staging_mixed)
            staging.staged && !staging.unstaged -> stringResource(R.string.git_repo_diff_staging_staged_only)
            !staging.staged && staging.unstaged -> stringResource(R.string.git_repo_diff_staging_unstaged_only)
            else -> null
        } ?: return
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.62f),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
            modifier = Modifier.padding(horizontal = 7.dp, vertical = 4.dp),
            maxLines = 1,
        )
    }
}
