package com.dotbrains.agnt.mobile.ui.navigation

/** Top-level destinations for [AppNavHost] (parity with ContentView navigation stack). */
object AppRoutes {
    const val Home = "home"
    const val Settings = "settings"
    const val Archived = "archived"
    const val About = "about"
    const val WhatsNew = "whats_new"
    const val TesterHq = "tester_hq"
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
    fun terminalRoute(cwd: String? = null): String =
        if (cwd.isNullOrBlank()) "terminal" else "terminal?cwd=${java.net.URLEncoder.encode(cwd, "UTF-8")}"
}
