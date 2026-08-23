package com.smeltery.agnt.mobile.ui.turn

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import com.smeltery.agnt.mobile.core.model.CodexCollaborationModeKind
import com.smeltery.agnt.mobile.core.model.CodexImageAttachment
import com.smeltery.agnt.mobile.core.model.CodexTurnMention
import com.smeltery.agnt.mobile.core.model.CodexTurnSkillMention
import com.smeltery.agnt.mobile.data.CodexRepository
import com.smeltery.agnt.mobile.ui.turn.attachments.TurnComposerAttachment
import com.smeltery.agnt.mobile.ui.turn.composer.ComposerMentionChipPayload
import kotlinx.coroutines.CoroutineScope

internal data class TurnConversationPaneTurnActions(
    val dispatchTurn: (
        text: String,
        attachments: List<CodexImageAttachment>,
        skillMentions: List<CodexTurnSkillMention>,
        fileMentions: List<CodexTurnMention>,
        collaborationMode: CodexCollaborationModeKind?,
        fromQueue: Boolean,
    ) -> Unit,
    val stopActiveTurn: () -> Unit,
)

@Composable
internal fun rememberTurnConversationPaneTurnActions(
    threadId: String,
    repository: CodexRepository,
    scope: CoroutineScope,
    isThreadRunning: Boolean,
    activeTurnId: String?,
    queuedDraftCount: Int,
    hasComposerDraftContent: Boolean,
    sending: Boolean,
    queuedDraftSendFailedMessage: String,
    setSending: (Boolean) -> Unit,
    setDraft: (String) -> Unit,
    setComposerAttachments: (List<TurnComposerAttachment>) -> Unit,
    setMentionChips: (List<ComposerMentionChipPayload>) -> Unit,
    setLastError: (String?) -> Unit,
): TurnConversationPaneTurnActions {
    val dispatchTurn =
        remember(threadId, repository, scope, isThreadRunning, queuedDraftSendFailedMessage) {
            {
                text: String,
                attachments: List<CodexImageAttachment>,
                skillMentions: List<CodexTurnSkillMention>,
                fileMentions: List<CodexTurnMention>,
                collaborationMode: CodexCollaborationModeKind?,
                fromQueue: Boolean,
                ->
                dispatchTurnFromConversationPane(
                    text = text,
                    attachments = attachments,
                    skillMentions = skillMentions,
                    fileMentions = fileMentions,
                    collaborationMode = collaborationMode,
                    fromQueue = fromQueue,
                    threadId = threadId,
                    repository = repository,
                    scope = scope,
                    isThreadRunning = isThreadRunning,
                    queuedDraftSendFailedMessage = queuedDraftSendFailedMessage,
                    setSending = setSending,
                    clearComposer = {
                        clearTurnComposerState(
                            setDraft = setDraft,
                            setComposerAttachments = setComposerAttachments,
                            setMentionChips = setMentionChips,
                        )
                    },
                    setLastError = setLastError,
                )
            }
        }
    LaunchedEffect(threadId, isThreadRunning, sending, queuedDraftCount, hasComposerDraftContent, dispatchTurn) {
        if (isThreadRunning || sending || queuedDraftCount <= 0 || hasComposerDraftContent) return@LaunchedEffect
        val queued = runCatching { repository.pollTurnDraft(threadId) }.getOrNull() ?: return@LaunchedEffect
        dispatchTurn(queued.text, queued.attachments, queued.skillMentions, queued.fileMentions, queued.collaborationMode, true)
    }
    return TurnConversationPaneTurnActions(
        dispatchTurn = dispatchTurn,
        stopActiveTurn = {
            stopTurnFromConversationPane(
                threadId = threadId,
                activeTurnId = activeTurnId,
                repository = repository,
                scope = scope,
                setLastError = setLastError,
            )
        },
    )
}
