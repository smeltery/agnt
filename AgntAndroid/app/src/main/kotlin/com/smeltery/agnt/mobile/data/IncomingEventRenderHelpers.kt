package com.smeltery.agnt.mobile.data

internal fun shouldIgnoreFileChangeDelta(
    rendered: String,
    delta: String,
): Boolean {
    val candidate = listOf(rendered.trim(), delta.trim()).firstOrNull { it.isNotEmpty() } ?: return false
    if (candidate.contains("diff --git", ignoreCase = true)) return false
    if (candidate.contains("\nPath:", ignoreCase = true) || candidate.startsWith("Path:", ignoreCase = true)) return false
    if (candidate.contains("Totals:", ignoreCase = true)) return false
    if (candidate.contains("```diff", ignoreCase = true)) return false
    if (looksLikeTempPreviewError(candidate)) return true
    return candidate.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.all { line ->
        line.matches(Regex("""^[\w./\\:@\-]*[*?][\w./\\:@\-]*$"""))
    }
}

internal fun commandExecutionTimelineLine(
    phase: String,
    fullCommand: String,
): String {
    val p =
        phase.trim().lowercase().ifBlank { "running" }.let { raw ->
            when (raw) {
                "complete", "success", "succeeded" -> "completed"
                "cancelled", "canceled" -> "stopped"
                else -> raw
            }
        }
    val body =
        fullCommand.trim().ifBlank { "command" }.let { command ->
            val max = 8192
            if (command.length <= max) {
                command
            } else {
                command.take(max - 1) + "…"
            }
        }
    return "$p> $body"
}

private fun looksLikeTempPreviewError(text: String): Boolean {
    val lower = text.lowercase()
    if (!(lower.contains("preview") || lower.contains("temp"))) return false
    return lower.contains("image preview") &&
        (
            lower.contains("timed out") ||
                lower.contains("too long") ||
                lower.contains("too large") ||
                lower.contains("no longer exists") ||
                lower.contains("not found") ||
                lower.contains("could not be converted") ||
                lower.contains("failed") ||
                lower.contains("cannot")
        )
}
