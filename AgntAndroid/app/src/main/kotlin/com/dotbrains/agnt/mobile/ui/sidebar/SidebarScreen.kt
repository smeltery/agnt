package com.dotbrains.agnt.mobile.ui.sidebar

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.GitWorktreeChangeTransferMode
import com.dotbrains.agnt.mobile.core.model.TurnGitPreflightOperation
import com.dotbrains.agnt.mobile.core.model.TurnGitPreflightPolicy
import com.dotbrains.agnt.mobile.core.model.TurnGitSyncAlert
import com.dotbrains.agnt.mobile.core.model.TurnGitSyncAlertAction
import com.dotbrains.agnt.mobile.core.model.TurnGitSyncAlertButtonRole
import com.dotbrains.agnt.mobile.core.transport.ConnectionState
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.data.GitBranchDisplayMapper
import com.dotbrains.agnt.mobile.data.WorktreeFlowCoordinator
import com.dotbrains.agnt.mobile.data.WorktreeNewChatDefaults
import com.dotbrains.agnt.mobile.data.loadGitBranchesWithStatus
import com.dotbrains.agnt.mobile.services.git.GitActionsService
import com.dotbrains.agnt.mobile.ui.shared.ThreadRenameDialog
import com.dotbrains.agnt.mobile.ui.theme.AgntDropdownMenu
import kotlinx.coroutines.launch
import com.composables.icons.lucide.R as LucideR

private const val SIDEBAR_THREADS_PER_GROUP = 5

private enum class SidebarTopAction {
    NewChat,
    QuickChat,
    NewProject,
}

