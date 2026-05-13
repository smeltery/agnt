package com.dotbrains.agnt.mobile.ui.terminal

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember

/**
 * Theme palette piped into the xterm.js WebView. Mirrors `RemodexTerminalTheme` from
 * `AgntMobile/AgntMobile/Views/Terminal/GhosttyTerminalSurface.swift`.
 */
data class TerminalTheme(
    val background: String,
    val foreground: String,
    val mutedForeground: String,
    val border: String,
    val cursorForeground: String,
    val cursorBackground: String,
    val palette: List<String>,
) {
    companion object {
        val Light =
            TerminalTheme(
                background = "#f2f2f7",
                foreground = "#6C6C71",
                mutedForeground = "#8E8E95",
                border = "#eeeeef",
                cursorForeground = "#009fff",
                cursorBackground = "#f2f2f7",
                palette =
                    listOf(
                        "#1f1f21", "#ff2e3f", "#0dbe4e", "#ffca00",
                        "#009fff", "#c635e4", "#08c0ef", "#c6c6c8",
                        "#1f1f21", "#ff2e3f", "#0dbe4e", "#ffca00",
                        "#009fff", "#c635e4", "#08c0ef", "#c6c6c8",
                    ),
            )

        val Dark =
            TerminalTheme(
                background = "#0a0a0a",
                foreground = "#adadb1",
                mutedForeground = "#8e8e95",
                border = "#2e2e30",
                cursorForeground = "#009fff",
                cursorBackground = "#0a0a0a",
                palette =
                    listOf(
                        "#141415", "#ff2e3f", "#0dbe4e", "#ffca00",
                        "#009fff", "#c635e4", "#08c0ef", "#c6c6c8",
                        "#141415", "#ff2e3f", "#0dbe4e", "#ffca00",
                        "#009fff", "#c635e4", "#08c0ef", "#c6c6c8",
                    ),
            )
    }
}

@Composable
fun rememberTerminalTheme(): TerminalTheme {
    val isDark = isSystemInDarkTheme()
    return remember(isDark) { if (isDark) TerminalTheme.Dark else TerminalTheme.Light }
}

const val TERMINAL_FONT_SIZE_DEFAULT = 12.0
const val TERMINAL_FONT_SIZE_MIN = 8.0
const val TERMINAL_FONT_SIZE_MAX = 18.0
const val TERMINAL_FONT_SIZE_STEP = 0.5
