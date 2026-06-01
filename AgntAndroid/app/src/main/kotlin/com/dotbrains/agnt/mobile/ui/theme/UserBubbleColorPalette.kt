package com.dotbrains.agnt.mobile.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import com.dotbrains.agnt.mobile.core.model.UserBubbleColor

fun UserBubbleColor.swatchColor(): Color =
    when (this) {
        UserBubbleColor.default -> Color(0xFFBFC0C2)
        UserBubbleColor.orange -> Color(red = 0.86f, green = 0.22f, blue = 0.04f)
        UserBubbleColor.yellow -> Color(red = 0.95f, green = 0.68f, blue = 0.05f)
        UserBubbleColor.green -> Color(red = 0.07f, green = 0.62f, blue = 0.24f)
        UserBubbleColor.blue -> Color(red = 0.0f, green = 0.45f, blue = 0.90f)
        UserBubbleColor.pink -> Color(red = 0.86f, green = 0.16f, blue = 0.50f)
        UserBubbleColor.purple -> Color(red = 0.53f, green = 0.24f, blue = 0.85f)
        UserBubbleColor.black -> Color.Black
    }

fun UserBubbleColor.bubbleBackground(
    colorScheme: ColorScheme,
    isLightChrome: Boolean,
): Color =
    when (this) {
        UserBubbleColor.default ->
            if (isLightChrome) {
                colorScheme.surfaceVariant.copy(alpha = 1f)
            } else {
                colorScheme.surfaceVariant.copy(alpha = 0.55f)
            }
        UserBubbleColor.orange ->
            if (isLightChrome) {
                Color(red = 0.81f, green = 0.25f, blue = 0.06f)
            } else {
                Color(red = 0.77f, green = 0.18f, blue = 0.03f)
            }
        UserBubbleColor.yellow ->
            if (isLightChrome) {
                Color(red = 0.93f, green = 0.64f, blue = 0.04f)
            } else {
                Color(red = 0.96f, green = 0.71f, blue = 0.10f)
            }
        UserBubbleColor.green ->
            if (isLightChrome) {
                Color(red = 0.08f, green = 0.50f, blue = 0.24f)
            } else {
                Color(red = 0.06f, green = 0.45f, blue = 0.20f)
            }
        UserBubbleColor.blue ->
            if (isLightChrome) {
                Color(red = 0.0f, green = 0.39f, blue = 0.82f)
            } else {
                Color(red = 0.02f, green = 0.34f, blue = 0.76f)
            }
        UserBubbleColor.pink ->
            if (isLightChrome) {
                Color(red = 0.76f, green = 0.09f, blue = 0.38f)
            } else {
                Color(red = 0.72f, green = 0.08f, blue = 0.34f)
            }
        UserBubbleColor.purple ->
            if (isLightChrome) {
                Color(red = 0.48f, green = 0.23f, blue = 0.78f)
            } else {
                Color(red = 0.42f, green = 0.18f, blue = 0.74f)
            }
        UserBubbleColor.black ->
            if (isLightChrome) Color.Black else Color.White
    }

fun UserBubbleColor.bubbleForeground(
    colorScheme: ColorScheme,
    isLightChrome: Boolean,
): Color =
    when (this) {
        UserBubbleColor.default -> colorScheme.onSurface
        UserBubbleColor.black -> if (isLightChrome) Color.White else Color.Black
        else -> Color.White
    }

fun UserBubbleColor.mentionForeground(
    colorScheme: ColorScheme,
    isLightChrome: Boolean,
    fallback: Color,
): Color =
    if (this == UserBubbleColor.default) {
        fallback
    } else {
        bubbleForeground(colorScheme, isLightChrome)
    }

/** Accent fill for chrome (tabs, CTAs) — matches the user bubble color from Settings. */
fun UserBubbleColor.accentBackground(
    colorScheme: ColorScheme,
    isLightChrome: Boolean,
): Color = bubbleBackground(colorScheme, isLightChrome)

/** Text/icon color on [accentBackground]. */
fun UserBubbleColor.accentForeground(
    colorScheme: ColorScheme,
    isLightChrome: Boolean,
): Color = bubbleForeground(colorScheme, isLightChrome)
