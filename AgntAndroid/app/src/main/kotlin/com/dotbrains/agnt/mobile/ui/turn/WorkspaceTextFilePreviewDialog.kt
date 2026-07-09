package com.dotbrains.agnt.mobile.ui.turn

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.services.workspace.WorkspaceTextFileService
import com.dotbrains.agnt.mobile.ui.theme.AgntModalBottomSheet

data class WorkspaceTextFilePreviewRequest(
    val path: String,
    val cwd: String?,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceTextFilePreviewDialog(
    request: WorkspaceTextFilePreviewRequest,
    service: WorkspaceTextFileService,
    onDismiss: () -> Unit,
) {
    var reloadKey by remember(request) { mutableStateOf(0) }
    var preview by remember(request) { mutableStateOf<WorkspaceTextFileService.TextPreview?>(null) }
    var errorMessage by remember(request) { mutableStateOf<String?>(null) }
    var isLoading by remember(request) { mutableStateOf(true) }

    LaunchedEffect(request, reloadKey) {
        isLoading = true
        errorMessage = null
        runCatching { service.readPreview(request.path, request.cwd) }
            .onSuccess { preview = it }
            .onFailure { error -> errorMessage = error.message ?: "Could not load file preview." }
        isLoading = false
    }

    AgntModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .fillMaxHeight(0.88f)
                    .padding(horizontal = 18.dp)
                    .padding(bottom = 26.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val title =
                preview?.metadata?.fileName?.takeIf { it.isNotBlank() }
                    ?: stringResource(R.string.workspace_text_preview_title)
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.turn_preview_close)) }
            }
            when {
                isLoading ->
                    Box(Modifier.fillMaxWidth().heightIn(min = 220.dp), Alignment.Center) { CircularProgressIndicator() }
                errorMessage != null -> {
                    Text(
                        errorMessage ?: stringResource(R.string.workspace_text_preview_error),
                        color = MaterialTheme.colorScheme.error,
                    )
                    TextButton(onClick = { reloadKey++ }) { Text(stringResource(R.string.workspace_text_preview_retry)) }
                }
                preview != null -> {
                    val data = checkNotNull(preview)
                    Text(
                        data.metadata.path.ifBlank { request.path },
                        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        previewMetadataLabel(data),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Surface(
                        Modifier.fillMaxWidth().weight(1f),
                        shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.58f),
                    ) {
                        if (data.isSvgPreview(request.path)) {
                            WorkspaceSvgPreview(
                                source = data.content,
                                isDark = isSystemInDarkTheme(),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        } else {
                            WorkspaceCodePreview(
                                content = data.content,
                                fileName = data.metadata.path.ifBlank { request.path },
                                modifier = Modifier.verticalScroll(rememberScrollState()),
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun WorkspaceTextFileService.TextPreview.isSvgPreview(requestPath: String): Boolean = WorkspaceSvgPreviewSecurity.isSvgPath(metadata.path.ifBlank { requestPath })

private fun previewMetadataLabel(data: WorkspaceTextFileService.TextPreview): String {
    val parts = mutableListOf(formatByteCount(data.metadata.byteLength))
    data.lineCount?.let { parts.add("$it lines") }
    data.metadata.encoding
        .takeIf { it.isNotBlank() }
        ?.let { parts.add(it) }
    if (data.fromCache) parts.add("cached")
    return parts.joinToString(" | ")
}

private fun formatByteCount(bytes: Long): String =
    when {
        bytes >= 1024L * 1024L -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
        bytes >= 1024L -> "%.1f KB".format(bytes / 1024.0)
        else -> "$bytes B"
    }
