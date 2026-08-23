package com.smeltery.agnt.mobile.data.richcontent

import com.smeltery.agnt.mobile.core.model.CodexMessage
import com.smeltery.agnt.mobile.data.TurnCommandExecutionPresentation

internal object TurnCommandExecutionParser {
    fun parse(message: CodexMessage): TurnCommandExecutionPresentation {
        val rawText = message.text.trim()
        if (rawText.isEmpty()) {
            return TurnCommandExecutionPresentation(
                phase = if (message.isStreaming) "running" else "completed",
                command = "command",
                outputText = null,
                rawText = rawText,
            )
        }
        val lines = rawText.lines()
        val first = lines.firstOrNull()?.trim().orEmpty()
        val inlinedPhaseCommand =
            Regex(
                """^(?<phase>running|completed|failed|stopped|complete|success|error|cancelled|canceled)\s*[>»]+\s*(?<cmd>.*?)$""",
                RegexOption.IGNORE_CASE,
            ).matchEntire(first)
        if (inlinedPhaseCommand != null) {
            val parsedPhaseRaw = inlinedPhaseCommand.groups["phase"]!!.value.lowercase()
            val phase =
                when (parsedPhaseRaw) {
                    "complete", "success" -> "completed"
                    "cancelled", "canceled" -> "stopped"
                    "error" -> "failed"
                    else -> parsedPhaseRaw
                }
            var cmd = inlinedPhaseCommand.groups["cmd"]!!.value.trim()
            var skippedLines = 1
            if (cmd.isBlank()) {
                cmd =
                    lines
                        .drop(1)
                        .firstOrNull { it.trim().isNotBlank() }
                        ?.trim()
                        .orEmpty()
                skippedLines = 2
            }
            if (cmd.isBlank()) cmd = "command"
            val details = parseCommandMetadata(lines.drop(skippedLines))
            return TurnCommandExecutionPresentation(
                phase = phase,
                command = cmd,
                outputText = details.outputText,
                rawText = rawText,
                cwd = details.cwd,
                exitCode = details.exitCode,
                durationMs = details.durationMs,
            )
        }

        val firstParts = first.split(Regex("""\s+"""), limit = 2)
        val phaseCandidate = firstParts.firstOrNull().orEmpty().lowercase()
        val knownPhase =
            phaseCandidate in
                setOf("running", "completed", "complete", "success", "succeeded", "failed", "error", "stopped", "cancelled", "canceled")
        val phase =
            when {
                knownPhase && phaseCandidate == "complete" -> "completed"
                knownPhase && phaseCandidate == "success" -> "completed"
                knownPhase && phaseCandidate == "succeeded" -> "completed"
                knownPhase && phaseCandidate == "cancelled" -> "stopped"
                knownPhase && phaseCandidate == "canceled" -> "stopped"
                knownPhase -> phaseCandidate
                message.isStreaming -> "running"
                else -> "completed"
            }
        val firstContinuation = lines.drop(1).firstOrNull { it.trim().isNotBlank() }?.trim()
        val command =
            if (knownPhase) {
                val rest = firstParts.getOrNull(1)?.trim().orEmpty()
                if (rest.isNotBlank()) rest else firstContinuation ?: "command"
            } else {
                first.ifBlank { "command" }
            }
        val skippedLinesAfterCommand =
            if (knownPhase &&
                firstParts
                    .getOrNull(1)
                    ?.trim()
                    .orEmpty()
                    .isBlank() &&
                firstContinuation != null &&
                command.trim() == firstContinuation
            ) {
                2
            } else {
                1
            }
        val details = parseCommandMetadata(lines.drop(skippedLinesAfterCommand))
        return TurnCommandExecutionPresentation(
            phase = phase,
            command = command,
            outputText = details.outputText,
            rawText = rawText,
            cwd = details.cwd,
            exitCode = details.exitCode,
            durationMs = details.durationMs,
        )
    }

    private data class ParsedCommandMetadata(
        val outputText: String?,
        val cwd: String?,
        val exitCode: Int?,
        val durationMs: Int?,
    )

    private fun parseCommandMetadata(lines: List<String>): ParsedCommandMetadata {
        var cwd: String? = null
        var exitCode: Int? = null
        var durationMs: Int? = null
        val outputLines = mutableListOf<String>()

        for (line in lines) {
            val trimmed = line.trim()
            val kv = metadataKeyValue(trimmed)
            if (kv != null) {
                val (key, value) = kv
                when (key) {
                    "cwd",
                    "directory",
                    "workingdirectory",
                    "workingdir",
                    -> {
                        cwd = value.takeIf { it.isNotBlank() } ?: cwd
                        continue
                    }
                    "exitcode",
                    "exit",
                    "code",
                    -> {
                        exitCode = value.toIntOrNull() ?: exitCode
                        continue
                    }
                    "duration",
                    "durationms",
                    "elapsed",
                    "elapsedms",
                    -> {
                        durationMs = parseDurationMillis(value) ?: durationMs
                        continue
                    }
                }
            }
            outputLines += line
        }

        val output =
            outputLines
                .joinToString("\n")
                .trim()
                .takeIf { it.isNotEmpty() }
        return ParsedCommandMetadata(
            outputText = output,
            cwd = cwd,
            exitCode = exitCode,
            durationMs = durationMs,
        )
    }

    private fun metadataKeyValue(line: String): Pair<String, String>? {
        val separator = line.indexOf(':').takeIf { it >= 0 } ?: line.indexOf('=').takeIf { it >= 0 } ?: return null
        val key =
            line
                .take(separator)
                .trim()
                .lowercase()
                .replace(Regex("""[\s_-]+"""), "")
        val value = line.drop(separator + 1).trim()
        if (key.isEmpty() || value.isEmpty()) return null
        return key to value
    }

    private fun parseDurationMillis(raw: String): Int? {
        val normalized = raw.trim().lowercase()
        normalized.toIntOrNull()?.let { return it }
        Regex("""^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes)?$""")
            .matchEntire(normalized)
            ?.let { match ->
                val amount = match.groupValues[1].toDoubleOrNull() ?: return null
                return when (match.groupValues[2]) {
                    "", "ms" -> amount.toInt()
                    "s", "sec", "secs", "second", "seconds" -> (amount * 1000).toInt()
                    "m", "min", "mins", "minute", "minutes" -> (amount * 60_000).toInt()
                    else -> null
                }
            }
        return null
    }
}
