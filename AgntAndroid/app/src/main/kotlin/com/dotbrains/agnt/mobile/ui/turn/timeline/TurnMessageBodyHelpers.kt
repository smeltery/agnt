package com.dotbrains.agnt.mobile.ui.turn.timeline

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import com.valentinilk.shimmer.shimmer
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

@Composable
internal fun rememberStreamingAssistantMarkdown(
    messageId: String,
    markdown: String,
    isStreaming: Boolean,
): String {
    if (isStreaming && markdown.length > STREAMING_ASSISTANT_REVEAL_DISABLE_CHARS) {
        return markdown
    }
    var displayed by remember(messageId) { mutableStateOf(if (isStreaming) "" else markdown) }
    val latestMarkdown by rememberUpdatedState(markdown)

    LaunchedEffect(messageId, isStreaming) {
        if (!isStreaming) {
            displayed = latestMarkdown
            return@LaunchedEffect
        }

        if (displayed.isEmpty() && STREAMING_ASSISTANT_INITIAL_DELAY_MS > 0L) {
            delay(STREAMING_ASSISTANT_INITIAL_DELAY_MS)
        }

        while (isActive) {
            val target = latestMarkdown
            displayed =
                when {
                    target.isEmpty() -> ""
                    displayed.isEmpty() -> target.take(streamingRevealStep(target.length))
                    target.startsWith(displayed) && displayed.length < target.length -> {
                        val nextLength =
                            (displayed.length + streamingRevealStep(target.length - displayed.length))
                                .coerceAtMost(target.length)
                        target.take(nextLength)
                    }
                    target == displayed -> displayed
                    else -> target
                }
            delay(STREAMING_ASSISTANT_REVEAL_FRAME_MS)
        }
    }

    return if (isStreaming) displayed else markdown
}

private fun streamingRevealStep(remaining: Int): Int =
    when {
        remaining > 180 -> 32
        remaining > 80 -> 20
        remaining > 24 -> 8
        else -> 3
    }

@Composable
internal fun Modifier.streamingAssistantShimmer(enabled: Boolean): Modifier = if (enabled) this.shimmer() else this

private const val STREAMING_ASSISTANT_INITIAL_DELAY_MS = 80L
private const val STREAMING_ASSISTANT_REVEAL_FRAME_MS = 34L
private const val STREAMING_ASSISTANT_REVEAL_DISABLE_CHARS = 1_800
private const val USER_MESSAGE_INLINE_MAX_CHARS = 1_200
private const val USER_MESSAGE_INLINE_MAX_LINES = 12
private const val ASSISTANT_MESSAGE_INLINE_MAX_LINES = 18
private const val PLAN_MESSAGE_INLINE_MAX_CHARS = 1_200
private const val PLAN_MESSAGE_INLINE_MAX_LINES = 12

internal data class CappedTimelineBody(
    val text: String,
    val truncated: Boolean,
)

internal fun capTimelineBody(
    message: CodexMessage,
    text: String,
): CappedTimelineBody {
    val (maxChars, maxLines) =
        when {
            message.role == CodexMessageRole.user && message.kind == CodexMessageKind.chat ->
                USER_MESSAGE_INLINE_MAX_CHARS to USER_MESSAGE_INLINE_MAX_LINES
            message.role == CodexMessageRole.assistant && message.kind == CodexMessageKind.chat ->
                Int.MAX_VALUE to ASSISTANT_MESSAGE_INLINE_MAX_LINES
            message.kind == CodexMessageKind.plan ->
                PLAN_MESSAGE_INLINE_MAX_CHARS to PLAN_MESSAGE_INLINE_MAX_LINES
            else -> return CappedTimelineBody(text = text, truncated = false)
        }
    return capTextForTimeline(text, maxChars = maxChars, maxLines = maxLines)
}

private fun capTextForTimeline(
    text: String,
    maxChars: Int,
    maxLines: Int,
): CappedTimelineBody {
    if (text.isBlank()) return CappedTimelineBody(text = text, truncated = false)
    val lineCount = text.count { it == '\n' } + 1
    val shouldTruncate = text.length > maxChars || lineCount > maxLines
    if (!shouldTruncate) return CappedTimelineBody(text = text, truncated = false)
    val byLines = text.lineSequence().take(maxLines).joinToString("\n")
    val clipped =
        if (byLines.length > maxChars) {
            byLines.take(maxChars)
        } else {
            byLines
        }
    return CappedTimelineBody(text = clipped.trimEnd() + "\n...", truncated = true)
}
