package com.dotbrains.agnt.mobile.core.terminal

enum class TerminalModifier {
    Ctrl,
    Alt,
}

enum class TerminalDirection(val escapeSequence: String) {
    Up("\u001B[A"),
    Down("\u001B[B"),
    Right("\u001B[C"),
    Left("\u001B[D"),
}

object TerminalInputEncoder {
    fun text(
        value: String,
        modifier: TerminalModifier? = null,
    ): ByteArray {
        if (value.isEmpty()) return ByteArray(0)
        val encoded =
            when (modifier) {
                TerminalModifier.Ctrl -> applyCtrl(value)
                TerminalModifier.Alt -> "\u001B$value"
                null -> value
            }
        return encoded.encodeToByteArray()
    }

    fun direction(
        direction: TerminalDirection,
        modifier: TerminalModifier? = null,
    ): ByteArray {
        val suffix = direction.escapeSequence.last()
        val encoded =
            when (modifier) {
                TerminalModifier.Ctrl -> "\u001B[1;5$suffix"
                TerminalModifier.Alt -> "\u001B[1;3$suffix"
                null -> direction.escapeSequence
            }
        return encoded.encodeToByteArray()
    }

    private fun applyCtrl(value: String): String {
        val first = value.firstOrNull() ?: return value
        val lower = first.lowercaseChar()
        if (lower in 'a'..'z') {
            return (lower.code - 96).toChar().toString()
        }
        return when (first) {
            '@' -> "\u0000"
            '[' -> "\u001B"
            '\\' -> "\u001C"
            ']' -> "\u001D"
            '^' -> "\u001E"
            '_' -> "\u001F"
            '?' -> "\u007F"
            else -> value
        }
    }
}
