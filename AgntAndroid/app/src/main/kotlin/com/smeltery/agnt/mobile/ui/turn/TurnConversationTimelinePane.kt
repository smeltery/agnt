package com.smeltery.agnt.mobile.ui.turn

import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.smeltery.agnt.mobile.core.model.AIChangeSet
import com.smeltery.agnt.mobile.core.model.CodexMessage
import com.smeltery.agnt.mobile.core.model.CommandExecutionDetails
import com.smeltery.agnt.mobile.ui.agent.MessageList
import com.smeltery.agnt.mobile.ui.turn.timeline.SmartScrollNavigationCta
import com.smeltery.agnt.mobile.ui.turn.timeline.SmartScrollNavigationState

@Composable
internal fun BoxScope.TurnConversationTimelinePane(
    messages: List<CodexMessage>,
    listState: LazyListState,
    commandExecutionDetailsByItemId: Map<String, CommandExecutionDetails>,
    isAssistantTurnActive: Boolean,
    activeTurnId: String?,
    hiddenEarlierCount: Int,
    canLoadOlderRemoteHistory: Boolean,
    isLoadingOlderHistory: Boolean,
    olderHistoryError: String?,
    contentTopPadding: Dp,
    timelineBlurRadius: Dp,
    timelineContentAlpha: Float,
    smartScrollNavigationState: SmartScrollNavigationState,
    assistantUndoChangeSetsByMessageId: Map<String, AIChangeSet>,
    applyingUndoChangeSetIds: Set<String>,
    forkThreadEnabled: Boolean,
    onOpenFullMessage: (CodexMessage) -> Unit,
    onLoadEarlierMessages: (() -> Unit)?,
    onUndoAssistantChanges: (AIChangeSet) -> Unit,
    onForkThread: () -> Unit,
    onSmartScrollNavigate: (Int) -> Unit,
) {
    MessageList(
        messages = messages,
        listState = listState,
        commandExecutionDetailsByItemId = commandExecutionDetailsByItemId,
        onOpenFullMessage = onOpenFullMessage,
        isAssistantTurnActive = isAssistantTurnActive,
        activeTurnId = activeTurnId,
        hiddenEarlierCount = hiddenEarlierCount,
        canLoadOlderRemoteHistory = canLoadOlderRemoteHistory,
        isLoadingOlderHistory = isLoadingOlderHistory,
        olderHistoryError = olderHistoryError,
        contentPadding =
            PaddingValues(
                top = contentTopPadding,
                bottom = 18.dp,
                start = 2.dp,
                end = 2.dp,
            ),
        onLoadEarlierMessages = onLoadEarlierMessages,
        assistantUndoChangeSetsByMessageId = assistantUndoChangeSetsByMessageId,
        applyingUndoChangeSetIds = applyingUndoChangeSetIds,
        onUndoAssistantChanges = onUndoAssistantChanges,
        onForkThread = onForkThread,
        forkThreadEnabled = forkThreadEnabled,
        modifier =
            Modifier
                .fillMaxSize()
                .blur(timelineBlurRadius)
                .alpha(timelineContentAlpha),
    )
    SmartScrollNavigationCta(
        state = smartScrollNavigationState,
        onNavigate = onSmartScrollNavigate,
        modifier =
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 14.dp),
    )
}
