package com.smeltery.agnt.mobile.ui.sidebar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.smeltery.agnt.mobile.core.model.CodexThread

private const val SIDEBAR_THREADS_PER_GROUP = 5

@Composable
internal fun SidebarThreadGroupsList(
    modifier: Modifier = Modifier,
    groups: List<SidebarThreadGroup>,
    activeId: String?,
    activeChatMetadata: SidebarActiveChatMetadata?,
    colors: SidebarColorPalette,
    newChatBusy: Boolean,
    worktreeChatBusy: Boolean,
    worktreeEntryEnabled: Boolean,
    runningTurnIdsByThread: Map<String, *>,
    protectedRunningFallbackThreadIds: Set<String>,
    collapsedGroupIds: Set<String>,
    expandedGroupIds: Set<String>,
    onToggleCollapsed: (String) -> Unit,
    onToggleExpanded: (String) -> Unit,
    onNewChatInProject: (String) -> Unit,
    onNewWorktreeInProject: (String) -> Unit,
    onArchiveProjectGroup: (SidebarThreadGroup) -> Unit,
    onDeleteLocalGroup: (SidebarThreadGroup) -> Unit,
    onSelectThread: (CodexThread) -> Unit,
    onRenameThread: (CodexThread) -> Unit,
    onDeleteLocalThread: (CodexThread) -> Unit,
) {
    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        groups.filter { it.kind != SidebarThreadGroupKind.Archived }.forEach { group ->
            item(key = "hdr-${group.id}") {
                RepoHeader(
                    group = group,
                    newChatBusy = newChatBusy,
                    worktreeChatBusy = worktreeChatBusy,
                    colors = colors,
                    collapsed = group.id in collapsedGroupIds,
                    onToggleCollapse = { onToggleCollapsed(group.id) },
                    onNewChatInProject =
                        if (group.kind == SidebarThreadGroupKind.Project && group.projectPath != null) {
                            { onNewChatInProject(group.projectPath) }
                        } else {
                            null
                        },
                    onNewWorktreeInProject =
                        if (
                            group.kind == SidebarThreadGroupKind.Project &&
                            group.projectPath != null &&
                            worktreeEntryEnabled
                        ) {
                            { onNewWorktreeInProject(group.projectPath) }
                        } else {
                            null
                        },
                    onArchiveProjectGroup =
                        if (group.kind == SidebarThreadGroupKind.Project) {
                            { onArchiveProjectGroup(group) }
                        } else {
                            null
                        },
                    onDeleteLocalGroup =
                        if (group.kind == SidebarThreadGroupKind.Project) {
                            { onDeleteLocalGroup(group) }
                        } else {
                            null
                        },
                    onOpenArchivedChats = null,
                )
            }
            items(
                items = if (group.id in collapsedGroupIds) emptyList() else group.visibleThreads,
                key = { it.id },
            ) { thread ->
                val isRunning =
                    runningTurnIdsByThread.containsKey(thread.id) ||
                        protectedRunningFallbackThreadIds.contains(thread.id)
                if (thread.id == activeId) {
                    ActiveChatRow(
                        thread = thread,
                        isRunning = isRunning,
                        activeMetadata = activeChatMetadata,
                        onSelect = { onSelectThread(thread) },
                        onRenameRequest = { onRenameThread(thread) },
                        onDeleteLocalRequest = { onDeleteLocalThread(thread) },
                    )
                } else {
                    ChatRow(
                        thread = thread,
                        isRunning = isRunning,
                        onSelect = { onSelectThread(thread) },
                        onRenameRequest = { onRenameThread(thread) },
                        onDeleteLocalRequest = { onDeleteLocalThread(thread) },
                    )
                }
            }
            if (group.id !in collapsedGroupIds &&
                (
                    group.hiddenCount > 0 ||
                        (group.id in expandedGroupIds && group.totalCount > SIDEBAR_THREADS_PER_GROUP)
                )
            ) {
                item(key = "more-${group.id}") {
                    ShowAllRow(
                        expanded = group.id in expandedGroupIds,
                        totalCount = group.totalCount,
                        colors = colors,
                        onClick = { onToggleExpanded(group.id) },
                    )
                }
            }
        }
    }
}
