package com.dotbrains.agnt.mobile.ui.sidebar

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import com.dotbrains.agnt.mobile.core.model.CodexProjectLocation

@Composable
fun NewThreadHeader(
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
fun CurrentWorkspaceSection(
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
fun SessionTypeSelector(
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
fun SessionTypeSegment(
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
fun BrowseWorkspaceSection(
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
fun QuickLocationChip(
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
