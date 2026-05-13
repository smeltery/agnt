package com.dotbrains.agnt.mobile.ui.terminal

import com.dotbrains.agnt.mobile.core.terminal.TerminalStatus

enum class TerminalPendingModifier { Ctrl, Meta }

enum class TerminalHostPlatform {
    Mac,
    Linux,
    Windows,
    Unknown,
    ;

    companion object {
        fun infer(value: String?): TerminalHostPlatform {
            val v = value?.lowercase().orEmpty()
            return when {
                v.contains("mac") || v.contains("imac") || v.contains("darwin") -> Mac
                v.contains("windows") || v.contains("win") -> Windows
                v.contains("linux") || v.contains("ubuntu") || v.contains("debian") -> Linux
                else -> Unknown
            }
        }
    }
}

sealed class TerminalAccessoryAction {
    data class Send(val data: String) : TerminalAccessoryAction()

    data class Modifier(val modifier: TerminalPendingModifier) : TerminalAccessoryAction()
}

data class TerminalAccessoryButton(
    val key: String,
    val label: String,
    val action: TerminalAccessoryAction,
) {
    val isModifier: Boolean
        get() = action is TerminalAccessoryAction.Modifier

    val modifier: TerminalPendingModifier?
        get() = (action as? TerminalAccessoryAction.Modifier)?.modifier
}

data class TerminalSessionItem(
    val terminalId: String,
    val displayLabel: String,
    val status: TerminalStatus,
    val cwd: String,
)

private val ESC: String = Char(0x1B).toString()

fun accessoryButtonsFor(platform: TerminalHostPlatform): List<TerminalAccessoryButton> {
    val modifierButtons =
        when (platform) {
            TerminalHostPlatform.Mac ->
                listOf(
                    TerminalAccessoryButton("cmd", "cmd", TerminalAccessoryAction.Modifier(TerminalPendingModifier.Meta)),
                    TerminalAccessoryButton("ctrl", "ctrl", TerminalAccessoryAction.Modifier(TerminalPendingModifier.Ctrl)),
                )
            else ->
                listOf(
                    TerminalAccessoryButton("ctrl", "ctrl", TerminalAccessoryAction.Modifier(TerminalPendingModifier.Ctrl)),
                    TerminalAccessoryButton("alt", "alt", TerminalAccessoryAction.Modifier(TerminalPendingModifier.Meta)),
                )
        }
    return listOf(
        TerminalAccessoryButton("esc", "esc", TerminalAccessoryAction.Send(ESC)),
    ) + modifierButtons +
        listOf(
            TerminalAccessoryButton("tab", "tab", TerminalAccessoryAction.Send("\t")),
            TerminalAccessoryButton("up", "↑", TerminalAccessoryAction.Send("$ESC[A")),
            TerminalAccessoryButton("down", "↓", TerminalAccessoryAction.Send("$ESC[B")),
            TerminalAccessoryButton("left", "←", TerminalAccessoryAction.Send("$ESC[D")),
            TerminalAccessoryButton("right", "→", TerminalAccessoryAction.Send("$ESC[C")),
            TerminalAccessoryButton("tilde", "~", TerminalAccessoryAction.Send("~")),
            TerminalAccessoryButton("pipe", "|", TerminalAccessoryAction.Send("|")),
            TerminalAccessoryButton("slash", "/", TerminalAccessoryAction.Send("/")),
            TerminalAccessoryButton("dash", "-", TerminalAccessoryAction.Send("-")),
        )
}

/**
 * Apply the iOS-equivalent ctrl-key transform to a typed character.
 * Mirrors `applyCtrlModifier` in `TerminalScreen.swift`.
 */
fun applyCtrlModifier(input: String): String {
    val first = input.firstOrNull() ?: return input
    val lower = first.lowercaseChar()
    if (lower in 'a'..'z') {
        return (lower.code - 96).toChar().toString()
    }
    return when (first) {
        '@' -> Char(0x00).toString()
        '[' -> Char(0x1B).toString()
        '\\' -> Char(0x1C).toString()
        ']' -> Char(0x1D).toString()
        '^' -> Char(0x1E).toString()
        '_' -> Char(0x1F).toString()
        '?' -> Char(0x7F).toString()
        else -> input
    }
}

fun applyMetaModifier(input: String): String = "$ESC$input"
