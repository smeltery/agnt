package com.dotbrains.agnt.mobile.ui.navigation

import kotlin.test.Test
import kotlin.test.assertEquals

class AppRoutesTest {
    @Test
    fun terminalRouteWithNullOrBlankCwdReturnsBareRoute() {
        // Old call sites (sidebar entry) pass nothing; they must keep their
        // previous behaviour so `composable(AppRoutes.Terminal)` still matches.
        assertEquals("terminal", AppRoutes.terminalRoute(null))
        assertEquals("terminal", AppRoutes.terminalRoute(""))
        assertEquals("terminal", AppRoutes.terminalRoute("   "))
    }

    @Test
    fun terminalRouteEncodesPathSeparatorsAndSpaces() {
        // Without URL-encoding, slashes would shadow the path segment and a
        // space would arrive as a "+" — both would corrupt the cwd handed to
        // TerminalScreen.preferredWorkingDirectory.
        assertEquals(
            "terminal?cwd=%2FUsers%2Fnick%2Fcode%2Fagnt",
            AppRoutes.terminalRoute("/Users/nick/code/agnt"),
        )
        assertEquals(
            "terminal?cwd=%2Ftmp%2Fmy+project",
            AppRoutes.terminalRoute("/tmp/my project"),
        )
    }
}
