package com.dotbrains.agnt.mobile.ui.agent

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import com.dotbrains.agnt.mobile.ui.turn.timeline.TurnMessageRow

/** Assistant chat / markdown block (same layout as [TurnMessageRow] for [CodexMessageRole.assistant]). */
@Composable
fun AssistantMessageBlock(
    message: CodexMessage,
    modifier: Modifier = Modifier,
    onOpenFullMessage: ((CodexMessage) -> Unit)? = null,
) {
    if (message.role == CodexMessageRole.assistant) {
        TurnMessageRow(message = message, modifier = modifier, onOpenFullMessage = onOpenFullMessage)
    }
}
