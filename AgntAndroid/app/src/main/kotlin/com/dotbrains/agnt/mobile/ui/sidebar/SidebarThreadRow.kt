package com.dotbrains.agnt.mobile.ui.sidebar

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.CodexThreadSyncState
import com.dotbrains.agnt.mobile.ui.theme.AgentLightColors
import com.dotbrains.agnt.mobile.ui.theme.isAgentLightChrome
import com.dotbrains.agnt.mobile.ui.shared.WorktreeGlassBadge

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SidebarThreadRow(
    thread: CodexThread,
    selected: Boolean,
    isRunning: Boolean,
    onSelect: () -> Unit,
    onRenameRequest: (() -> Unit)? = null,
    onDeleteLocalRequest: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val lightChrome = isAgentLightChrome()
    val rowShape = RoundedCornerShape(14.dp)
    val selectedFill =
        if (lightChrome) {
            Color(0xFFEDEDED).copy(alpha = 0.82f)
        } else {
            colors.surfaceVariant.copy(alpha = 0.5f)
        }
    val selectedBorder =
        if (lightChrome) {
            colors.outline.copy(alpha = 0.28f)
        } else {
            Color.White.copy(alpha = 0.08f)
        }
    var menuExpanded by remember(thread.id) { mutableStateOf(false) }
    Row(
        modifier =
            modifier
                .fillMaxWidth()
                .clip(rowShape)
                .background(
                    color =
                        if (selected) {
                            selectedFill
                        } else {
                            Color.Transparent
                        },
                )
                .then(
                    if (selected) {
                        Modifier.border(0.5.dp, selectedBorder, rowShape)
                    } else {
                        Modifier
                    },
                )
                .combinedClickable(
                    onClick = onSelect,
                    onLongClick = { onRenameRequest?.invoke() },
                )
                .padding(horizontal = 12.dp, vertical = if (thread.isSubagent) 6.dp else 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier.size(width = 12.dp, height = 20.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (isRunning) {
                CircularProgressIndicator(
                    modifier = Modifier.size(10.dp),
                    strokeWidth = 1.5.dp,
                    color = colors.onSurface,
                    trackColor = colors.onSurface.copy(alpha = 0.14f),
                )
            } else if (selected) {
                Box(
                    modifier =
                        Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(colors.onSurface.copy(alpha = 0.72f)),
                )
            }
        }
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = thread.displayTitle,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = colors.onSurface,
            )
            val archivedNote =
                if (thread.syncState == CodexThreadSyncState.archivedLocal) {
                    stringResource(R.string.sidebar_thread_archived_hint)
                } else {
                    null
                }
            if (archivedNote != null) {
                Text(
                    text = archivedNote,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.onSurfaceVariant.copy(alpha = 0.72f),
                    maxLines = 1,
                )
            }
            if (thread.isManagedWorktreeProject) {
                WorktreeGlassBadge(modifier = Modifier.padding(top = 4.dp))
            }
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val rel = SidebarRelativeTimeFormatter.compactLabel(thread)
            if (rel != null) {
                Text(
                    text = rel,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.onSurfaceVariant.copy(alpha = 0.82f),
                    maxLines = 1,
                )
            }
            if (onRenameRequest != null || onDeleteLocalRequest != null) {
                Box {
                    IconButton(
                        onClick = { menuExpanded = true },
                        modifier = Modifier.size(28.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.MoreVert,
                            contentDescription = stringResource(R.string.sidebar_thread_actions_cd),
                            tint = if (lightChrome) AgentLightColors.IconMuted else colors.onSurfaceVariant,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    DropdownMenu(
                        expanded = menuExpanded,
                        onDismissRequest = { menuExpanded = false },
                    ) {
                        if (onRenameRequest != null) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.sidebar_thread_rename)) },
                                leadingIcon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                                onClick = {
                                    menuExpanded = false
                                    onRenameRequest()
                                },
                            )
                        }
                        if (onDeleteLocalRequest != null) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.sidebar_thread_delete_local)) },
                                leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null) },
                                onClick = {
                                    menuExpanded = false
                                    onDeleteLocalRequest()
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}
