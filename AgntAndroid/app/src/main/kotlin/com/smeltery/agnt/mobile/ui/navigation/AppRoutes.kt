package com.smeltery.agnt.mobile.ui.navigation

/** Top-level destinations for [AppNavHost] (parity with ContentView navigation stack). */
object AppRoutes {
    const val Home = "home"
    const val Settings = "settings"

    /** Multi-device switcher ("My Devices"): list paired computers, switch, forget, manage menu visibility. */
    const val MyDevices = "my_devices"
    const val Archived = "archived"
    const val About = "about"
    const val WhatsNew = "whats_new"

    /**
     * On-device SSH terminal. Accepts an optional `cwd` query parameter so
     * the "Open Terminal Here" turn action can pre-populate the working
     * directory from the active worktree (iOS parity:
     * `onOpenTerminal(gitWorkingDirectory)` in `TurnView.swift`). The
     * `TerminalScreen` already accepts `preferredWorkingDirectory`; this
     * route exposes it to the navigation layer.
     */
    const val Terminal = "terminal?cwd={cwd}"
    const val TerminalArgCwd = "cwd"

    /** Build a `terminal?...` route with an optional pre-populated cwd. */
    fun terminalRoute(cwd: String? = null): String = if (cwd.isNullOrBlank()) "terminal" else "terminal?cwd=${java.net.URLEncoder.encode(cwd, "UTF-8")}"

    /**
     * New-chat draft composer. `source` selects the `NewChatDraftSource` (general vs folder chat) and
     * the optional `path` query parameter pre-populates the project folder for a folder chat.
     */
    const val NewChatDraft = "new_chat_draft?source={source}&path={path}"
    const val NewChatDraftArgSource = "source"
    const val NewChatDraftArgPath = "path"

    /** Build a `new_chat_draft?...` route with an optional pre-populated project path. */
    fun newChatDraftRoute(
        source: String,
        path: String? = null,
    ): String {
        val base = "new_chat_draft?source=${java.net.URLEncoder.encode(source, "UTF-8")}"
        return if (path.isNullOrBlank()) base else "$base&path=${java.net.URLEncoder.encode(path, "UTF-8")}"
    }
}
