package com.dotbrains.agnt.mobile.ui.sidebar

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
        val bridgeConnected = conn is ConnectionState.Connected
        val worktreeEntryEnabled = ready && bridgeConnected && !newChatBusy && !worktreeChatBusy

        SidebarHeaderActions(
            query = query,
            onQueryChange = { query = it },
            colors = sidebarColors,
            enabled = ready && bridgeConnected,
            pendingAction =
                when {
                    newChatBusy && showProjectPicker -> SidebarTopAction.NewChat
                    newChatBusy -> SidebarTopAction.QuickChat
                    worktreeChatBusy -> SidebarTopAction.NewProject
                    else -> null
                },
            newChatError = newChatError,
            worktreeChatError = worktreeChatError,
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
            onOpenArchivedChats = onOpenArchivedChats,
        )
        SidebarThreadGroupsList(
            modifier = Modifier.weight(1f),
            groups = groups,
            activeId = activeId,
            activeChatMetadata = activeChatMetadata,
            colors = sidebarColors,
            newChatBusy = newChatBusy,
            worktreeChatBusy = worktreeChatBusy,
            worktreeEntryEnabled = worktreeEntryEnabled,
            runningTurnIdsByThread = runningTurnByThread,
            protectedRunningFallbackThreadIds = protectedRunningFallback,
            collapsedGroupIds = collapsedGroupIds,
            expandedGroupIds = expandedGroupIds,
            onToggleCollapsed = { groupId ->
                collapsedGroupIds =
                    if (groupId in collapsedGroupIds) {
                        collapsedGroupIds - groupId
                    } else {
                        collapsedGroupIds + groupId
                    }
            },
            onToggleExpanded = { groupId ->
                expandedGroupIds =
                    if (groupId in expandedGroupIds) {
                        expandedGroupIds - groupId
                    } else {
                        expandedGroupIds + groupId
                    }
            },
            onNewChatInProject = { projectPath ->
                newChatError = null
                projectPickerInitialPath = projectPath
                projectPickerFoldersCollapsed = true
                showProjectPicker = true
            },
            onNewWorktreeInProject = { projectPath ->
                worktreeChatError = null
                worktreeSheetBasePath = projectPath
                showWorktreeSheet = true
            },
            onArchiveProjectGroup = { group ->
                archiveGroupTarget = group
                archiveGroupError = null
            },
            onDeleteLocalGroup = { group ->
                deleteLocalGroupTarget = group
                deleteLocalGroupError = null
            },
            onSelectThread = { thread ->
                scope.launch {
                    repository.setActiveThreadId(thread.id)
                    onThreadSelected()
                }
            },
            onRenameThread = { thread ->
                renameTarget = thread
                renameError = null
            },
            onDeleteLocalThread = { thread ->
                deleteLocalTarget = thread
                deleteLocalError = null
            },
        )
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
        SidebarDeleteLocalThreadDialog(
            target = deleteLocalTarget,
            busy = deleteLocalBusy,
            error = deleteLocalError,
            onDismiss = {
                deleteLocalTarget = null
                deleteLocalError = null
            },
            onConfirm = { target ->
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
        )
        SidebarArchiveGroupDialog(
            group = archiveGroupTarget,
            busy = archiveGroupBusy,
            error = archiveGroupError,
            onDismiss = {
                archiveGroupTarget = null
                archiveGroupError = null
            },
            onConfirm = { group ->
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
        )
        SidebarDeleteLocalGroupDialog(
            group = deleteLocalGroupTarget,
            busy = deleteLocalGroupBusy,
            error = deleteLocalGroupError,
            onDismiss = {
                deleteLocalGroupTarget = null
                deleteLocalGroupError = null
            },
            onConfirm = { group ->
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
        )
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
        SidebarWorktreeGitSyncAlertDialog(
            alert = worktreeGitSyncAlert,
            onDismiss = {
                worktreeGitSyncAlert = null
                pendingWorktreeChat = null
            },
            onAction = { action ->
                when (action) {
                    TurnGitSyncAlertAction.continuePendingGitOperation,
                    TurnGitSyncAlertAction.continueGitBranchOperation,
                    -> {
                        val pending = pendingWorktreeChat
                        worktreeGitSyncAlert = null
                        pendingWorktreeChat = null
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
                        worktreeGitSyncAlert = null
                        pendingWorktreeChat = null
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
                    else -> {
                        worktreeGitSyncAlert = null
                        pendingWorktreeChat = null
                    }
                }
            },
        )
    }
}
