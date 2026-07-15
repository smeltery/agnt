package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CommandExecutionDetails
import com.dotbrains.agnt.mobile.data.richcontent.TurnCommandExecutionParser
import com.dotbrains.agnt.mobile.data.richcontent.TurnFileChangeParser

internal data class TurnFileChangeEntryPresentation(
    val path: String,
    val additions: Int,
    val deletions: Int,
    val label: String?,
    /** Unified diff fragment for this file (`diff --git` … slice), split from [TurnFileChangePresentation.rawPatchText]. */
    val patchChunkText: String? = null,
)

internal data class TurnFileChangePresentation(
    val headline: String,
    val summaryText: String,
    val entries: List<TurnFileChangeEntryPresentation>,
    val rawText: String,
    val rawPatchText: String?,
) {
    val hasDetails: Boolean
        get() = entries.isNotEmpty() || !rawPatchText.isNullOrBlank()

    val fileCount: Int
        get() = entries.size

    val totalAdditions: Int
        get() = entries.sumOf { it.additions }

    val totalDeletions: Int
        get() = entries.sumOf { it.deletions }

    /** True when the message body likely contains unified diff markup (fence or markers). */
    val likelyHasDiff: Boolean
        get() =
            !rawPatchText.isNullOrBlank() ||
                rawText.contains("diff --git") ||
                rawText.contains("+++ ")
}

internal data class TurnMarkdownSegment(
    val kind: TurnMarkdownSegmentKind,
    val text: String,
)

internal enum class TurnMarkdownSegmentKind {
    markdown,
    mermaid,
}

internal data class TurnSubagentAgentPresentation(
    val threadId: String,
    val label: String,
    val role: String?,
    val model: String?,
    val prompt: String?,
    val status: String?,
    val message: String?,
)

internal data class TurnSubagentPresentation(
    val headline: String,
    val summaryText: String,
    val promptText: String?,
    val agents: List<TurnSubagentAgentPresentation>,
    val rawText: String,
    val normalizedTool: String? = null,
    val status: String? = null,
)

internal data class TurnCommandExecutionPresentation(
    val phase: String,
    val command: String,
    val outputText: String?,
    val rawText: String,
    val cwd: String? = null,
    val exitCode: Int? = null,
    val durationMs: Int? = null,
) {
    val isFailure: Boolean
        get() =
            phase.equals("failed", ignoreCase = true) ||
                phase.equals("error", ignoreCase = true) ||
                exitCode?.let { it != 0 } == true

    val isRunning: Boolean
        get() = phase.equals("running", ignoreCase = true)

    val isStopped: Boolean
        get() = phase.equals("stopped", ignoreCase = true)
}

internal object TurnCommandExecutionPreviewMerge {
    fun merge(
        parsed: TurnCommandExecutionPresentation,
        details: CommandExecutionDetails?,
    ): TurnCommandExecutionPresentation {
        if (details == null || !details.hasStructuredFields()) return parsed
        return parsed.copy(
            command = details.fullCommand.trim().takeIf { it.isNotEmpty() } ?: parsed.command,
            outputText = details.outputTail.takeIf { it.isNotBlank() } ?: parsed.outputText,
            cwd = details.cwd ?: parsed.cwd,
            exitCode = details.exitCode ?: parsed.exitCode,
            durationMs = details.durationMs ?: parsed.durationMs,
        )
    }

    fun hasUsefulFields(details: CommandExecutionDetails?): Boolean = details?.hasStructuredFields() == true

    private fun CommandExecutionDetails.hasStructuredFields(): Boolean =
        fullCommand.isNotBlank() ||
            !cwd.isNullOrBlank() ||
            exitCode != null ||
            durationMs != null ||
            outputTail.isNotBlank()
}

