package com.smeltery.agnt.mobile.ui.sidebar

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.ui.theme.AgntDropdownMenu
import com.composables.icons.lucide.R as LucideR

@Composable
fun SidebarTopActionsRow(
    enabled: Boolean,
    pendingAction: SidebarTopAction?,
    onNewChat: () -> Unit,
    onQuickChat: () -> Unit,
    onNewProject: () -> Unit,
) {
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(30.dp),
        verticalAlignment = Alignment.Top,
    ) {
        SidebarTopActionButton(
            action = SidebarTopAction.NewChat,
            label = stringResource(R.string.sidebar_new_chat),
            iconRes = LucideR.drawable.lucide_ic_square_pen,
            enabled = enabled,
            pendingAction = pendingAction,
            onClick = onNewChat,
        )
        SidebarTopActionButton(
            action = SidebarTopAction.QuickChat,
            label = stringResource(R.string.sidebar_quick_chat),
            iconRes = LucideR.drawable.lucide_ic_message_square,
            enabled = enabled,
            pendingAction = pendingAction,
            onClick = onQuickChat,
        )
        SidebarTopActionButton(
            action = SidebarTopAction.NewProject,
            label = stringResource(R.string.sidebar_new_project),
            iconRes = LucideR.drawable.lucide_ic_folder_plus,
            enabled = enabled,
            pendingAction = pendingAction,
            onClick = onNewProject,
        )
    }
}

@Composable
fun SidebarTopActionButton(
    action: SidebarTopAction,
    label: String,
    iconRes: Int,
    enabled: Boolean,
    pendingAction: SidebarTopAction?,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val isBusy = pendingAction == action
    val canClick = enabled && pendingAction == null
    Column(
        modifier =
            Modifier
                .clickable(enabled = canClick, onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Surface(
            shape = CircleShape,
            color = colors.surfaceVariant.copy(alpha = if (enabled) 0.58f else 0.28f),
            modifier = Modifier.size(55.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                if (isBusy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(22.dp),
                        strokeWidth = 2.dp,
                        color = colors.onSurface,
                    )
                } else {
                    Icon(
                        painter = painterResource(iconRes),
                        contentDescription = label,
                        modifier = Modifier.size(18.dp),
                        tint = colors.onSurface.copy(alpha = if (enabled) 0.92f else 0.34f),
                    )
                }
            }
        }
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = colors.onSurface.copy(alpha = if (enabled) 0.92f else 0.34f),
            maxLines = 1,
        )
    }
}

