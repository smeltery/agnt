package com.dotbrains.agnt.mobile.ui.draft

import java.util.UUID

enum class NewChatDraftSource {
    generalChat,
    folderChat,
    ;

    val isFromGeneralChat: Boolean
        get() = this == generalChat
}

data class NewChatDraftRoute(
    val id: String,
    val source: NewChatDraftSource,
    val preferredProjectPath: String? = null,
) {
    companion object {
        fun create(
            source: NewChatDraftSource,
            preferredProjectPath: String? = null,
        ): NewChatDraftRoute =
            NewChatDraftRoute(
                id = "new-chat-draft-${UUID.randomUUID()}",
                source = source,
                preferredProjectPath = preferredProjectPath?.trim()?.takeIf { it.isNotEmpty() },
            )
    }
}
