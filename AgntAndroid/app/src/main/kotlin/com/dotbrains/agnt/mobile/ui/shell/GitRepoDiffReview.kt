package com.dotbrains.agnt.mobile.ui.shell

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.AIUnifiedPatchParser
import com.dotbrains.agnt.mobile.core.model.GitRepoSyncResult
import com.dotbrains.agnt.mobile.ui.agent.truncatePathMiddle
import com.composables.icons.lucide.R as LucideR

@Composable
internal fun GitRepoDiffExpandableFile(
    rowKey: String,
    path: String,
    chunk: String,
    gitStatus: GitRepoSyncResult?,
    edits: SnapshotStateMap<String, TextFieldValue>,
    expandForMarkdownFocus: Boolean = false,
) {
    var expanded by remember(rowKey) { mutableStateOf(false) }
    LaunchedEffect(expandForMarkdownFocus) {
        if (expandForMarkdownFocus) expanded = true
    }
    /** When [chunkLooksLikeUnifiedDiff], Preview shows [GitPatchHighlightedBlock]; Edit is a plain text patch editor. */
    var diffPatchEditMode by remember(rowKey) { mutableStateOf(false) }
    val patchBodyForStats = edits[rowKey]?.text ?: chunk
    val (adds, dels) =
        remember(patchBodyForStats) {
            AIUnifiedPatchParser.additionsDeletionsForDisplay(patchBodyForStats)
        }
    val gitFile = remember(path, gitStatus) { findGitStatusForPatchPath(path, gitStatus?.files.orEmpty()) }
    val staging = gitFile?.let { GitPathStagingUi.fromPorcelain(it.status) }

    Surface(
        modifier =
            Modifier
                .fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.72f),
        border =
            androidx.compose.foundation.BorderStroke(
                0.5.dp,
                MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f),
            ),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 14.dp),
        ) {
            Row(
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .clickable { expanded = !expanded },
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
                Icon(
                    imageVector = if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurface,
                )
            }
            AnimatedVisibility(
                visible = expanded,
                enter = expandVertically(),
                exit = shrinkVertically(),
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    Spacer(Modifier.height(16.dp))
                    when {
                        chunkIsTimelinePlaceholderEcho(chunk) ->
                            Text(
                                text = stringResource(R.string.git_repo_diff_timeline_no_real_patch),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(8.dp),
                            )
                        chunkLooksLikeUnifiedDiff(chunk) ->
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    GitRepoDiffPatchModeButton(
                                        selected = !diffPatchEditMode,
                                        onClick = { diffPatchEditMode = false },
                                        iconRes = LucideR.drawable.lucide_ic_eye,
                                        label = stringResource(R.string.git_repo_diff_mode_preview),
                                        modifier = Modifier.weight(1f),
                                    )
                                    GitRepoDiffPatchModeButton(
                                        selected = diffPatchEditMode,
                                        onClick = { diffPatchEditMode = true },
                                        iconRes = LucideR.drawable.lucide_ic_square_pen,
                                        label = stringResource(R.string.git_repo_diff_mode_edit),
                                        modifier = Modifier.weight(1f),
                                    )
                                }
                                Spacer(Modifier.height(12.dp))
                                val patchText = edits[rowKey]?.text ?: chunk
                                if (!diffPatchEditMode) {
                                    GitPatchHighlightedBlock(
                                        patch = patchText,
                                        verticalScrollEnabled = false,
                                        modifier =
                                            Modifier
                                                .fillMaxWidth()
                                                .clip(RoundedCornerShape(14.dp))
                                                .border(
                                                    0.5.dp,
                                                    MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f),
                                                    RoundedCornerShape(14.dp),
                                                ).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.18f)),
                                    )
                                } else {
                                    val fieldValue =
                                        edits.getOrPut(rowKey) { TextFieldValue(chunk) }
                                    DiffPatchTextEditor(
                                        value = fieldValue,
                                        onValueChange = { edits[rowKey] = it },
                                        modifier =
                                            Modifier
                                                .fillMaxWidth()
                                                .heightIn(max = 360.dp)
                                                .clip(RoundedCornerShape(14.dp))
                                                .border(
                                                    0.5.dp,
                                                    MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f),
                                                    RoundedCornerShape(14.dp),
                                                ).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.18f)),
                                    )
                                }
                            }
                        else -> {
                            val initial = remember(rowKey, chunk) { TextFieldValue(chunk) }
                            val fieldValue = edits[rowKey] ?: initial
                            DiffPatchTextEditor(
                                value = fieldValue,
                                onValueChange = { edits[rowKey] = it },
                                modifier =
                                    Modifier
                                        .fillMaxWidth()
                                        .heightIn(max = 360.dp)
                                        .clip(RoundedCornerShape(14.dp))
                                        .border(
                                            0.5.dp,
                                            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f),
                                            RoundedCornerShape(14.dp),
                                        ).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.18f)),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GitRepoDiffPatchModeButton(
    selected: Boolean,
    onClick: () -> Unit,
    iconRes: Int,
    label: String,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    Surface(
        modifier = modifier.height(52.dp),
        shape = RoundedCornerShape(14.dp),
        color =
            if (selected) {
                colors.primaryContainer
            } else {
                colors.surface.copy(alpha = 0.18f)
            },
        contentColor =
            if (selected) {
                colors.onPrimaryContainer
            } else {
                colors.onSurface
            },
        border =
            androidx.compose.foundation.BorderStroke(
                0.5.dp,
                if (selected) colors.primary.copy(alpha = 0.24f) else colors.outlineVariant.copy(alpha = 0.36f),
            ),
        onClick = onClick,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                painter = painterResource(iconRes),
                contentDescription = null,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(9.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun DiffPatchTextEditor(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scrollState = rememberScrollState()
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        textStyle =
            TextStyle(
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurface,
                fontSize = MaterialTheme.typography.bodySmall.fontSize,
            ),
        modifier =
            modifier
                .verticalScroll(scrollState)
                .padding(8.dp),
    )
}

private fun chunkLooksLikeUnifiedDiff(chunk: String): Boolean {
    val t = chunk.trim().replace("\r\n", "\n")
    if (t.isEmpty()) return false
    if (chunkIsTimelinePlaceholderEcho(t)) return false
    return t.startsWith("diff --git ") ||
        t.lineSequence().any { it.startsWith("@@ ") } ||
        (t.contains("--- ") && t.contains("+++ "))
}

private fun chunkIsTimelinePlaceholderEcho(chunk: String): Boolean {
    val lines =
        chunk
            .lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .toList()
    return lines.isNotEmpty() && lines.all { it == "[file change]" }
}