@Composable
fun RepoHeader(
    group: SidebarThreadGroup,
    newChatBusy: Boolean,
    worktreeChatBusy: Boolean,
    colors: SidebarColorPalette,
    onNewChatInProject: (() -> Unit)?,
    onNewWorktreeInProject: (() -> Unit)? = null,
    onArchiveProjectGroup: (() -> Unit)? = null,
    onDeleteLocalGroup: (() -> Unit)? = null,
    onOpenArchivedChats: (() -> Unit)? = null,
    collapsed: Boolean = false,
    onToggleCollapse: (() -> Unit)? = null,
) {
    var showOverflow by remember { mutableStateOf(false) }
    var showCreateMenu by remember { mutableStateOf(false) }
    val hasActions = onArchiveProjectGroup != null || onDeleteLocalGroup != null
    val hasCreateActions = onNewChatInProject != null || onNewWorktreeInProject != null
    val canCollapse = group.kind == SidebarThreadGroupKind.Project
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .heightIn(min = 46.dp)
                .padding(top = 7.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(
            modifier =
                Modifier
                    .weight(1f)
                    .then(
                        if (onOpenArchivedChats != null) {
                            Modifier.clickable { onOpenArchivedChats() }
                        } else if (canCollapse) {
                            Modifier.clickable { onToggleCollapse?.invoke() }
                        } else {
                            Modifier
                        },
                    ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (canCollapse) {
                Icon(
                    imageVector =
                        if (collapsed) {
                            Icons.AutoMirrored.Filled.KeyboardArrowRight
                        } else {
                            Icons.Filled.KeyboardArrowDown
                        },
                    contentDescription = null,
                    tint = colors.mutedText,
                    modifier = Modifier.size(18.dp),
                )
            }
            Icon(
                imageVector = group.leadingIcon(),
                contentDescription = null,
                tint = colors.mutedText,
                modifier = Modifier.size(19.dp),
            )
            Text(
                text = group.label,
                style = MaterialTheme.typography.titleMedium.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                color = colors.primaryText,
                maxLines = 1,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            if (hasCreateActions) {
                Box {
                    IconButton(
                        onClick = {
                            if (onNewWorktreeInProject != null) {
                                showCreateMenu = true
                            } else {
                                onNewChatInProject?.invoke()
                            }
                        },
                        enabled = !newChatBusy && !worktreeChatBusy,
                        modifier = Modifier.size(28.dp),
                    ) {
                        if (newChatBusy || worktreeChatBusy) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(14.dp),
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Icon(
                                imageVector = Icons.Filled.Add,
                                contentDescription = stringResource(R.string.sidebar_new_chat),
                                tint = colors.primaryText,
                            )
                        }
                    }
                    AgntDropdownMenu(
                        expanded = showCreateMenu,
                        onDismissRequest = { showCreateMenu = false },
                    ) {
                        onNewChatInProject?.let { action ->
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.sidebar_new_chat)) },
                                onClick = {
                                    showCreateMenu = false
                                    action()
                                },
                                leadingIcon = {
                                    Icon(
                                        imageVector = Icons.Filled.Add,
                                        contentDescription = null,
                                    )
                                },
                            )
                        }
                        onNewWorktreeInProject?.let { action ->
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.sidebar_new_managed_worktree_chat)) },
                                onClick = {
                                    showCreateMenu = false
                                    action()
                                },
                                leadingIcon = {
                                    Icon(
                                        painter = painterResource(LucideR.drawable.lucide_ic_git_branch),
                                        contentDescription = null,
                                    )
                                },
                            )
                        }
                    }
                }
            }
            if (hasActions) {
                Box {
                    IconButton(
                        onClick = { showOverflow = true },
                        modifier = Modifier.size(28.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Filled.MoreVert,
                            contentDescription = stringResource(R.string.sidebar_thread_actions_cd),
                            tint = colors.mutedText,
                        )
                    }
                    AgntDropdownMenu(
                        expanded = showOverflow,
                        onDismissRequest = { showOverflow = false },
                    ) {
                        onArchiveProjectGroup?.let { action ->
                            DropdownMenuItem(
                                text = { Text("Archive project") },
                                onClick = {
                                    showOverflow = false
                                    action()
                                },
                                leadingIcon = {
                                    Icon(
                                        imageVector = Icons.Outlined.Archive,
                                        contentDescription = null,
                                    )
                                },
                            )
                        }
                        onDeleteLocalGroup?.let { action ->
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        stringResource(R.string.sidebar_thread_delete_local),
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                },
                                onClick = {
                                    showOverflow = false
                                    action()
                                },
                                leadingIcon = {
                                    Icon(
                                        imageVector = Icons.Outlined.Delete,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.error,
                                    )
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ShowAllRow(
    expanded: Boolean,
    totalCount: Int,
    colors: SidebarColorPalette,
    onClick: () -> Unit,
) {
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .heightIn(min = 36.dp)
                .padding(start = 48.dp, end = 6.dp, top = 5.dp, bottom = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text =
                if (expanded) {
                    stringResource(R.string.sidebar_group_show_less)
                } else {
                    stringResource(R.string.sidebar_group_show_all, totalCount)
                },
            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 12.sp),
            color = colors.mutedText,
        )
    }
}

fun SidebarThreadGroup.leadingIcon(): ImageVector =
    when (kind) {
        SidebarThreadGroupKind.Archived -> Icons.Outlined.Archive
        SidebarThreadGroupKind.Chats -> Icons.Outlined.Cloud
        SidebarThreadGroupKind.Project -> {
            val t = threads.firstOrNull()
            when {
                t == null -> Icons.Outlined.Cloud
                t.normalizedProjectPath == null -> Icons.Outlined.Cloud
                t.isManagedWorktreeProject -> Icons.Outlined.AccountTree
                else -> Icons.Outlined.Computer
            }
        }
    }

fun filterThreadsForSidebar(
    threads: List<CodexThread>,
    query: String,
): List<CodexThread> {
    val t = query.trim().lowercase()
    if (t.isEmpty()) return threads
    return threads.filter { thread ->
        thread.displayTitle.lowercase().contains(t) ||
            thread.id.lowercase().contains(t) ||
            (thread.preview?.lowercase()?.contains(t) == true) ||
            (thread.cwd?.lowercase()?.contains(t) == true)
    }
}
