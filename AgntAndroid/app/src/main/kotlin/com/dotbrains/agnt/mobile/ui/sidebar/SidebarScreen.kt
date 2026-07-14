package com.dotbrains.agnt.mobile.ui.sidebar

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
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
import kotlinx.coroutines.launch

private const val SIDEBAR_THREADS_PER_GROUP = 5

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
