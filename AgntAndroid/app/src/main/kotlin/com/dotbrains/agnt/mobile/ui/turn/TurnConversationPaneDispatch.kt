package com.dotbrains.agnt.mobile.ui.turn

import com.dotbrains.agnt.mobile.core.model.CodexCollaborationModeKind
import com.dotbrains.agnt.mobile.core.model.CodexImageAttachment
import com.dotbrains.agnt.mobile.core.model.CodexTurnMention
import com.dotbrains.agnt.mobile.core.model.CodexTurnSkillMention
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.ui.turn.attachments.TurnComposerAttachment
import com.dotbrains.agnt.mobile.ui.turn.composer.ComposerMentionChipPayload
import com.dotbrains.agnt.mobile.ui.turn.composer.formatTurnSendError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal fun dispatchTurnFromConversationPane(
    text: String,
    attachments: List<CodexImageAttachment>,
    skillMentions: List<CodexTurnSkillMention>,
    fileMentions: List<CodexTurnMention>,
    collaborationMode: CodexCollaborationModeKind?,
    fromQueue: Boolean,
    threadId: String,
    repository: CodexRepository,
    scope: CoroutineScope,
    isThreadRunning: Boolean,
    queuedDraftSendFailedMessage: String,
    setSending: (Boolean) -> Unit,
    clearComposer: () -> Unit,
    setLastError: (String?) -> Unit,
) {
    if (
        text.trim().isEmpty() &&
        attachments.isEmpty() &&
        skillMentions.isEmpty() &&
        fileMentions.isEmpty()
    ) {
        return
    }
    if (!fromQueue && isThreadRunning) {
        scope.launch {
            runCatching {
                repository.enqueueTurnDraft(
                    threadId = threadId,
                    text = text,
                    attachments = attachments,
                    skillMentions = skillMentions,
                    fileMentions = fileMentions,
                    collaborationMode = collaborationMode,
                )
            }.onSuccess {
                clearComposer()
            }.onFailure { e ->
                setLastError(formatTurnSendError(e))
            }
        }
        return
    }

    setSending(true)
    scope.launch {
        runCatching {
            repository.startTurn(
                threadId = threadId,
                text = text,
                attachments = attachments,
                skillMentions = skillMentions,
                fileMentions = fileMentions,
                collaborationMode = collaborationMode,
            )
        }.onSuccess {
            setSending(false)
            if (!fromQueue) {
                clearComposer()
            }
        }.onFailure { e ->
            setSending(false)
            if (fromQueue) {
                runCatching {
                    repository.enqueueTurnDraft(
                        threadId = threadId,
                        text = text,
                        attachments = attachments,
                        skillMentions = skillMentions,
                        fileMentions = fileMentions,
                        collaborationMode = collaborationMode,
                        prepend = true,
                    )
                }
                setLastError("$queuedDraftSendFailedMessage: ${formatTurnSendError(e)}")
            } else {
                setLastError(formatTurnSendError(e))
            }
        }
    }
}

internal fun stopTurnFromConversationPane(
    threadId: String,
    activeTurnId: String?,
    repository: CodexRepository,
    scope: CoroutineScope,
    setLastError: (String?) -> Unit,
) {
    scope.launch {
        runCatching {
            repository.interruptTurn(
                threadId = threadId,
                turnId = activeTurnId,
            )
        }.onFailure { e ->
            setLastError(formatTurnSendError(e))
        }
    }
}

internal fun clearTurnComposerState(
    setDraft: (String) -> Unit,
    setComposerAttachments: (List<TurnComposerAttachment>) -> Unit,
    setMentionChips: (List<ComposerMentionChipPayload>) -> Unit,
) {
    setDraft("")
    setComposerAttachments(emptyList())
    setMentionChips(emptyList())
}