internal object TurnTimelineRichContentParser {
    fun parseMermaidMarkdown(markdown: String): List<TurnMarkdownSegment>? {
        val source = markdown.trimEnd()
        if (source.isBlank()) return null

        val lines = source.split('\n')
        val segments = mutableListOf<TurnMarkdownSegment>()
        val markdownBuffer = mutableListOf<String>()
        val mermaidBuffer = mutableListOf<String>()
        var activeFence: MarkdownFence? = null
        var sawMermaid = false

        fun flushMarkdown() {
            if (markdownBuffer.isEmpty()) return
            segments +=
                TurnMarkdownSegment(
                    kind = TurnMarkdownSegmentKind.markdown,
                    text = markdownBuffer.joinToString("\n").trimEnd(),
                )
            markdownBuffer.clear()
        }

        fun flushMermaid() {
            segments +=
                TurnMarkdownSegment(
                    kind = TurnMarkdownSegmentKind.mermaid,
                    text = mermaidBuffer.joinToString("\n").trimEnd(),
                )
            mermaidBuffer.clear()
        }

        for (line in lines) {
            val trimmed = line.trimStart()
            val fence = activeFence
            if (fence == null) {
                val opening = parseOpeningFence(trimmed)
                if (opening != null && opening.language == "mermaid") {
                    flushMarkdown()
                    activeFence = opening
                    sawMermaid = true
                    continue
                }
                if (opening != null) {
                    activeFence = opening
                    markdownBuffer += line
                    continue
                }
                markdownBuffer += line
            } else {
                if (isClosingFence(trimmed, fence)) {
                    if (fence.language == "mermaid") {
                        flushMermaid()
                    } else {
                        markdownBuffer += line
                    }
                    activeFence = null
                } else {
                    if (fence.language == "mermaid") {
                        mermaidBuffer += line
                    } else {
                        markdownBuffer += line
                    }
                }
            }
        }

        val fence = activeFence
        if (fence?.language == "mermaid") {
            markdownBuffer += fence.openingLine
            markdownBuffer += mermaidBuffer
        }
        flushMarkdown()

        return if (sawMermaid) segments else null
    }

    /** Prefer fenced ```diff``` body; fallback to raw message text. */
    internal fun unifiedPatchForFileChangeMessage(message: CodexMessage): String = TurnFileChangeParser.unifiedPatchForFileChangeMessage(message)

    fun parseFileChange(message: CodexMessage): TurnFileChangePresentation = TurnFileChangeParser.parse(message)

    fun parseSubagent(message: CodexMessage): TurnSubagentPresentation {
        val action = message.subagentAction
        val rawText = message.text.trim()
        if (action != null) {
            return TurnSubagentPresentation(
                headline = action.summaryText,
                summaryText =
                    action.status.trim().takeIf { it.isNotEmpty() }
                        ?: action.summaryText,
                promptText = action.prompt?.trim()?.takeIf { it.isNotEmpty() },
                agents =
                    action.agentRows.map { agent ->
                        TurnSubagentAgentPresentation(
                            threadId = agent.threadId,
                            label = agent.displayLabel,
                            role = agent.role?.trim()?.takeIf { it.isNotEmpty() },
                            model = agent.model?.trim()?.takeIf { it.isNotEmpty() },
                            prompt = agent.prompt?.trim()?.takeIf { it.isNotEmpty() },
                            status = agent.fallbackStatus?.trim()?.takeIf { it.isNotEmpty() },
                            message = agent.fallbackMessage?.trim()?.takeIf { it.isNotEmpty() },
                        )
                    },
                rawText = rawText,
                normalizedTool = action.normalizedTool,
                status = action.status.trim().takeIf { it.isNotEmpty() },
            )
        }

        val summary = firstNonBlankLine(rawText) ?: "Subagent activity"
        return TurnSubagentPresentation(
            headline = summary,
            summaryText = rawText.ifBlank { summary },
            promptText = null,
            agents = emptyList(),
            rawText = rawText,
        )
    }

    fun parseCommandExecution(message: CodexMessage): TurnCommandExecutionPresentation = TurnCommandExecutionParser.parse(message)

    private fun firstNonBlankLine(rawText: String): String? = rawText.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }

    private data class MarkdownFence(
        val markerChar: Char,
        val markerLength: Int,
        val language: String?,
        val openingLine: String,
    )

    private fun parseOpeningFence(trimmedLine: String): MarkdownFence? {
        val markerChar =
            when {
                trimmedLine.startsWith("```") -> '`'
                trimmedLine.startsWith("~~~") -> '~'
                else -> return null
            }
        val markerLength = trimmedLine.takeWhile { it == markerChar }.length
        if (markerLength < 3) return null
        val language =
            trimmedLine
                .drop(markerLength)
                .trim()
                .substringBefore(' ')
                .trim()
                .lowercase()
                .takeIf { it.isNotEmpty() }
        return MarkdownFence(
            markerChar = markerChar,
            markerLength = markerLength,
            language = language,
            openingLine = trimmedLine,
        )
    }

    private fun isClosingFence(
        trimmedLine: String,
        fence: MarkdownFence,
    ): Boolean {
        if (!trimmedLine.startsWith(fence.markerChar.toString().repeat(fence.markerLength))) return false
        val markerRun = trimmedLine.takeWhile { it == fence.markerChar }
        return markerRun.length >= fence.markerLength && trimmedLine.drop(markerRun.length).isBlank()
    }
}
