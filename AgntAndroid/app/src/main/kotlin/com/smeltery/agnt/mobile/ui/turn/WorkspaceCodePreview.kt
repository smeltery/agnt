package com.smeltery.agnt.mobile.ui.turn

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import java.util.Locale

private const val HighlightedTextMaxUtf8Bytes = 512 * 1024

@Composable
fun WorkspaceCodePreview(
    content: String,
    fileName: String,
    modifier: Modifier = Modifier,
) {
    val colors = workspaceCodeColors()
    val rendered =
        remember(content, fileName, colors) {
            buildWorkspaceCodePreviewText(
                content = content.ifEmpty { " " },
                fileName = fileName,
                colors = colors,
            )
        }
    SelectionContainer {
        Text(
            text = rendered,
            modifier =
                modifier
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            style =
                MaterialTheme.typography.bodySmall.merge(
                    TextStyle(
                        fontFamily = FontFamily.Monospace,
                        lineHeight = MaterialTheme.typography.bodySmall.lineHeight * 1.18,
                    ),
                ),
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}

@Composable
private fun workspaceCodeColors(): WorkspaceCodeColors =
    WorkspaceCodeColors(
        lineNumber = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f),
        keyword = MaterialTheme.colorScheme.primary,
        string = MaterialTheme.colorScheme.tertiary,
        comment = MaterialTheme.colorScheme.onSurfaceVariant,
        number = MaterialTheme.colorScheme.secondary,
    )

data class WorkspaceCodeColors(
    val lineNumber: Color,
    val keyword: Color,
    val string: Color,
    val comment: Color,
    val number: Color,
)

fun workspaceCodeLanguageId(fileName: String): String {
    val lower = fileName.lowercase(Locale.US)
    val baseName = lower.substringAfterLast('/')
    val extension = baseName.substringAfterLast('.', missingDelimiterValue = "")

    if (baseName == "dockerfile") return "bash"

    return when (extension) {
        "bash", "sh", "zsh" -> "bash"
        "c", "h", "m" -> "c"
        "cc", "cpp", "cxx", "hh", "hpp", "hxx", "mm" -> "cpp"
        "cs" -> "csharp"
        "css", "scss" -> "css"
        "go" -> "go"
        "html", "htm" -> "html"
        "java", "kt" -> "java"
        "js", "mjs", "cjs" -> "javascript"
        "jsx" -> "jsx"
        "json" -> "json"
        "md", "markdown" -> "markdown"
        "py" -> "python"
        "rb" -> "ruby"
        "rs" -> "rust"
        "sql" -> "sql"
        "swift" -> "swift"
        "toml" -> "toml"
        "tsx" -> "tsx"
        "ts" -> "typescript"
        "yaml", "yml" -> "yaml"
        else -> "plain"
    }
}

fun shouldHighlightWorkspaceCode(content: String): Boolean = content.toByteArray(Charsets.UTF_8).size <= HighlightedTextMaxUtf8Bytes

fun buildWorkspaceCodePreviewText(
    content: String,
    fileName: String,
    colors: WorkspaceCodeColors,
) = buildAnnotatedString {
    val lines = content.split('\n')
    val lineNumberWidth =
        lines.size
            .toString()
            .length
            .coerceAtLeast(2)
    val languageId = workspaceCodeLanguageId(fileName)
    val shouldHighlight = languageId != "plain" && shouldHighlightWorkspaceCode(content)

    lines.forEachIndexed { index, line ->
        pushStyle(SpanStyle(color = colors.lineNumber))
        append((index + 1).toString().padStart(lineNumberWidth, ' '))
        append("  ")
        pop()

        val lineStart = length
        append(line)
        if (shouldHighlight) {
            highlightWorkspaceCodeLine(line, languageId, lineStart, colors)
        }
        if (index < lines.lastIndex) append('\n')
    }
}

private fun androidx.compose.ui.text.AnnotatedString.Builder.highlightWorkspaceCodeLine(
    line: String,
    languageId: String,
    lineStart: Int,
    colors: WorkspaceCodeColors,
) {
    val commentStart = findLineCommentStart(line, languageId)
    val codeEnd = commentStart ?: line.length
    if (commentStart != null) {
        addStyle(SpanStyle(color = colors.comment), lineStart + commentStart, lineStart + line.length)
    }

    val ranges = stringRanges(line, codeEnd)
    ranges.forEach { range ->
        addStyle(SpanStyle(color = colors.string), lineStart + range.first, lineStart + range.last + 1)
    }

    val occupied = ranges.toSet()
    TOKEN_PATTERN.findAll(line.substring(0, codeEnd)).forEach { match ->
        val range = match.range
        if (range.any { it in occupied }) return@forEach
        val token = match.value
        val color =
            when {
                token.firstOrNull()?.isDigit() == true -> colors.number
                token in keywordsForLanguage(languageId) -> colors.keyword
                else -> null
            }
        if (color != null) {
            addStyle(SpanStyle(color = color), lineStart + range.first, lineStart + range.last + 1)
        }
    }
}

private fun stringRanges(
    line: String,
    codeEnd: Int,
): List<IntRange> {
    val ranges = mutableListOf<IntRange>()
    var index = 0
    while (index < codeEnd) {
        val quote = line[index]
        if (quote != '"' && quote != '\'') {
            index += 1
            continue
        }
        val start = index
        index += 1
        var escaped = false
        while (index < codeEnd) {
            val ch = line[index]
            if (escaped) {
                escaped = false
            } else if (ch == '\\') {
                escaped = true
            } else if (ch == quote) {
                index += 1
                break
            }
            index += 1
        }
        ranges.add(start until index)
    }
    return ranges
}

private fun List<IntRange>.toSet(): Set<Int> = flatMap { it.toList() }.toSet()

private fun findLineCommentStart(
    line: String,
    languageId: String,
): Int? {
    val markers =
        when (languageId) {
            "bash", "python", "ruby", "yaml", "toml" -> listOf("#")
            "sql" -> listOf("--")
            "html", "markdown" -> listOf("<!--")
            "css" -> listOf("/*")
            "json" -> emptyList()
            else -> listOf("//", "/*")
        }
    return markers.mapNotNull { marker -> line.indexOf(marker).takeIf { it >= 0 } }.minOrNull()
}

private val TOKEN_PATTERN = Regex("""\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+(?:\.\d+)?\b""")

private fun keywordsForLanguage(languageId: String): Set<String> =
    when (languageId) {
        "bash" -> setOf("case", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "then", "while")
        "c", "cpp", "csharp", "java", "javascript", "jsx", "tsx", "typescript" ->
            setOf(
                "abstract",
                "await",
                "break",
                "case",
                "catch",
                "class",
                "const",
                "continue",
                "default",
                "do",
                "else",
                "enum",
                "export",
                "extends",
                "false",
                "final",
                "finally",
                "for",
                "fun",
                "function",
                "if",
                "import",
                "in",
                "interface",
                "let",
                "new",
                "null",
                "private",
                "protected",
                "public",
                "return",
                "static",
                "switch",
                "this",
                "throw",
                "true",
                "try",
                "val",
                "var",
                "void",
                "while",
            )
        "css" -> setOf("important", "media", "supports")
        "go" -> setOf("break", "case", "const", "continue", "defer", "else", "fallthrough", "for", "func", "go", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var")
        "json" -> setOf("false", "null", "true")
        "python" -> setOf("and", "as", "async", "await", "break", "class", "continue", "def", "elif", "else", "except", "False", "finally", "for", "from", "if", "import", "in", "is", "None", "not", "or", "pass", "return", "True", "try", "while", "with", "yield")
        "ruby" -> setOf("begin", "case", "class", "def", "do", "else", "elsif", "end", "false", "if", "module", "nil", "return", "self", "true", "unless", "while", "yield")
        "rust" -> setOf("async", "await", "break", "const", "continue", "crate", "else", "enum", "false", "fn", "for", "if", "impl", "let", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while")
        "sql" -> setOf("ALTER", "AND", "AS", "CREATE", "DELETE", "DROP", "FROM", "GROUP", "INSERT", "INTO", "JOIN", "LIMIT", "NOT", "NULL", "OR", "ORDER", "SELECT", "TABLE", "UPDATE", "VALUES", "WHERE")
        "swift" -> setOf("as", "break", "case", "catch", "class", "continue", "default", "defer", "do", "else", "enum", "extension", "false", "for", "func", "guard", "if", "import", "in", "let", "nil", "protocol", "return", "self", "struct", "switch", "throw", "true", "try", "var", "while")
        else -> emptySet()
    }
