package com.dotbrains.agnt.mobile.data

internal fun normalizedCommandExecutionPreviewKey(text: String): String? {
    val withoutPhase =
        text.trim().replaceFirst(
            Regex("""^(running|completed|failed|stopped)\s*>?\s*""", RegexOption.IGNORE_CASE),
            "",
        )
    val normalized =
        withoutPhase
            .split("\\s+".toRegex())
            .filter { it.isNotEmpty() }
            .joinToString(" ") { token -> token.trim().trim('"', '\'') }
            .replace("\\s+".toRegex(), " ")
            .lowercase()
    return normalized.takeIf { it.isNotEmpty() }
}

internal fun normalizedFileChangePathKeys(text: String): Set<String> {
    val keys = linkedSetOf<String>()
    val inlineTotals = Regex("""\s*[+\uFF0B]\s*\d+\s*[-\u2212\u2013\u2014\uFE63\uFF0D]\s*\d+\s*$""")
    val verbs = listOf("edited ", "updated ", "added ", "created ", "deleted ", "removed ", "renamed ", "moved ")
    for (rawLine in text.lineSequence()) {
        var line = rawLine.trim()
        if (line.isEmpty()) continue
        if (line.startsWith("- ") || line.startsWith("* ")) {
            line = line.drop(2).trim()
        }
        val lower = line.lowercase()
        when {
            lower.startsWith("path:") ->
                keys.addAll(normalizedFileChangePathAliases(line.drop("Path:".length)))
            line.startsWith("+++ ") || line.startsWith("--- ") ->
                keys.addAll(normalizedFileChangePathAliases(line.drop(4)))
            line.startsWith("diff --git ") -> {
                val parts = line.split(Regex("\\s+"))
                if (parts.size >= 4) keys.addAll(normalizedFileChangePathAliases(parts[3]))
            }
            else -> {
                val verb = verbs.firstOrNull { lower.startsWith(it) }
                if (verb != null) {
                    keys.addAll(normalizedFileChangePathAliases(line.drop(verb.length).replace(inlineTotals, "")))
                }
            }
        }
    }
    return keys
}

private fun normalizedFileChangePathAliases(rawPath: String): Set<String> {
    val normalized = normalizeFileChangePathKey(rawPath) ?: return emptySet()
    val aliases = linkedSetOf(normalized)
    val parts = normalized.split('/').filter { it.isNotEmpty() }
    val workspaceIndex = parts.indexOf("workspace")
    if (workspaceIndex >= 0 && parts.size > workspaceIndex + 2) {
        aliases.add(parts.drop(workspaceIndex + 2).joinToString("/"))
    }
    return aliases
}

private fun normalizeFileChangePathKey(rawPath: String): String? {
    var normalized = rawPath.trim()
    if (normalized.isEmpty() || normalized == "/dev/null") return null
    normalized = normalized.replace("`", "").replace("\"", "").replace("'", "")
    if (normalized.startsWith("(") && normalized.endsWith(")") && normalized.length > 2) {
        normalized = normalized.drop(1).dropLast(1)
    }
    if (normalized.startsWith("a/") || normalized.startsWith("b/")) normalized = normalized.drop(2)
    if (normalized.startsWith("./")) normalized = normalized.drop(2)
    normalized = normalized.replace(Regex(""":\d+(?::\d+)?$"""), "")
    normalized = normalized.trim().trimEnd(',', '.', ';')
    return normalized.takeIf { it.isNotEmpty() }?.lowercase()
}
