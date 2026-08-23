package com.smeltery.agnt.mobile.ui.agent

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.smeltery.agnt.mobile.core.model.CodexMessage
import com.smeltery.agnt.mobile.core.model.CodexMessageRole
import com.smeltery.agnt.mobile.ui.turn.timeline.TurnMessageRow

/** User-authored bubble in the timeline (same layout as [TurnMessageRow] for [CodexMessageRole.user]). */
@Composable
fun UserMessageBubble(
    message: CodexMessage,
    modifier: Modifier = Modifier,
    onOpenFullMessage: ((CodexMessage) -> Unit)? = null,
) {
    if (message.role == CodexMessageRole.user) {
        TurnMessageRow(message = message, modifier = modifier, onOpenFullMessage = onOpenFullMessage)
    }
}
