package com.dotbrains.agnt.mobile.ui.sidebar

import com.dotbrains.agnt.mobile.core.model.GitWorktreeChangeTransferMode

enum class SidebarTopAction {
    NewChat,
    QuickChat,
    NewProject,
}

data class PendingSidebarWorktreeChat(
    val baseProjectPath: String,
    val baseBranch: String,
    val changeTransfer: GitWorktreeChangeTransferMode,
)
