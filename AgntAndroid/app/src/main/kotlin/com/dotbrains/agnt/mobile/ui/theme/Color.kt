package com.dotbrains.agnt.mobile.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Minimal mobile light palette (code-agent): warm white chroma + soft greys + few accents.
 *
 * Material `LightColorScheme` maps these values to roles (`AgntLight*` aliases below).
 */
object AgentLightColors {
    /** Screen/root background — warm white. */
    val ScreenBg = Color(0xFFFBFBFA)
    /** Default surface / opaque card (opaque here; overlays use Compose alpha where needed). */
    val Surface = Color(0xFFFFFFFF)
    /** Pills / composer-adjacent soft fills. */
    val SurfaceSoft = Color(0xFFF4F4F4)

    /** Light separators / “almost invisible” borders. */
    val Border = Color(0xFFEAEAEA)

    val TextPrimary = Color(0xFF171717)
    val TextSecondary = Color(0xFF777777)
    val TextMuted = Color(0xFFB5B5B5)

    val LinkBlue = Color(0xFF2F80ED)

    val AdditionGreen = Color(0xFF35C76A)
    val DeletionRed = Color(0xFFFF5A65)
    val WarningOrange = Color(0xFFFF9B45)

    val IconMuted = Color(0xFF8E8E93)
}

// Light — maps [AgentLightColors] onto Material tokens used across the app
val AgntLightBackground = AgentLightColors.ScreenBg
val AgntLightSurface = AgentLightColors.Surface
val AgntLightSurfaceVariant = AgentLightColors.SurfaceSoft
val AgntLightOnBackground = AgentLightColors.TextPrimary
val AgntLightOnSurface = AgentLightColors.TextPrimary
/** Body / labels on surface (secondary text). */
val AgntLightOnSurfaceVariant = AgentLightColors.TextSecondary
val AgntLightPrimary = AgentLightColors.TextPrimary
val AgntLightOnPrimary = AgentLightColors.Surface
val AgntLightPrimaryContainer = AgentLightColors.SurfaceSoft
val AgntLightOnPrimaryContainer = AgentLightColors.TextPrimary

val AgntLightSecondary = AgentLightColors.LinkBlue
val AgntLightOnSecondary = AgentLightColors.Surface
/** Link / Thinking pill tint. */
private val SecondaryContainerBlend = AgentLightColors.LinkBlue.copy(alpha = 0.10f)

val AgntLightSecondaryContainer =
    SecondaryContainerBlend.over(AgentLightColors.Surface)
/** Solid fill for readability on white/soft surfaces. */
val AgntLightOnSecondaryContainer = AgentLightColors.LinkBlue

val AgntLightOutline = AgentLightColors.Border
val AgntLightOutlineVariant = AgentLightColors.TextMuted

val AgntLightError = AgentLightColors.DeletionRed
val AgntLightOnError = AgentLightColors.Surface

private fun Color.over(base: Color): Color {
    val a = alpha
    if (a <= 0f) return base
    if (a >= 1f) return this
    fun ch(c: Float, b: Float) = b * (1f - a) + c * a
    return Color(red = ch(red, base.red), green = ch(green, base.green), blue = ch(blue, base.blue))
}

// Dark — graphite surfaces (reference warm gray, not pure black)
val AgntDarkBackground = Color(0xFF101214)
val AgntDarkSurface = Color(0xFF15181B)
val AgntDarkSurfaceVariant = Color(0xFF202429)
val AgntDarkOnBackground = Color(0xFFECE9E1)
val AgntDarkOnSurface = Color(0xFFECE9E1)
val AgntDarkOnSurfaceVariant = Color(0xFFB9B3A8)
val AgntDarkPrimary = Color(0xFFECE9E1)
val AgntDarkOnPrimary = Color(0xFF101214)
val AgntDarkPrimaryContainer = Color(0xFF2A2F35)
val AgntDarkOnPrimaryContainer = Color(0xFFECE9E1)
val AgntDarkSecondary = Color(0xFF9CC7AE)
val AgntDarkOnSecondary = Color(0xFF101214)
val AgntDarkSecondaryContainer = Color(0xFF2A3D34)
val AgntDarkOnSecondaryContainer = Color(0xFFD4E5DC)
val AgntDarkOutline = Color(0xFF41464C)
val AgntDarkOutlineVariant = Color(0xFF6B7268)
val AgntDarkError = Color(0xFFFFB4AB)
val AgntDarkOnError = Color(0xFF690005)

/** Git-style addition line counts (toolbar + timeline). */
val AgntGitAddition = AgentLightColors.AdditionGreen

/** Unified-diff row washes (inline patch); light: very soft tint on warm screen bg. */
val AgntGitDiffAdditionBgLight =
    AgentLightColors.AdditionGreen.copy(alpha = 0.055f).over(AgentLightColors.ScreenBg)
val AgntGitDiffDeletionBgLight =
    AgentLightColors.DeletionRed.copy(alpha = 0.045f).over(AgentLightColors.ScreenBg)
val AgntGitDiffAdditionBgDark = Color(0xFF143524)
val AgntGitDiffDeletionBgDark = Color(0xFF3A181C)
val AgntGitDiffMetaBgLight = Color(0x14000000)
val AgntGitDiffMetaBgDark = Color(0x22FFFFFF)

/** Full-access (shield-alert) light icon — matches warning/orange accent from AgentLightColors. */
val AgntFullAccessIconLight = AgentLightColors.WarningOrange
val AgntFullAccessIconDark = Color(0xFFE8A87C)
