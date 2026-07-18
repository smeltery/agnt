package com.dotbrains.agnt.mobile.ui.turn.diff

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.data.TurnFileChangePresentation

/**
 * Independent dropdown per entry; diff is only the fragment for that file.
 */
@Composable
internal fun MultipleFileChanges(
    messageId: String,
    preview: TurnFileChangePresentation,
) {
    val colors = MaterialTheme.colorScheme
    val hideDetailsCd = stringResource(R.string.turn_timeline_hide_details)
    val showDetailsCd = stringResource(R.string.turn_timeline_show_details)
    var expandedSlots by remember(messageId) { mutableStateOf(emptySet<Int>()) }
    val rowChevronSize = 22.dp

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        preview.entries.forEachIndexed { index, entry ->
            key(entry.path, index) {
                val patchChunk = entry.patchChunkText?.takeIf { it.isNotBlank() }
                val combinedFencePatch = preview.rawPatchText?.takeIf { it.isNotBlank() }
                val expandable = patchChunk != null || combinedFencePatch != null
                val expanded = index in expandedSlots
                val accordionCd =
                    "${fileNameFromPath(entry.path)}, " +
                        if (expanded) hideDetailsCd else showDetailsCd

                Column(modifier = Modifier.fillMaxWidth()) {
                    Row(
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .padding(vertical = 2.dp)
                                .clip(MaterialTheme.shapes.small)
                                .then(
                                    if (expandable) {
                                        Modifier
                                            .semantics {
                                                contentDescription = accordionCd
                                                role = Role.Button
                                            }.clickable {
                                                expandedSlots =
                                                    if (expanded) {
                                                        expandedSlots - index
                                                    } else {
                                                        expandedSlots + index
                                                    }
                                            }
                                    } else {
                                        Modifier
                                    },
                                ),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        DotLeadAligned()
                        Spacer(Modifier.width(8.dp))
                        Column(
                            modifier = Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = fileNameFromPath(entry.path),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = colors.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f).padding(end = 8.dp),
                                )
                                FileChangeCountOrLabel(
                                    entry = entry,
                                    likelyHasDiff = preview.likelyHasDiff,
                                )
                            }
                            entry.label?.takeIf { it.isNotBlank() }?.let { label ->
                                Text(
                                    text = label,
                                    style =
                                        MaterialTheme.typography.bodySmall.copy(
                                            lineHeight = 18.sp,
                                        ),
                                    color = colors.onSurfaceVariant.copy(alpha = 0.72f),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        if (expandable) {
                            Icon(
                                imageVector = Icons.Rounded.ChevronRight,
                                contentDescription =
                                    if (expanded) {
                                        stringResource(R.string.turn_timeline_hide_details)
                                    } else {
                                        stringResource(R.string.turn_timeline_show_details)
                                    },
                                tint = colors.onSurfaceVariant.copy(alpha = 0.5f),
                                modifier =
                                    Modifier
                                        .padding(start = 6.dp)
                                        .size(rowChevronSize)
                                        .rotate(
                                            if (expanded) {
                                                ChevronExpandedDegrees
                                            } else {
                                                ChevronCollapsedDegrees
                                            },
                                        ),
                            )
                        }
                    }

                    if (expanded) {
                        Spacer(Modifier.height(6.dp))
                        when {
                            patchChunk != null -> FileChangeHighlightedPatch(patchText = patchChunk)
                            combinedFencePatch != null -> {
                                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text(
                                        text = stringResource(R.string.turn_timeline_file_change_full_patch_fallback),
                                        style =
                                            MaterialTheme.typography.bodySmall.copy(
                                                lineHeight = 18.sp,
                                            ),
                                        color = colors.onSurfaceVariant.copy(alpha = 0.75f),
                                    )
                                    FileChangeHighlightedPatch(patchText = combinedFencePatch)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
