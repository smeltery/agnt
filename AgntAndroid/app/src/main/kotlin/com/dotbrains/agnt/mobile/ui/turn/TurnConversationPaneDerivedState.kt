package com.dotbrains.agnt.mobile.ui.turn

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import com.dotbrains.agnt.mobile.core.model.CodexReviewTarget
import com.dotbrains.agnt.mobile.core.transport.ConnectionState
import com.dotbrains.agnt.mobile.data.QueuedTurnDraftPreview
import com.dotbrains.agnt.mobile.ui.home.RootReconnectUiState
import com.dotbrains.agnt.mobile.ui.turn.attachments.TurnComposerAttachment
import com.dotbrains.agnt.mobile.ui.turn.composer.ComposerMentionChipPayload
import com.dotbrains.agnt.mobile.ui.turn.recovery.TurnConnectionRecoverySnapshot
import com.dotbrains.agnt.mobile.ui.turn.recovery.TurnConnectionRecoverySnapshotBuilder
import com.dotbrains.agnt.mobile.ui.turn.toolbar.GitBranchPaneState

internal data class TurnConversationPaneDerivedState(
    val isThreadRunning: Boolean,
    val activeTurnId: String?,
    val queuedDraftCount: Int,
    val queuedDraftPreviews: List<QueuedTurnDraftPreview>,
    val hasComposerDraftContent: Boolean,
    val canRestoreQueuedDrafts: Boolean,
    val branchPickerEnabled: Boolean,
    val connectionRecoverySnapshot: TurnConnectionRecoverySnapshot?,
)

@Composable
internal fun rememberTurnConversationPaneDerivedState(
    threadId: String,
    runningTurnByThread: Map<String, String>,
    protectedRunningFallback: Set<String>,
    queuedDraftDepthByThread: Map<String, Int>,
    queuedDraftPreviewByThread: Map<String, List<QueuedTurnDraftPreview>>,
    draft: String,
    composerAttachments: List<TurnComposerAttachment>,
    mentionChips: List<ComposerMentionChipPayload>,
    isPlanModeEnabled: Boolean,
    reviewTarget: CodexReviewTarget?,
    sending: Boolean,
    gitCwd: String?,
    connectionState: ConnectionState,
    ready: Boolean,
    isSwitchingGitBranch: Boolean,
    isHandingOffWorktree: Boolean,
    gitBranchPaneState: GitBranchPaneState,
    reconnectUiState: RootReconnectUiState,
): TurnConversationPaneDerivedState {
    val isThreadRunning =
        remember(threadId, runningTurnByThread, protectedRunningFallback) {
            runningTurnByThread.containsKey(threadId) || protectedRunningFallback.contains(threadId)
        }
    val hasComposerDraftContent =
        remember(draft, composerAttachments, mentionChips, isPlanModeEnabled, reviewTarget) {
            draft.trim().isNotEmpty() ||
                composerAttachments.isNotEmpty() ||
                mentionChips.isNotEmpty() ||
                isPlanModeEnabled ||
                reviewTarget != null
        }
    return TurnConversationPaneDerivedState(
        isThreadRunning = isThreadRunning,
        activeTurnId = remember(threadId, runningTurnByThread) { runningTurnByThread[threadId] },
        queuedDraftCount = remember(threadId, queuedDraftDepthByThread) { queuedDraftDepthByThread[threadId] ?: 0 },
        queuedDraftPreviews = remember(threadId, queuedDraftPreviewByThread) { queuedDraftPreviewByThread[threadId].orEmpty() },
        hasComposerDraftContent = hasComposerDraftContent,
        canRestoreQueuedDrafts = remember(isThreadRunning, sending, hasComposerDraftContent) { !isThreadRunning && !sending && !hasComposerDraftContent },
        branchPickerEnabled =
            remember(gitCwd, connectionState, ready, isThreadRunning, sending, isSwitchingGitBranch, isHandingOffWorktree, gitBranchPaneState) {
                gitCwd != null &&
                    connectionState is ConnectionState.Connected &&
                    ready &&
                    !isThreadRunning &&
                    !sending &&
                    !isSwitchingGitBranch &&
                    !isHandingOffWorktree &&
                    gitBranchPaneState is GitBranchPaneState.Loaded
            },
        connectionRecoverySnapshot =
            remember(connectionState, reconnectUiState) {
                TurnConnectionRecoverySnapshotBuilder.makeSnapshot(
                    hasReconnectCandidate = true,
                    connectionState = connectionState,
                    reconnectUiState = reconnectUiState,
                )
            },
    )
}
