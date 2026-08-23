package com.smeltery.agnt.mobile.core.shortcut

import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.core.model.CodexThreadSyncState

sealed interface AgntShortcutAction {
    data object NewChat : AgntShortcutAction

    data class OpenThread(
        val threadId: String,
    ) : AgntShortcutAction
}

data class AgntShortcutItem(
    val id: String,
    val shortLabel: String,
    val longLabel: String,
    val subtitle: String?,
    val action: AgntShortcutAction,
)

object AgntShortcutCatalog {
    const val ACTION_SHORTCUT = "com.smeltery.agnt.mobile.action.SHORTCUT"
    const val EXTRA_ACTION = "com.smeltery.agnt.mobile.extra.SHORTCUT_ACTION"
    const val EXTRA_THREAD_ID = "com.smeltery.agnt.mobile.extra.THREAD_ID"
    const val ACTION_NEW_CHAT = "new_chat"
    const val ACTION_OPEN_THREAD = "open_thread"

    private const val SHORT_LABEL_MAX = 18

    fun dynamicShortcuts(threads: List<CodexThread>): List<AgntShortcutItem> {
        val recentThreads =
            threads
                .asSequence()
                .filter { it.syncState == CodexThreadSyncState.live }
                .filter { it.id.trim().isNotEmpty() }
                .take(2)
                .map { thread ->
                    val title = thread.displayTitle.trim().ifEmpty { CodexThread.DEFAULT_DISPLAY_TITLE }
                    AgntShortcutItem(
                        id = "thread:${thread.id.trim()}",
                        shortLabel = title.shortcutLabel(),
                        longLabel = title,
                        subtitle = thread.projectShortcutSubtitle(),
                        action = AgntShortcutAction.OpenThread(thread.id.trim()),
                    )
                }.toList()

        val base =
            listOf(
                AgntShortcutItem(
                    id = "new-chat",
                    shortLabel = "New Chat",
                    longLabel = "New Chat",
                    subtitle = null,
                    action = AgntShortcutAction.NewChat,
                ),
            )
        return base + recentThreads
    }

    fun actionFromIntentExtras(
        action: String?,
        threadId: String?,
    ): AgntShortcutAction? =
        when (action) {
            ACTION_NEW_CHAT -> AgntShortcutAction.NewChat
            ACTION_OPEN_THREAD ->
                threadId
                    ?.trim()
                    ?.takeIf { it.isNotEmpty() }
                    ?.let(AgntShortcutAction::OpenThread)
            else -> null
        }

    private fun CodexThread.projectShortcutSubtitle(): String {
        val project = projectDisplayName.trim()
        return if (project.isNotEmpty() && project != "No Project") project else "Chats"
    }

    private fun String.shortcutLabel(): String {
        val normalized = trim().replace(Regex("\\s+"), " ")
        if (normalized.length <= SHORT_LABEL_MAX) return normalized
        return normalized.take(SHORT_LABEL_MAX - 1).trimEnd() + "…"
    }
}
