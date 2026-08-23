package com.smeltery.agnt.mobile.ui.sidebar

import com.smeltery.agnt.mobile.core.model.CodexProjectDirectoryEntry
import com.smeltery.agnt.mobile.core.model.CodexProjectLocation
import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.core.model.projectDisplayLabelFor
import java.time.Instant

enum class NewThreadSessionType {
    LocalWorkspace,
    CloudOnly,
}

data class NewThreadWorkspaceSummary(
    val name: String,
    val path: String,
    val metadata: String,
    val relativeTime: String? = null,
)

fun currentWorkspaceSummary(
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

fun recentWorkspaceSummaries(
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

fun workspaceMetadata(branch: String?): String = listOfNotNull(branch?.trim()?.takeIf { it.isNotEmpty() }, "Local").joinToString(" · ")

fun CodexThread.workspaceBranch(): String? =
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

fun List<CodexProjectDirectoryEntry>.sortedForWorkspacePicker(): List<CodexProjectDirectoryEntry> =
    sortedWith(
        compareBy<CodexProjectDirectoryEntry> { entry ->
            when (entry.name.lowercase()) {
                "android" -> 0
                "android-relay" -> 1
                else -> 2
            }
        }.thenBy { it.name.lowercase() }.thenBy { it.path },
    )

fun List<CodexProjectLocation>.preferredQuickLocations(): List<CodexProjectLocation> {
    val wanted = listOf("home", "desktop", "documents")
    return mapNotNull { location ->
        val key =
            location.id.lowercase().takeIf { it in wanted }
                ?: location.label.lowercase().takeIf { it in wanted }
        key?.let { wanted.indexOf(it) to location }
    }.sortedBy { it.first }
        .map { it.second }
}
