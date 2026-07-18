package com.dotbrains.agnt.mobile.ui.sidebar

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.R

@Composable
internal fun SidebarHeaderActions(
    query: String,
    onQueryChange: (String) -> Unit,
    colors: SidebarColorPalette,
    enabled: Boolean,
    pendingAction: SidebarTopAction?,
    newChatError: String?,
    worktreeChatError: String?,
    onNewChat: () -> Unit,
    onQuickChat: () -> Unit,
    onNewProject: () -> Unit,
    onOpenArchivedChats: () -> Unit,
) {
    SidebarSearchField(query = query, onQueryChange = onQueryChange)
    SidebarTopActionsRow(
        enabled = enabled,
        pendingAction = pendingAction,
        onNewChat = onNewChat,
        onQuickChat = onQuickChat,
        onNewProject = onNewProject,
    )
    SidebarCompactActionRow(
        label = stringResource(R.string.nav_archived_chats),
        enabled = true,
        busy = false,
        onClick = onOpenArchivedChats,
        leading = {
            Icon(
                imageVector = Icons.Outlined.Archive,
                contentDescription = stringResource(R.string.nav_archived_chats),
                modifier = Modifier.size(21.dp),
                tint = colors.secondaryText,
            )
        },
    )
    SidebarHeaderError(newChatError)
    SidebarHeaderError(worktreeChatError)
}

@Composable
private fun SidebarHeaderError(error: String?) {
    error ?: return
    Text(
        text = error,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
    )
}
