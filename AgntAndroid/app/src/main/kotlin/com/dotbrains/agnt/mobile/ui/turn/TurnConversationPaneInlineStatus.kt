package com.dotbrains.agnt.mobile.ui.turn

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.core.model.CodexImageAttachment
import com.dotbrains.agnt.mobile.data.QueuedTurnDraftPreview
import com.dotbrains.agnt.mobile.ui.home.RootReconnectRecoveryAction
import com.dotbrains.agnt.mobile.ui.home.RootReconnectUiState
import com.dotbrains.agnt.mobile.ui.turn.attachments.TurnComposerAttachment
import com.dotbrains.agnt.mobile.ui.turn.attachments.TurnComposerAttachmentState
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.restoreMentionChips
import com.dotbrains.agnt.mobile.ui.turn.autocomplete.stripMergedMentionPrefix
import com.dotbrains.agnt.mobile.ui.turn.composer.ComposerMentionChipPayload
import com.dotbrains.agnt.mobile.ui.turn.recovery.TurnConnectionRecoveryCard
import com.dotbrains.agnt.mobile.ui.turn.recovery.TurnConnectionRecoverySnapshot
import com.dotbrains.agnt.mobile.ui.turn.toolbar.QueuedDraftsCard
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

@Composable
internal fun TurnConversationPaneInlineStatus(
    lastError: String?,
    gitBranchCheckoutError: String?,
    worktreeHandoffError: String?,
    inlineUndoError: String?,
    connectionRecoverySnapshot: TurnConnectionRecoverySnapshot?,
    reconnectUiState: RootReconnectUiState,
    onOpenPairingScanner: () -> Unit,
    onWakeSavedComputer: () -> Unit,
    onReconnectSavedPairing: () -> Unit,
) {
    listOfNotNull(
        lastError,
        gitBranchCheckoutError,
        worktreeHandoffError,
        inlineUndoError,
    ).forEach { err ->
        Text(
            text = err,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
    connectionRecoverySnapshot?.let { snapshot ->
        TurnConnectionRecoveryCard(
            snapshot = snapshot,
            onTap = {
                when {
                    reconnectUiState.recoveryAction == RootReconnectRecoveryAction.ScanNewQr -> onOpenPairingScanner()
                    reconnectUiState.wakeDisplayAvailable -> onWakeSavedComputer()
                    else -> onReconnectSavedPairing()
                }
            },
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
}

@Composable
internal fun TurnConversationPaneQueuedDrafts(
    threadId: String,
    repository: com.dotbrains.agnt.mobile.data.CodexRepository,
    scope: CoroutineScope,
    queuedDraftPreviews: List<QueuedTurnDraftPreview>,
    queuedDraftCount: Int,
    canRestoreQueuedDrafts: Boolean,
    maxComposerAttachments: Int,
    attachmentOverflowMessage: String,
    queuedDraftRestoreBlockedMessage: String,
    setLastError: (String) -> Unit,
    setMentionChips: (List<ComposerMentionChipPayload>) -> Unit,
    setDraft: (String) -> Unit,
    setComposerAttachments: (List<TurnComposerAttachment>) -> Unit,
) {
    if (queuedDraftCount <= 0) return
    QueuedDraftsCard(
        previews = queuedDraftPreviews,
        totalCount = queuedDraftCount,
        canRestore = canRestoreQueuedDrafts,
        onRestore = { draftId ->
            scope.launch {
                if (!canRestoreQueuedDrafts) {
                    setLastError(queuedDraftRestoreBlockedMessage)
                    return@launch
                }
                val restored =
                    runCatching { repository.removeQueuedTurnDraft(threadId, draftId) }
                        .getOrNull()
                        ?: return@launch
                setMentionChips(
                    restoreMentionChips(
                        skillMentions = restored.skillMentions,
                        fileMentions = restored.fileMentions,
                    ),
                )
                setDraft(
                    stripMergedMentionPrefix(
                        text = restored.text,
                        skillMentions = restored.skillMentions,
                        fileMentions = restored.fileMentions,
                    ),
                )
                setComposerAttachments(restored.attachments.toComposerAttachments(maxComposerAttachments))
                if (restored.attachments.size > maxComposerAttachments) {
                    setLastError(attachmentOverflowMessage)
                }
            }
        },
        onRemove = { draftId ->
            scope.launch {
                runCatching { repository.removeQueuedTurnDraft(threadId, draftId) }
            }
        },
        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

private fun List<CodexImageAttachment>.toComposerAttachments(maxComposerAttachments: Int): List<TurnComposerAttachment> =
    take(maxComposerAttachments).map {
        TurnComposerAttachment(
            state = TurnComposerAttachmentState.ReadyImage(it),
        )
    }
