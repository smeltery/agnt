package com.smeltery.agnt.mobile.ui.sidebar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.smeltery.agnt.mobile.R
import com.smeltery.agnt.mobile.core.model.CodexProjectDirectoryEntry
import com.smeltery.agnt.mobile.core.model.CodexProjectDirectoryListing
import com.smeltery.agnt.mobile.core.model.CodexProjectLocation
import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.services.git.ProjectFolderService
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SidebarProjectPickerSheet(
    repository: CodexRepository,
    visible: Boolean,
    initialPath: String?,
    onDismiss: () -> Unit,
    onStartBusyChange: (Boolean) -> Unit,
    onStartThread: suspend (String?) -> Unit,
    initialFoldersCollapsed: Boolean = false,
    threads: List<CodexThread> = emptyList(),
    activeThreadId: String? = null,
    activeChatMetadata: SidebarActiveChatMetadata? = null,
    onThreadStarted: suspend () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    if (!visible) return

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val service = remember(repository) { ProjectFolderService(repository) }
    val colors = rememberSidebarColorPalette()

    var quickLocations by remember { mutableStateOf<List<CodexProjectLocation>>(emptyList()) }
    var currentPath by remember(visible, initialPath) { mutableStateOf(initialPath?.trim().orEmpty()) }
    var listing by remember { mutableStateOf<CodexProjectDirectoryListing?>(null) }
    var searchQuery by remember(visible) { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<CodexProjectDirectoryEntry>>(emptyList()) }
    var loadingError by remember { mutableStateOf<String?>(null) }
    var startError by remember { mutableStateOf<String?>(null) }
    var createName by remember(visible, initialPath) { mutableStateOf("") }
    var startBusy by remember { mutableStateOf(false) }
    var startingPath by remember { mutableStateOf<String?>(null) }
    var noCwdBusy by remember { mutableStateOf(false) }
    var createBusy by remember { mutableStateOf(false) }
    var foldersCollapsed by remember(visible, initialPath, initialFoldersCollapsed) {
        mutableStateOf(initialFoldersCollapsed)
    }
    var sessionType by remember(visible) { mutableStateOf(NewThreadSessionType.LocalWorkspace) }
    var showAllRecentWorkspaces by remember(visible) { mutableStateOf(false) }

    fun normalizedPath(): String = currentPath.trim()

    fun closeSheet() {
        onStartBusyChange(false)
        onDismiss()
    }

    fun startChat(path: String) {
        val cwd = path.trim()
        if (cwd.isBlank() || startBusy) return
        startError = null
        startBusy = true
        startingPath = cwd
        onStartBusyChange(true)
        scope.launch {
            try {
                onStartThread(cwd)
                closeSheet()
                onThreadStarted()
            } catch (e: Exception) {
                startError = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
            } finally {
                startBusy = false
                startingPath = null
                onStartBusyChange(false)
            }
        }
    }

    fun startCloudChat() {
        if (noCwdBusy || startBusy) return
        startError = null
        noCwdBusy = true
        onStartBusyChange(true)
        scope.launch {
            try {
                onStartThread(null)
                closeSheet()
                onThreadStarted()
            } catch (e: Exception) {
                startError = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
            } finally {
                noCwdBusy = false
                onStartBusyChange(false)
            }
        }
    }

    fun selectFolder(path: String) {
        val cwd = path.trim()
        if (cwd.isBlank()) return
        currentPath = cwd
        searchQuery = ""
        createName = ""
        loadingError = null
    }

    fun createFolder() {
        val parent = normalizedPath()
        val name = createName.trim()
        if (parent.isBlank() || name.isBlank() || createBusy) return
        createBusy = true
        loadingError = null
        scope.launch {
            try {
                val createdPath = service.createDirectory(parent, name)
                createName = ""
                searchQuery = ""
                currentPath = createdPath
            } catch (e: Exception) {
                loadingError = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
            } finally {
                createBusy = false
            }
        }
    }

    LaunchedEffect(visible) {
        if (!visible) return@LaunchedEffect
        loadingError = null
        startError = null
        searchQuery = ""
        createName = ""
        startingPath = null
        sessionType = NewThreadSessionType.LocalWorkspace
        showAllRecentWorkspaces = false
        quickLocations =
            runCatching { service.quickLocations() }
                .getOrElse {
                    loadingError = it.message?.takeIf { msg -> msg.isNotBlank() } ?: it.javaClass.simpleName
                    emptyList()
                }
        if (normalizedPath().isBlank()) {
            currentPath = quickLocations.firstOrNull()?.path.orEmpty()
        }
    }

    LaunchedEffect(currentPath, searchQuery, visible) {
        if (!visible) return@LaunchedEffect
        val path = normalizedPath()
        if (path.isBlank()) {
            listing = null
            searchResults = emptyList()
            return@LaunchedEffect
        }
        loadingError = null
        if (searchQuery.trim().isNotEmpty()) {
            searchResults =
                runCatching { service.searchDirectories(path, searchQuery) }
                    .getOrElse {
                        loadingError = it.message?.takeIf { msg -> msg.isNotBlank() } ?: it.javaClass.simpleName
                        emptyList()
                    }.sortedForWorkspacePicker()
            listing = null
        } else {
            listing =
                runCatching { service.listDirectory(path) }
                    .getOrElse {
                        loadingError = it.message?.takeIf { msg -> msg.isNotBlank() } ?: it.javaClass.simpleName
                        null
                    }
            searchResults = emptyList()
            listing?.path?.trim()?.takeIf { it.isNotBlank() }?.let { canonical ->
                if (canonical != currentPath) {
                    currentPath = canonical
                }
            }
        }
    }

    ModalBottomSheet(
        modifier = modifier,
        onDismissRequest = {
            if (!startBusy) {
                closeSheet()
            }
        },
        sheetState = sheetState,
        shape = RoundedCornerShape(16.dp),
    ) {
        val visibleEntries =
            if (searchQuery.trim().isNotEmpty()) {
                searchResults
            } else {
                listing?.entries.orEmpty().sortedForWorkspacePicker()
            }
        val searchingFolders = searchQuery.trim().isNotEmpty()
        val folderListCollapsed = foldersCollapsed && !searchingFolders
        val currentWorkspace =
            remember(normalizedPath(), threads, activeThreadId, activeChatMetadata) {
                currentWorkspaceSummary(
                    path = normalizedPath(),
                    threads = threads,
                    activeThreadId = activeThreadId,
                    activeChatMetadata = activeChatMetadata,
                )
            }
        val recentWorkspaces =
            remember(threads, normalizedPath()) {
                recentWorkspaceSummaries(
                    threads = threads,
                    currentPath = normalizedPath(),
                )
            }
        val visibleRecentWorkspaces =
            if (showAllRecentWorkspaces) {
                recentWorkspaces
            } else {
                recentWorkspaces.take(3)
            }
        val quickLocationChips = quickLocations.preferredQuickLocations()

        LazyColumn(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .fillMaxHeight(0.9f),
            contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item {
                NewThreadHeader(
                    colors = colors,
                    startBusy = startBusy,
                    onCancel = { closeSheet() },
                )
            }

            item {
                CurrentWorkspaceSection(
                    workspace = currentWorkspace,
                    colors = colors,
                    enabled = !startBusy && !noCwdBusy && !createBusy && currentWorkspace != null,
                    busy = startBusy && startingPath == currentWorkspace?.path,
                    onStart = {
                        currentWorkspace?.path?.let { startChat(it) }
                    },
                )
            }

            item {
                SessionTypeSelector(
                    selected = sessionType,
                    colors = colors,
                    cloudBusy = noCwdBusy,
                    enabled = !startBusy && !createBusy,
                    onSelected = { sessionType = it },
                    onStartCloud = { startCloudChat() },
                )
            }

            if (visibleRecentWorkspaces.isNotEmpty()) {
                item {
                    SectionLabel(
                        text = stringResource(R.string.sidebar_project_picker_recent_workspaces),
                        colors = colors,
                        actionText =
                            stringResource(R.string.sidebar_project_picker_view_all).takeIf {
                                recentWorkspaces.size > 3 && !showAllRecentWorkspaces
                            },
                        onAction = { showAllRecentWorkspaces = true },
                    )
                }
                items(visibleRecentWorkspaces, key = { "recent-${it.path}" }) { workspace ->
                    WorkspaceRow(
                        workspace = workspace,
                        colors = colors,
                        enabled = !startBusy && !noCwdBusy && !createBusy,
                        busy = startBusy && startingPath == workspace.path,
                        onClick = { startChat(workspace.path) },
                    )
                }
            }

            item {
                BrowseWorkspaceSection(
                    currentPath = currentPath,
                    parentPath = listing?.parentPath,
                    quickLocations = quickLocationChips,
                    query = searchQuery,
                    colors = colors,
                    enabled = !startBusy && !noCwdBusy && !createBusy,
                    onQueryChange = { searchQuery = it },
                    onQuickLocation = { startChat(it.path) },
                    onParent = { parent -> selectFolder(parent) },
                )
            }

            if (loadingError != null || startError != null) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        loadingError?.let { error ->
                            Text(
                                text = error,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                        startError?.let { error ->
                            Text(
                                text = error,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
            }

            item {
                CreateFolderField(
                    value = createName,
                    colors = colors,
                    enabled = !createBusy && !startBusy && currentPath.isNotBlank(),
                    busy = createBusy,
                    onValueChange = { createName = it },
                    onCreate = { createFolder() },
                )
            }

            item {
                SectionLabel(
                    text =
                        if (searchingFolders) {
                            stringResource(R.string.sidebar_project_picker_search_results)
                        } else {
                            stringResource(R.string.sidebar_project_picker_subfolders)
                        },
                    colors = colors,
                    actionText =
                        if (!searchingFolders) {
                            if (folderListCollapsed) {
                                stringResource(R.string.sidebar_project_picker_show)
                            } else {
                                stringResource(R.string.sidebar_project_picker_hide)
                            }
                        } else {
                            null
                        },
                    onAction = { foldersCollapsed = !foldersCollapsed },
                )
            }

            if (!folderListCollapsed) {
                if (visibleEntries.isEmpty()) {
                    item {
                        Text(
                            text =
                                if (searchingFolders) {
                                    stringResource(R.string.sidebar_project_picker_empty_search)
                                } else {
                                    stringResource(R.string.sidebar_project_picker_empty_folder)
                                },
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.secondaryText,
                            modifier = Modifier.padding(vertical = 6.dp),
                        )
                    }
                } else {
                    items(visibleEntries, key = { "folder-${it.id}" }) { entry ->
                        FolderRow(
                            entry = entry,
                            colors = colors,
                            enabled = !startBusy && !createBusy,
                            onClick = { selectFolder(entry.path) },
                        )
                    }
                }
            }

            item {
                StartSelectedFolderRow(
                    path = normalizedPath(),
                    colors = colors,
                    enabled = !startBusy && !createBusy && normalizedPath().isNotBlank(),
                    busy = startBusy && startingPath == normalizedPath(),
                    onClick = { startChat(normalizedPath()) },
                )
            }
        }
    }
}