@Composable
fun SidebarScreen(
    repository: CodexRepository,
    activeChatMetadata: SidebarActiveChatMetadata? = null,
    onOpenArchivedChats: () -> Unit = {},
    onThreadSelected: suspend () -> Unit = {},
    onOpenNewChatDraft: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val threads by repository.threads.collectAsStateWithLifecycle()
    val activeId by repository.activeThreadId.collectAsStateWithLifecycle()
    val conn by repository.connectionState.collectAsStateWithLifecycle()
    val ready by repository.isSessionReady.collectAsStateWithLifecycle()
    val runningTurnByThread by repository.runningTurnIdByThread.collectAsStateWithLifecycle()
    val protectedRunningFallback by repository.protectedRunningFallbackThreadIds.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val sidebarColors = rememberSidebarColorPalette()
    // Hoisted out of scope.launch so they re-cache on configuration change.
    val noLocalProjectMessage = stringResource(R.string.sidebar_worktree_chat_no_local_project)
    val noBaseBranchMessage = stringResource(R.string.sidebar_worktree_chat_no_base_branch)
    val threadRenameEmptyMessage = stringResource(R.string.thread_rename_dialog_empty)

    var query by remember { mutableStateOf("") }
    var newChatBusy by remember { mutableStateOf(false) }
    var newChatError by remember { mutableStateOf<String?>(null) }
    var showProjectPicker by remember { mutableStateOf(false) }
    var projectPickerInitialPath by remember { mutableStateOf<String?>(null) }
    var projectPickerFoldersCollapsed by remember { mutableStateOf(false) }
    var showWorktreeSheet by remember { mutableStateOf(false) }
    var worktreeSheetBasePath by remember { mutableStateOf<String?>(null) }
    var worktreeChatBusy by remember { mutableStateOf(false) }
    var worktreeChatError by remember { mutableStateOf<String?>(null) }
    var worktreeGitSyncAlert by remember { mutableStateOf<TurnGitSyncAlert?>(null) }
    var pendingWorktreeChat by remember { mutableStateOf<PendingSidebarWorktreeChat?>(null) }
    var renameTarget by remember { mutableStateOf<CodexThread?>(null) }
    var renameBusy by remember { mutableStateOf(false) }
    var renameError by remember { mutableStateOf<String?>(null) }
    var deleteLocalTarget by remember { mutableStateOf<CodexThread?>(null) }
    var deleteLocalBusy by remember { mutableStateOf(false) }
    var deleteLocalError by remember { mutableStateOf<String?>(null) }
    var archiveGroupTarget by remember { mutableStateOf<SidebarThreadGroup?>(null) }
    var archiveGroupBusy by remember { mutableStateOf(false) }
    var archiveGroupError by remember { mutableStateOf<String?>(null) }
    var deleteLocalGroupTarget by remember { mutableStateOf<SidebarThreadGroup?>(null) }
    var deleteLocalGroupBusy by remember { mutableStateOf(false) }
    var deleteLocalGroupError by remember { mutableStateOf<String?>(null) }
    var collapsedGroupIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var expandedGroupIds by remember { mutableStateOf<Set<String>>(emptySet()) }

    val filtered =
        remember(threads, query) {
            filterThreadsForSidebar(threads, query)
        }
    val groups =
        remember(filtered, expandedGroupIds, activeId) {
            SidebarThreadGrouping.applyGroupLimit(
                groups = SidebarThreadGrouping.makeGroups(threads = filtered),
                limit = SIDEBAR_THREADS_PER_GROUP,
                expandedGroupIds = expandedGroupIds,
                pinnedThreadIds = listOfNotNull(activeId).toSet(),
            )
        }

    fun startManagedWorktreeChat(
        baseProjectPath: String? = null,
        selectedBaseBranch: String? = null,
        changeTransfer: GitWorktreeChangeTransferMode = GitWorktreeChangeTransferMode.none,
        preselected: PendingSidebarWorktreeChat? = null,
        skipPreflight: Boolean = false,
    ) {
        worktreeChatError = null
        worktreeChatBusy = true
        scope.launch {
            try {
                val base =
                    preselected?.baseProjectPath
                        ?: baseProjectPath?.trim()?.takeIf { it.isNotEmpty() }
                        ?: WorktreeNewChatDefaults.baseProjectPath(activeId, threads)
                        ?: run {
                            worktreeChatError = noLocalProjectMessage
                            return@launch
                        }
                val branch =
                    preselected?.baseBranch
                        ?: selectedBaseBranch?.trim()?.takeIf { it.isNotEmpty() }
                        ?: run {
                            val loaded = loadGitBranchesWithStatus(repository, base)
                            val gitResult =
                                loaded.getOrNull() ?: run {
                                    worktreeChatError =
                                        loaded.exceptionOrNull()?.let { GitBranchDisplayMapper.userVisibleMessage(it) }
                                            ?: noBaseBranchMessage
                                    return@launch
                                }
                            WorktreeNewChatDefaults.baseBranch(GitBranchDisplayMapper.summaryFrom(gitResult))
                                ?: run {
                                    worktreeChatError =
                                        noBaseBranchMessage
                                    return@launch
                                }
                        }
                if (!skipPreflight) {
                    val loaded = loadGitBranchesWithStatus(repository, base)
                    val gitResult =
                        loaded.getOrNull() ?: run {
                            worktreeChatError =
                                loaded.exceptionOrNull()?.let { GitBranchDisplayMapper.userVisibleMessage(it) }
                                    ?: noBaseBranchMessage
                            return@launch
                        }
                    val alert =
                        TurnGitPreflightPolicy.alertFor(
                            status = gitResult.status,
                            branches = gitResult,
                            operation =
                                TurnGitPreflightOperation.createManagedWorktree(
                                    baseBranch = branch,
                                    changeTransfer = changeTransfer,
                                ),
                        )
                    if (alert != null) {
                        pendingWorktreeChat = PendingSidebarWorktreeChat(base, branch, changeTransfer)
                        worktreeGitSyncAlert = alert
                        return@launch
                    }
                }
                WorktreeFlowCoordinator(repository).startNewManagedWorktreeChat(base, branch, changeTransfer)
                showWorktreeSheet = false
                worktreeSheetBasePath = null
                onThreadSelected()
            } catch (e: Exception) {
                worktreeChatError = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
            } finally {
                worktreeChatBusy = false
            }
        }
    }

    fun startQuickChat() {
        if (newChatBusy || worktreeChatBusy) return
        newChatError = null
        newChatBusy = true
        scope.launch {
            try {
                startSidebarNewChat(repository, null)
                onThreadSelected()
            } catch (e: Exception) {
                newChatError = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
            } finally {
                newChatBusy = false
            }
        }
    }

    Column(
        modifier =
            modifier
                .fillMaxHeight()
                .fillMaxWidth()
                .background(sidebarColors.background)
                .padding(horizontal = 4.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        SidebarSearchField(query = query, onQueryChange = { query = it })
        val bridgeConnected = conn is ConnectionState.Connected
        val worktreeEntryEnabled = ready && bridgeConnected && !newChatBusy && !worktreeChatBusy

        SidebarTopActionsRow(
            enabled = ready && bridgeConnected,
            pendingAction =
                when {
                    newChatBusy && showProjectPicker -> SidebarTopAction.NewChat
                    newChatBusy -> SidebarTopAction.QuickChat
                    worktreeChatBusy -> SidebarTopAction.NewProject
                    else -> null
                },
            onNewChat = {
                newChatError = null
                projectPickerInitialPath = WorktreeNewChatDefaults.baseProjectPath(activeId, threads)
                projectPickerFoldersCollapsed = false
                showProjectPicker = true
            },
            onQuickChat = {
                if (onOpenNewChatDraft != null) {
                    newChatError = null
                    onOpenNewChatDraft()
                } else {
                    startQuickChat()
                }
            },
            onNewProject = { startManagedWorktreeChat() },
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
                    tint = sidebarColors.secondaryText,
                )
            },
        )
        newChatError?.let { err ->
            Text(
                text = err,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        worktreeChatError?.let { err ->
            Text(
                text = err,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            groups.filter { it.kind != SidebarThreadGroupKind.Archived }.forEach { group ->
                item(key = "hdr-${group.id}") {
                    val isCollapsed = group.id in collapsedGroupIds
                    RepoHeader(
                        group = group,
                        newChatBusy = newChatBusy,
                        worktreeChatBusy = worktreeChatBusy,
                        colors = sidebarColors,
                        collapsed = isCollapsed,
                        onToggleCollapse = {
                            collapsedGroupIds =
                                if (isCollapsed) {
                                    collapsedGroupIds - group.id
                                } else {
                                    collapsedGroupIds + group.id
                                }
                        },
                        onNewChatInProject =
                            if (group.kind == SidebarThreadGroupKind.Project && group.projectPath != null) {
                                {
                                    newChatError = null
                                    projectPickerInitialPath = group.projectPath
                                    projectPickerFoldersCollapsed = true
                                    showProjectPicker = true
                                }
                            } else {
                                null
                            },
                        onNewWorktreeInProject =
                            if (
                                group.kind == SidebarThreadGroupKind.Project &&
                                group.projectPath != null &&
                                worktreeEntryEnabled
                            ) {
                                {
                                    worktreeChatError = null
                                    worktreeSheetBasePath = group.projectPath
                                    showWorktreeSheet = true
                                }
                            } else {
                                null
                            },
                        onArchiveProjectGroup =
                            if (group.kind == SidebarThreadGroupKind.Project) {
                                {
                                    archiveGroupTarget = group
                                    archiveGroupError = null
                                }
                            } else {
                                null
                            },
                        onDeleteLocalGroup =
                            if (group.kind == SidebarThreadGroupKind.Project) {
                                {
                                    deleteLocalGroupTarget = group
                                    deleteLocalGroupError = null
                                }
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
                    val isActive = thread.id == activeId
                    val isRunning =
                        runningTurnByThread.containsKey(thread.id) ||
                            protectedRunningFallback.contains(thread.id)
                    val onSelectThread = {
                        scope.launch {
                            repository.setActiveThreadId(thread.id)
                            onThreadSelected()
                        }
                        Unit
                    }
                    val onRenameThread = {
                        renameTarget = thread
                        renameError = null
                    }
                    val onDeleteThread = {
                        deleteLocalTarget = thread
                        deleteLocalError = null
                    }
                    if (isActive) {
                        ActiveChatRow(
                            thread = thread,
                            isRunning = isRunning,
                            activeMetadata = activeChatMetadata,
                            onSelect = onSelectThread,
                            onRenameRequest = onRenameThread,
                            onDeleteLocalRequest = onDeleteThread,
                        )
                    } else {
                        ChatRow(
                            thread = thread,
                            isRunning = isRunning,
                            onSelect = onSelectThread,
                            onRenameRequest = onRenameThread,
                            onDeleteLocalRequest = onDeleteThread,
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
                            colors = sidebarColors,
                            onClick = {
                                expandedGroupIds =
                                    if (group.id in expandedGroupIds) {
                                        expandedGroupIds - group.id
                                    } else {
                                        expandedGroupIds + group.id
                                    }
                            },
                        )
                    }
                }
            }
        }
        ThreadRenameDialog(
            visible = renameTarget != null,
            initialName = renameTarget?.displayTitle.orEmpty(),
            busy = renameBusy,
            error = renameError,
            onDismiss = {
                if (!renameBusy) {
                    renameTarget = null
                    renameError = null
                }
            },
            onConfirm = { newName ->
                val target = renameTarget ?: return@ThreadRenameDialog
                if (newName.isBlank()) {
                    renameError = threadRenameEmptyMessage
                    return@ThreadRenameDialog
                }
                renameBusy = true
                renameError = null
                scope.launch {
                    runCatching {
                        repository.renameThread(target.id, newName)
                    }.onSuccess {
                        renameTarget = null
                    }.onFailure { e ->
                        renameError = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
                    }
                    renameBusy = false
                }
            },
        )
        deleteLocalTarget?.let { target ->
            AlertDialog(
                onDismissRequest = {
                    if (!deleteLocalBusy) {
                        deleteLocalTarget = null
                        deleteLocalError = null
                    }
                },
                title = { Text(stringResource(R.string.sidebar_thread_delete_local_title)) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(R.string.sidebar_thread_delete_local_message, target.displayTitle))
                        deleteLocalError?.let { err ->
                            Text(
                                text = err,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                },
                confirmButton = {
                    TextButton(
                        enabled = !deleteLocalBusy,
                        onClick = {
                            deleteLocalBusy = true
                            deleteLocalError = null
                            scope.launch {
                                runCatching {
                                    repository.deleteThreadLocally(target.id)
                                }.onSuccess {
                                    deleteLocalTarget = null
                                }.onFailure { e ->
                                    deleteLocalError = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
                                }
                                deleteLocalBusy = false
                            }
                        },
                    ) {
                        Text(
                            text =
                                if (deleteLocalBusy) {
                                    stringResource(R.string.sidebar_thread_delete_local_deleting)
                                } else {
                                    stringResource(R.string.sidebar_thread_delete_local_confirm)
                                },
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                },
                dismissButton = {
                    TextButton(
                        enabled = !deleteLocalBusy,
                        onClick = {
                            deleteLocalTarget = null
                            deleteLocalError = null
                        },
                    ) {
                        Text(stringResource(android.R.string.cancel))
                    }
                },
            )
        }
        archiveGroupTarget?.let { group ->
            AlertDialog(
                onDismissRequest = {
                    if (!archiveGroupBusy) {
                        archiveGroupTarget = null
                        archiveGroupError = null
                    }
                },
                title = { Text(stringResource(R.string.sidebar_project_archive_title, group.label)) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(R.string.sidebar_project_archive_message))
                        archiveGroupError?.let { err ->
                            Text(
                                text = err,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                },
                confirmButton = {
                    TextButton(
                        enabled = !archiveGroupBusy,
                        onClick = {
                            archiveGroupBusy = true
                            archiveGroupError = null
                            scope.launch {
                                runCatching {
                                    val ids = SidebarThreadGrouping.liveThreadIdsForGroup(group, threads)
                                    repository.archiveThreadGroup(ids)
                                }.onSuccess {
                                    archiveGroupTarget = null
                                }.onFailure { e ->
                                    archiveGroupError = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
                                }
                                archiveGroupBusy = false
                            }
                        },
                    ) {
                        Text(
                            text =
                                if (archiveGroupBusy) {
                                    stringResource(R.string.sidebar_project_archive_busy)
                                } else {
                                    stringResource(R.string.sidebar_project_archive_confirm)
                                },
                        )
                    }
                },
                dismissButton = {
                    TextButton(
                        enabled = !archiveGroupBusy,
                        onClick = {
                            archiveGroupTarget = null
                            archiveGroupError = null
                        },
                    ) {
                        Text(stringResource(android.R.string.cancel))
                    }
                },
            )
        }
        deleteLocalGroupTarget?.let { group ->
            AlertDialog(
                onDismissRequest = {
                    if (!deleteLocalGroupBusy) {
                        deleteLocalGroupTarget = null
                        deleteLocalGroupError = null
                    }
                },
                title = { Text(stringResource(R.string.sidebar_project_delete_local_title, group.label)) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(R.string.sidebar_project_delete_local_message))
                        deleteLocalGroupError?.let { err ->
                            Text(
                                text = err,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                },
                confirmButton = {
                    TextButton(
                        enabled = !deleteLocalGroupBusy,
                        onClick = {
                            deleteLocalGroupBusy = true
                            deleteLocalGroupError = null
                            scope.launch {
                                runCatching {
                                    val ids = SidebarThreadGrouping.liveThreadIdsForGroup(group, threads)
                                    repository.deleteLocalThreadGroup(ids)
                                }.onSuccess {
                                    deleteLocalGroupTarget = null
                                }.onFailure { e ->
                                    deleteLocalGroupError = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
                                }
                                deleteLocalGroupBusy = false
                            }
                        },
                    ) {
                        Text(
                            text =
                                if (deleteLocalGroupBusy) {
                                    stringResource(R.string.sidebar_project_delete_local_busy)
                                } else {
                                    stringResource(R.string.sidebar_project_delete_local_confirm)
                                },
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                },
                dismissButton = {
                    TextButton(
                        enabled = !deleteLocalGroupBusy,
                        onClick = {
                            deleteLocalGroupTarget = null
                            deleteLocalGroupError = null
                        },
                    ) {
                        Text(stringResource(android.R.string.cancel))
                    }
                },
            )
        }
        SidebarProjectPickerSheet(
            repository = repository,
            visible = showProjectPicker,
            initialPath = projectPickerInitialPath ?: WorktreeNewChatDefaults.baseProjectPath(activeId, threads),
            onDismiss = {
                showProjectPicker = false
                projectPickerInitialPath = null
                projectPickerFoldersCollapsed = false
            },
            onStartBusyChange = { newChatBusy = it },
            onStartThread = { cwd -> startSidebarNewChat(repository, cwd) },
            initialFoldersCollapsed = projectPickerFoldersCollapsed,
            threads = threads,
            activeThreadId = activeId,
            activeChatMetadata = activeChatMetadata,
            onThreadStarted = onThreadSelected,
        )
        SidebarNewWorktreeSheet(
            repository = repository,
            visible = showWorktreeSheet,
            baseProjectPath = worktreeSheetBasePath,
            busy = worktreeChatBusy,
            onDismiss = {
                showWorktreeSheet = false
                worktreeSheetBasePath = null
                worktreeChatError = null
            },
            onCreate = { basePath, baseBranch, transfer ->
                startManagedWorktreeChat(
                    baseProjectPath = basePath,
                    selectedBaseBranch = baseBranch,
                    changeTransfer = transfer,
                )
            },
        )
        worktreeGitSyncAlert?.let { alert ->
            fun dismissWorktreeAlert() {
                worktreeGitSyncAlert = null
                pendingWorktreeChat = null
            }

            AlertDialog(
                onDismissRequest = { dismissWorktreeAlert() },
                title = { Text(alert.title) },
                text = { Text(alert.message) },
                confirmButton = {
                    Column {
                        alert.buttons
                            .filter { it.role != TurnGitSyncAlertButtonRole.cancel }
                            .forEach { button ->
                                TextButton(
                                    onClick = {
                                        when (button.action) {
                                            TurnGitSyncAlertAction.continuePendingGitOperation,
                                            TurnGitSyncAlertAction.continueGitBranchOperation,
                                            -> {
                                                val pending = pendingWorktreeChat
                                                dismissWorktreeAlert()
                                                if (pending != null) {
                                                    startManagedWorktreeChat(
                                                        preselected = pending,
                                                        changeTransfer = pending.changeTransfer,
                                                        skipPreflight = true,
                                                    )
                                                }
                                            }
                                            TurnGitSyncAlertAction.pullRebase -> {
                                                val pending = pendingWorktreeChat
                                                dismissWorktreeAlert()
                                                if (pending != null) {
                                                    worktreeChatBusy = true
                                                    scope.launch {
                                                        runCatching {
                                                            GitActionsService(
                                                                repository,
                                                                pending.baseProjectPath,
                                                            ).pull()
                                                        }.onFailure { e ->
                                                            worktreeChatError =
                                                                GitBranchDisplayMapper.userVisibleMessage(e)
                                                        }
                                                        worktreeChatBusy = false
                                                    }
                                                }
                                            }
                                            else -> dismissWorktreeAlert()
                                        }
                                    },
                                ) {
                                    Text(
                                        text = button.title,
                                        color =
                                            if (button.role == TurnGitSyncAlertButtonRole.destructive) {
                                                MaterialTheme.colorScheme.error
                                            } else {
                                                MaterialTheme.colorScheme.primary
                                            },
                                    )
                                }
                            }
                        if (alert.buttons.none { it.role != TurnGitSyncAlertButtonRole.cancel }) {
                            TextButton(onClick = { dismissWorktreeAlert() }) {
                                Text(stringResource(android.R.string.ok))
                            }
                        }
                    }
                },
                dismissButton = {
                    val cancel = alert.buttons.firstOrNull { it.role == TurnGitSyncAlertButtonRole.cancel }
                    if (cancel != null && alert.buttons.size > 1) {
                        TextButton(onClick = { dismissWorktreeAlert() }) {
                            Text(cancel.title)
                        }
                    }
                },
            )
        }
    }
}

private data class PendingSidebarWorktreeChat(
    val baseProjectPath: String,
    val baseBranch: String,
    val changeTransfer: GitWorktreeChangeTransferMode,
)

@Composable
private fun SidebarTopActionsRow(
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
private fun SidebarTopActionButton(
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
private fun RepoHeader(
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
private fun ShowAllRow(
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

private fun SidebarThreadGroup.leadingIcon(): ImageVector =
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

private fun filterThreadsForSidebar(
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
