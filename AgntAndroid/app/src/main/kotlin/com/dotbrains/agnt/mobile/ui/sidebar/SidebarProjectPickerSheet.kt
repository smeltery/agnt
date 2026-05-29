package com.dotbrains.agnt.mobile.ui.sidebar

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.CodexProjectDirectoryEntry
import com.dotbrains.agnt.mobile.core.model.CodexProjectDirectoryListing
import com.dotbrains.agnt.mobile.core.model.CodexProjectLocation
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.projectDisplayLabelFor
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.services.git.ProjectFolderService
import kotlinx.coroutines.launch
import java.time.Instant

private enum class NewThreadSessionType {
    LocalWorkspace,
    CloudOnly,
}

private data class NewThreadWorkspaceSummary(
    val name: String,
    val path: String,
    val metadata: String,
    val relativeTime: String? = null,
)

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

@Composable
private fun NewThreadHeader(
    colors: SidebarColorPalette,
    startBusy: Boolean,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                text = stringResource(R.string.sidebar_project_picker_title),
                style = MaterialTheme.typography.titleLarge,
                color = colors.primaryText,
            )
            Text(
                text = stringResource(R.string.sidebar_project_picker_subtitle),
                style = MaterialTheme.typography.bodySmall,
                color = colors.secondaryText,
            )
        }
        TextButton(
            onClick = onCancel,
            enabled = !startBusy,
        ) {
            Text(
                text = stringResource(android.R.string.cancel),
                color = colors.primaryText,
            )
        }
    }
}

