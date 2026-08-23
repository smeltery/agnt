package com.smeltery.agnt.mobile.ui.turn

import androidx.compose.ui.graphics.Color
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WorkspaceCodePreviewTest {
    private val colors =
        WorkspaceCodeColors(
            lineNumber = Color.Gray,
            keyword = Color.Blue,
            string = Color.Green,
            comment = Color.LightGray,
            number = Color.Magenta,
        )

    @Test
    fun workspaceCodeLanguageIdMapsCommonSourceFiles() {
        assertEquals("typescript", workspaceCodeLanguageId("src/app.ts"))
        assertEquals("tsx", workspaceCodeLanguageId("src/App.tsx"))
        assertEquals("java", workspaceCodeLanguageId("Main.kt"))
        assertEquals("bash", workspaceCodeLanguageId("Dockerfile"))
        assertEquals("yaml", workspaceCodeLanguageId(".github/workflows/ci.yml"))
        assertEquals("plain", workspaceCodeLanguageId("README.unknown"))
    }

    @Test
    fun buildWorkspaceCodePreviewTextPrefixesStableLineNumbers() {
        val text =
            buildWorkspaceCodePreviewText(
                content = "fun main() {\n  return\n}",
                fileName = "Main.kt",
                colors = colors,
            )

        assertEquals(
            " 1  fun main() {\n 2    return\n 3  }",
            text.text,
        )
    }

    @Test
    fun buildWorkspaceCodePreviewTextHighlightsCodeTokens() {
        val text =
            buildWorkspaceCodePreviewText(
                content = "const value = \"hello\" // comment",
                fileName = "app.ts",
                colors = colors,
            )

        assertTrue(text.spanStyles.any { it.item.color == colors.keyword })
        assertTrue(text.spanStyles.any { it.item.color == colors.string })
        assertTrue(text.spanStyles.any { it.item.color == colors.comment })
    }

    @Test
    fun buildWorkspaceCodePreviewTextLeavesLargeFilesPlainExceptLineNumbers() {
        val largeContent = "const value = 1\n".repeat(40_000)
        val text =
            buildWorkspaceCodePreviewText(
                content = largeContent,
                fileName = "app.ts",
                colors = colors,
            )

        assertFalse(shouldHighlightWorkspaceCode(largeContent))
        assertTrue(text.spanStyles.any { it.item.color == colors.lineNumber })
        assertFalse(text.spanStyles.any { it.item.color == colors.keyword })
    }
}
