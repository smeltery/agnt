package com.dotbrains.agnt.mobile.ui.theme

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import com.dotbrains.agnt.mobile.core.model.UserBubbleColor
import kotlin.test.Test
import kotlin.test.assertEquals

class UserBubbleColorPaletteTest {
    @Test
    fun defaultColorUsesExistingAndroidBubbleColors() {
        val lightScheme = lightColorScheme(surfaceVariant = Color(0xFFF4F4F4), onSurface = Color(0xFF171717))
        val darkScheme = darkColorScheme(surfaceVariant = Color(0xFF202429), onSurface = Color(0xFFECE9E1))

        assertEquals(lightScheme.surfaceVariant.copy(alpha = 1f), UserBubbleColor.default.bubbleBackground(lightScheme, true))
        assertEquals(darkScheme.surfaceVariant.copy(alpha = 0.55f), UserBubbleColor.default.bubbleBackground(darkScheme, false))
        assertEquals(lightScheme.onSurface, UserBubbleColor.default.bubbleForeground(lightScheme, true))
    }

    @Test
    fun blackColorInvertsBetweenLightAndDarkChrome() {
        val lightScheme = lightColorScheme()
        val darkScheme = darkColorScheme()

        assertEquals(Color.Black, UserBubbleColor.black.bubbleBackground(lightScheme, true))
        assertEquals(Color.White, UserBubbleColor.black.bubbleForeground(lightScheme, true))
        assertEquals(Color.White, UserBubbleColor.black.bubbleBackground(darkScheme, false))
        assertEquals(Color.Black, UserBubbleColor.black.bubbleForeground(darkScheme, false))
    }

    @Test
    fun accentColorsMatchBubblePalette() {
        val lightScheme = lightColorScheme()
        UserBubbleColor.entries.forEach { color ->
            assertEquals(
                color.bubbleBackground(lightScheme, true),
                color.accentBackground(lightScheme, true),
            )
            assertEquals(
                color.bubbleForeground(lightScheme, true),
                color.accentForeground(lightScheme, true),
            )
        }
    }
}
