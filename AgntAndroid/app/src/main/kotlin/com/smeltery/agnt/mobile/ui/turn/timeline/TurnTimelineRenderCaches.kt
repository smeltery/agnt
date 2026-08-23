package com.smeltery.agnt.mobile.ui.turn.timeline

import android.content.res.Resources
import com.smeltery.agnt.mobile.core.model.CommandExecutionDetails
import com.smeltery.agnt.mobile.core.model.TimelineBoundedCache
import com.smeltery.agnt.mobile.core.model.ToolExecutionUi
import com.smeltery.agnt.mobile.core.model.TurnCodeCommentDirectiveParseOutcome
import com.smeltery.agnt.mobile.core.model.TurnCodeCommentDirectiveParsing
import com.smeltery.agnt.mobile.core.model.TurnTimelineCacheKey
import com.smeltery.agnt.mobile.data.TurnCommandExecutionPresentation
import com.smeltery.agnt.mobile.data.TurnCommandExecutionPreviewMerge
import com.smeltery.agnt.mobile.ui.turn.autocomplete.SkillReferenceFormatter
import com.smeltery.agnt.mobile.ui.turn.subagent.CommandHumanizedLabel
import com.smeltery.agnt.mobile.ui.turn.subagent.CommandHumanizer
import com.smeltery.agnt.mobile.ui.turn.subagent.buildToolExecutionUi

internal object TurnMarkdownRenderCache {
    private val visibleProse = TimelineBoundedCache<String, String>(maxEntries = 256)
    private val fenceSegments = TimelineBoundedCache<String, List<MarkdownFenceSegment>>(maxEntries = 256)
    private val humanizedCommands = TimelineBoundedCache<String, CommandHumanizedLabel>(maxEntries = 256)
    private val toolExecutionUiCache = TimelineBoundedCache<String, ToolExecutionUi>(maxEntries = 256)

    fun visibleProse(markdown: String): String =
        visibleProse.getOrPut(TurnTimelineCacheKey.textKey("visible-prose", markdown)) {
            SkillReferenceFormatter.formatVisibleProse(markdown)
        }

    fun fenceSegments(markdown: String): List<MarkdownFenceSegment> =
        fenceSegments.getOrPut(TurnTimelineCacheKey.textKey("markdown-fences", markdown)) {
            MarkdownFenceSegmentParser.parse(markdown)
        }

    fun humanizeCommand(
        command: String,
        isRunning: Boolean,
    ): CommandHumanizedLabel =
        humanizedCommands.getOrPut(
            TurnTimelineCacheKey.textKey("command-humanizer", command, "running=$isRunning"),
        ) {
            CommandHumanizer.humanize(command, isRunning = isRunning)
        }

    fun toolExecutionUi(
        preview: TurnCommandExecutionPresentation,
        details: CommandExecutionDetails?,
        resources: Resources,
    ): ToolExecutionUi =
        toolExecutionUiCache.getOrPut(
            TurnTimelineCacheKey.textKey(
                "tool-exec-ui",
                preview.command,
                "${preview.phase}|fail=${preview.isFailure}|run=${preview.isRunning}|stop=${preview.isStopped}" +
                    "|cwd=${preview.cwd}|exit=${preview.exitCode}|dur=${preview.durationMs}" +
                    "|out=${preview.outputText?.length ?: -1}" +
                    "|struct=${TurnCommandExecutionPreviewMerge.hasUsefulFields(details)}",
            ),
        ) {
            buildToolExecutionUi(preview, details, preview.command, resources)
        }

    fun clear() {
        visibleProse.clear()
        fenceSegments.clear()
        humanizedCommands.clear()
        toolExecutionUiCache.clear()
    }
}

internal object TurnDirectiveRenderCache {
    private val directives =
        TimelineBoundedCache<String, TurnCodeCommentDirectiveParseOutcome>(maxEntries = 256)

    fun parseCodeCommentDirectives(
        messageId: String,
        text: String,
    ): TurnCodeCommentDirectiveParseOutcome =
        directives.getOrPut(
            TurnTimelineCacheKey.key(messageId, "code-comment-directives", text),
        ) {
            TurnCodeCommentDirectiveParsing.parseCodeCommentDirectives(text)
        }

    fun clear() {
        directives.clear()
    }
}

internal fun clearTimelineRenderCaches() {
    TurnMarkdownRenderCache.clear()
    TurnDirectiveRenderCache.clear()
    com.smeltery.agnt.mobile.data.TurnTimelineRichContentCache
        .clear()
}
