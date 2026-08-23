package com.smeltery.agnt.mobile.ui.agent

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.smeltery.agnt.mobile.core.model.CodexMessage
import com.smeltery.agnt.mobile.ui.turn.diff.TurnFileChangeDetailCard

/**
 * System row summarizing file edits / diff preview in the timeline.
 */
@Composable
fun FileEditRow(
    message: CodexMessage,
    modifier: Modifier = Modifier,
) {
    TurnFileChangeDetailCard(
        message = message,
        modifier = modifier,
    )
}
