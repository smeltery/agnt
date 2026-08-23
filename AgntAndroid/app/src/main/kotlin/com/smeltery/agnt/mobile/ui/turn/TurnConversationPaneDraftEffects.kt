package com.smeltery.agnt.mobile.ui.turn

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import com.smeltery.agnt.mobile.data.CodexRepository

@Composable
internal fun TurnConversationPaneDraftEffects(
    threadId: String,
    currentTrustedMacDeviceId: String?,
    draft: String,
    loadedDraftKey: String?,
    repository: CodexRepository,
    setDraft: (String) -> Unit,
    setLoadedDraftKey: (String?) -> Unit,
) {
    LaunchedEffect(threadId, currentTrustedMacDeviceId) {
        setDraft(runCatching { repository.loadComposerDraft(threadId) }.getOrDefault(""))
        setLoadedDraftKey("${currentTrustedMacDeviceId.orEmpty()}|$threadId")
    }

    LaunchedEffect(threadId, currentTrustedMacDeviceId, draft, loadedDraftKey) {
        val draftKey = "${currentTrustedMacDeviceId.orEmpty()}|$threadId"
        if (loadedDraftKey == draftKey) {
            runCatching { repository.saveComposerDraft(threadId, draft) }
        }
    }
}