@Composable
private fun CurrentWorkspaceSection(
    workspace: NewThreadWorkspaceSummary?,
    colors: SidebarColorPalette,
    enabled: Boolean,
    busy: Boolean,
    onStart: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SectionLabel(
            text = stringResource(R.string.sidebar_project_picker_current_workspace),
            colors = colors,
        )
        if (workspace == null) {
            Text(
                text = stringResource(R.string.sidebar_project_picker_browse_empty),
                style = MaterialTheme.typography.bodySmall,
                color = colors.secondaryText,
            )
        } else {
            Surface(
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .border(1.dp, colors.border, RoundedCornerShape(12.dp))
                        .clickable(enabled = enabled && !busy, onClick = onStart),
                shape = RoundedCornerShape(12.dp),
                color = colors.selectedRow,
                tonalElevation = 1.dp,
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(11.dp),
                ) {
                    WorkspaceIcon(colors = colors)
                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Text(
                            text = workspace.name,
                            style =
                                MaterialTheme.typography.bodyLarge.copy(
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.SemiBold,
                                ),
                            color = colors.primaryText,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = workspace.path,
                            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
                            color = colors.secondaryText,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = workspace.metadata,
                            style = MaterialTheme.typography.labelMedium.copy(fontSize = 11.sp),
                            color = colors.secondaryText,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (busy) {
                        BusyIndicator(colors = colors)
                    } else {
                        Text(
                            text = stringResource(R.string.sidebar_project_picker_start_here),
                            style = MaterialTheme.typography.labelLarge.copy(fontSize = 12.sp),
                            color = colors.primaryText,
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionTypeSelector(
    selected: NewThreadSessionType,
    colors: SidebarColorPalette,
    cloudBusy: Boolean,
    enabled: Boolean,
    onSelected: (NewThreadSessionType) -> Unit,
    onStartCloud: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SectionLabel(
            text = stringResource(R.string.sidebar_project_picker_session_type),
            colors = colors,
        )
        Row(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .border(1.dp, colors.border, RoundedCornerShape(10.dp))
                    .background(colors.surface)
                    .padding(3.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            SessionTypeSegment(
                text = stringResource(R.string.sidebar_project_picker_session_local),
                selected = selected == NewThreadSessionType.LocalWorkspace,
                colors = colors,
                enabled = enabled,
                onClick = { onSelected(NewThreadSessionType.LocalWorkspace) },
                modifier = Modifier.weight(1f),
            )
            SessionTypeSegment(
                text = stringResource(R.string.sidebar_project_picker_session_cloud),
                selected = selected == NewThreadSessionType.CloudOnly,
                colors = colors,
                enabled = enabled,
                onClick = { onSelected(NewThreadSessionType.CloudOnly) },
                modifier = Modifier.weight(1f),
            )
        }
        if (selected == NewThreadSessionType.CloudOnly) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = stringResource(R.string.sidebar_project_picker_no_project_desc),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.secondaryText,
                )
                TextButton(
                    onClick = onStartCloud,
                    enabled = enabled && !cloudBusy,
                ) {
                    if (cloudBusy) {
                        BusyIndicator(colors = colors)
                    } else {
                        Text(
                            text = stringResource(R.string.sidebar_project_picker_start_cloud),
                            color = colors.primaryText,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionTypeSegment(
    text: String,
    selected: Boolean,
    colors: SidebarColorPalette,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier =
            modifier
                .height(34.dp)
                .clip(RoundedCornerShape(8.dp))
                .clickable(enabled = enabled, onClick = onClick),
        shape = RoundedCornerShape(8.dp),
        color = if (selected) colors.selectedRow else Color.Transparent,
    ) {
        Box(
            modifier = Modifier.fillMaxWidth(),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = text,
                style =
                    MaterialTheme.typography.labelLarge.copy(
                        fontSize = 12.sp,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                    ),
                color = if (selected) colors.primaryText else colors.secondaryText,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun BrowseWorkspaceSection(
    currentPath: String,
    parentPath: String?,
    quickLocations: List<CodexProjectLocation>,
    query: String,
    colors: SidebarColorPalette,
    enabled: Boolean,
    onQueryChange: (String) -> Unit,
    onQuickLocation: (CodexProjectLocation) -> Unit,
    onParent: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SectionLabel(
                text = stringResource(R.string.sidebar_project_picker_browse_title),
                colors = colors,
                modifier = Modifier.weight(1f),
            )
            IconButton(
                onClick = {
                    parentPath?.let(onParent)
                },
                enabled = enabled && parentPath != null,
                modifier = Modifier.size(32.dp),
            ) {
                Icon(
                    imageVector = Icons.Outlined.ArrowUpward,
                    contentDescription = stringResource(R.string.sidebar_project_picker_parent_cd),
                    tint = colors.secondaryText,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        Text(
            text = currentPath.ifBlank { stringResource(R.string.sidebar_project_picker_browse_empty) },
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
            color = colors.secondaryText,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        SidebarSearchField(
            query = query,
            onQueryChange = onQueryChange,
            placeholderText = stringResource(R.string.sidebar_project_picker_search_hint),
        )
        if (quickLocations.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                quickLocations.forEach { location ->
                    QuickLocationChip(
                        text = location.label,
                        colors = colors,
                        enabled = enabled,
                        onClick = { onQuickLocation(location) },
                    )
                }
            }
        }
    }
}

@Composable
private fun QuickLocationChip(
    text: String,
    colors: SidebarColorPalette,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier =
            modifier
                .clip(RoundedCornerShape(14.dp))
                .border(1.dp, colors.border, RoundedCornerShape(14.dp))
                .clickable(enabled = enabled, onClick = onClick),
        shape = RoundedCornerShape(14.dp),
        color = colors.surface,
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 11.dp, vertical = 6.dp),
            style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.sp),
            color = colors.secondaryText,
            maxLines = 1,
        )
    }
}

@Composable
private fun WorkspaceRow(
    workspace: NewThreadWorkspaceSummary,
    colors: SidebarColorPalette,
    enabled: Boolean,
    busy: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier =
            modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                .clickable(enabled = enabled && !busy, onClick = onClick),
        shape = RoundedCornerShape(10.dp),
        color = colors.surface,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            WorkspaceIcon(colors = colors)
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = workspace.name,
                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp),
                    color = colors.primaryText,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = workspace.metadata,
                    style = MaterialTheme.typography.labelMedium.copy(fontSize = 11.sp),
                    color = colors.secondaryText,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (busy) {
                BusyIndicator(colors = colors)
            } else {
                workspace.relativeTime?.let { relative ->
                    Text(
                        text = relative,
                        style = MaterialTheme.typography.labelMedium.copy(fontSize = 11.sp),
                        color = colors.mutedText,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun FolderRow(
    entry: CodexProjectDirectoryEntry,
    colors: SidebarColorPalette,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier) {
        Row(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(enabled = enabled, onClick = onClick)
                    .padding(horizontal = 8.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                imageVector = Icons.Outlined.Folder,
                contentDescription = null,
                tint = colors.secondaryText,
                modifier = Modifier.size(19.dp),
            )
            Text(
                text = entry.name,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp),
                color = colors.primaryText,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = colors.mutedText,
                modifier = Modifier.size(17.dp),
            )
        }
        HorizontalDivider(
            color = colors.border,
            thickness = 0.5.dp,
            modifier = Modifier.padding(start = 37.dp),
        )
    }
}

@Composable
private fun CreateFolderField(
    value: String,
    colors: SidebarColorPalette,
    enabled: Boolean,
    busy: Boolean,
    onValueChange: (String) -> Unit,
    onCreate: () -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        modifier = modifier.fillMaxWidth(),
        singleLine = true,
        textStyle = MaterialTheme.typography.bodySmall.copy(color = colors.primaryText),
        shape = RoundedCornerShape(12.dp),
        label = {
            Text(
                text = stringResource(R.string.sidebar_project_picker_create_label),
                color = colors.secondaryText,
            )
        },
        placeholder = {
            Text(
                text = stringResource(R.string.sidebar_project_picker_create_placeholder),
                color = colors.mutedText,
            )
        },
        trailingIcon = {
            IconButton(
                onClick = onCreate,
                enabled = enabled && value.trim().isNotEmpty(),
            ) {
                if (busy) {
                    BusyIndicator(colors = colors)
                } else {
                    Icon(
                        imageVector = Icons.Outlined.CreateNewFolder,
                        contentDescription = stringResource(R.string.sidebar_project_picker_create_cd),
                        tint = colors.secondaryText,
                    )
                }
            }
        },
        colors =
            OutlinedTextFieldDefaults.colors(
                focusedBorderColor = colors.border,
                unfocusedBorderColor = colors.border,
                disabledBorderColor = colors.border,
                cursorColor = colors.primaryText,
                focusedTextColor = colors.primaryText,
                unfocusedTextColor = colors.primaryText,
                focusedContainerColor = colors.surface,
                unfocusedContainerColor = colors.surface,
                disabledContainerColor = colors.surface,
            ),
    )
}

@Composable
private fun StartSelectedFolderRow(
    path: String,
    colors: SidebarColorPalette,
    enabled: Boolean,
    busy: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier =
            modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .border(1.dp, colors.border, RoundedCornerShape(12.dp))
                .clickable(enabled = enabled && !busy, onClick = onClick),
        shape = RoundedCornerShape(12.dp),
        color = colors.surface,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (busy) {
                BusyIndicator(colors = colors)
            } else {
                Icon(
                    imageVector = Icons.Filled.Add,
                    contentDescription = null,
                    tint = colors.primaryText,
                    modifier = Modifier.size(18.dp),
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = stringResource(R.string.sidebar_project_picker_start_selected),
                    style = MaterialTheme.typography.labelLarge.copy(fontSize = 12.sp),
                    color = colors.primaryText,
                )
                Text(
                    text = path,
                    style = MaterialTheme.typography.labelMedium.copy(fontSize = 11.sp),
                    color = colors.secondaryText,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun SectionLabel(
    text: String,
    colors: SidebarColorPalette,
    modifier: Modifier = Modifier,
    actionText: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = text,
            modifier = Modifier.weight(1f),
            style =
                MaterialTheme.typography.labelLarge.copy(
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.sp,
                ),
            color = colors.mutedText,
            maxLines = 1,
        )
        if (actionText != null && onAction != null) {
            TextButton(
                onClick = onAction,
                contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
            ) {
                Text(
                    text = actionText,
                    style = MaterialTheme.typography.labelMedium.copy(fontSize = 11.sp),
                    color = colors.secondaryText,
                )
            }
        }
    }
}

@Composable
private fun WorkspaceIcon(
    colors: SidebarColorPalette,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.size(32.dp),
        shape = RoundedCornerShape(8.dp),
        color = colors.background,
        border = androidx.compose.foundation.BorderStroke(1.dp, colors.border),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                imageVector = Icons.Outlined.Computer,
                contentDescription = null,
                tint = colors.secondaryText,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun BusyIndicator(
    colors: SidebarColorPalette,
    modifier: Modifier = Modifier,
) {
    CircularProgressIndicator(
        modifier = modifier.size(18.dp),
        strokeWidth = 2.dp,
        color = colors.primaryText,
        trackColor = colors.border,
    )
}

private fun currentWorkspaceSummary(
    path: String,
    threads: List<CodexThread>,
    activeThreadId: String?,
    activeChatMetadata: SidebarActiveChatMetadata?,
): NewThreadWorkspaceSummary? {
    val normalized = CodexThread.normalizeProjectPath(path) ?: return null
    val activeThread = activeThreadId?.let { id -> threads.firstOrNull { it.id == id } }
    val branch =
        if (activeThread?.normalizedProjectPath == normalized) {
            activeChatMetadata?.branch?.trim()?.takeIf { it.isNotEmpty() }
                ?: activeThread.workspaceBranch()
        } else {
            threads.firstOrNull { it.normalizedProjectPath == normalized }?.workspaceBranch()
        }
    return NewThreadWorkspaceSummary(
        name = projectDisplayLabelFor(normalized),
        path = normalized,
        metadata = workspaceMetadata(branch),
    )
}

private fun recentWorkspaceSummaries(
    threads: List<CodexThread>,
    currentPath: String,
): List<NewThreadWorkspaceSummary> {
    val normalizedCurrent = CodexThread.normalizeProjectPath(currentPath)
    return threads
        .filter { it.normalizedProjectPath != null && it.normalizedProjectPath != normalizedCurrent }
        .groupBy { it.normalizedProjectPath.orEmpty() }
        .mapNotNull { (path, workspaceThreads) ->
            val representative =
                workspaceThreads.maxWithOrNull(
                    compareBy<CodexThread> { it.updatedAt ?: it.createdAt ?: Instant.EPOCH }
                        .thenBy { it.id },
                ) ?: return@mapNotNull null
            NewThreadWorkspaceSummary(
                name = projectDisplayLabelFor(path),
                path = path,
                metadata = workspaceMetadata(representative.workspaceBranch()),
                relativeTime = SidebarRelativeTimeFormatter.compactLabel(representative),
            )
        }.sortedWith(
            compareByDescending<NewThreadWorkspaceSummary> { summary ->
                threads
                    .filter { it.normalizedProjectPath == summary.path }
                    .maxOfOrNull { it.updatedAt ?: it.createdAt ?: Instant.EPOCH }
                    ?: Instant.EPOCH
            }.thenBy { it.name.lowercase() },
        )
}

private fun workspaceMetadata(branch: String?): String = listOfNotNull(branch?.trim()?.takeIf { it.isNotEmpty() }, "Local").joinToString(" · ")

private fun CodexThread.workspaceBranch(): String? =
    firstMetadataString(
        "branch",
        "current",
        "currentBranch",
        "current_branch",
        "gitBranch",
        "git_branch",
        "headBranch",
        "head_branch",
    )

private fun CodexThread.firstMetadataString(vararg keys: String): String? {
    val meta = metadata ?: return null
    return keys.firstNotNullOfOrNull { key ->
        meta[key]?.stringValue?.trim()?.takeIf { it.isNotEmpty() }
    }
}

private fun List<CodexProjectDirectoryEntry>.sortedForWorkspacePicker(): List<CodexProjectDirectoryEntry> =
    sortedWith(
        compareBy<CodexProjectDirectoryEntry> { entry ->
            when (entry.name.lowercase()) {
                "android" -> 0
                "android-relay" -> 1
                else -> 2
            }
        }.thenBy { it.name.lowercase() }.thenBy { it.path },
    )

private fun List<CodexProjectLocation>.preferredQuickLocations(): List<CodexProjectLocation> {
    val wanted = listOf("home", "desktop", "documents")
    return mapNotNull { location ->
        val key =
            location.id.lowercase().takeIf { it in wanted }
                ?: location.label.lowercase().takeIf { it in wanted }
        key?.let { wanted.indexOf(it) to location }
    }.sortedBy { it.first }
        .map { it.second }
}
