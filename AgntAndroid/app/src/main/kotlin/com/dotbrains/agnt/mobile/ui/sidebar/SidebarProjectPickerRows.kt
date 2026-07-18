package com.dotbrains.agnt.mobile.ui.sidebar

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.CodexProjectDirectoryEntry

@Composable
fun WorkspaceRow(
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
fun FolderRow(
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
fun CreateFolderField(
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
fun StartSelectedFolderRow(
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
fun SectionLabel(
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
fun WorkspaceIcon(
    colors: SidebarColorPalette,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.size(32.dp),
        shape = RoundedCornerShape(8.dp),
        color = colors.background,
        border = BorderStroke(1.dp, colors.border),
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
fun BusyIndicator(
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
