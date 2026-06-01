package com.dotbrains.agnt.mobile.ui.draft

import com.dotbrains.agnt.mobile.core.model.GitRepoSyncResult

object NewChatDraftLogic {
    fun gitActionsEnabled(
        projectPath: String?,
        isConnected: Boolean,
    ): Boolean = !projectPath.isNullOrBlank() && isConnected

    fun terminalHereHint(projectPath: String?): String? {
        val normalized = projectPath?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return "cd $normalized"
    }

    fun gitStatusSummary(status: GitRepoSyncResult): String {
        if (!status.isRepo) return "No Git repository found."
        val branch = status.currentBranch?.takeIf { it.isNotBlank() } ?: "detached HEAD"
        val changes =
            when {
                !status.isDirty -> "clean"
                status.files.size == 1 -> "1 changed file"
                else -> "${status.files.size} changed files"
            }
        val sync =
            buildList {
                if (status.aheadCount > 0) add("${status.aheadCount} ahead")
                if (status.behindCount > 0) add("${status.behindCount} behind")
            }.joinToString(", ")
        return listOf(branch, changes, sync)
            .filter { it.isNotBlank() }
            .joinToString(" - ")
    }
}
