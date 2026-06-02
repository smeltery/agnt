package com.dotbrains.agnt.mobile.ui.theme

import android.os.Build
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import com.dotbrains.agnt.mobile.core.model.AppFontStyle
import com.dotbrains.agnt.mobile.core.model.UserBubbleColor
import com.dotbrains.agnt.mobile.data.AppFontPreferences
import com.dotbrains.agnt.mobile.data.ThemePreferences
import com.dotbrains.agnt.mobile.data.UserBubblePreferences

/**
 * Selected user-message bubble color from Settings. Provided by [AgntTheme] so the timeline
 * recomposes when the preference changes; defaults to [UserBubbleColor.defaultValue] when unset.
 */
val LocalUserBubbleColor = staticCompositionLocalOf { UserBubbleColor.defaultValue }

private val LightColorScheme =
    lightColorScheme(
        primary = AgntLightPrimary,
        onPrimary = AgntLightOnPrimary,
        primaryContainer = AgntLightPrimaryContainer,
        onPrimaryContainer = AgntLightOnPrimaryContainer,
        secondary = AgntLightSecondary,
        onSecondary = AgntLightOnSecondary,
        secondaryContainer = AgntLightSecondaryContainer,
        onSecondaryContainer = AgntLightOnSecondaryContainer,
        tertiary = AgntLightSecondary,
        onTertiary = AgntLightOnSecondary,
        tertiaryContainer = AgntLightSecondaryContainer.copy(alpha = 0.94f),
        onTertiaryContainer = AgntLightOnSecondaryContainer,
        background = AgntLightBackground,
        onBackground = AgntLightOnBackground,
        surface = AgntLightSurface,
        onSurface = AgntLightOnSurface,
        surfaceVariant = AgntLightSurfaceVariant,
        onSurfaceVariant = AgntLightOnSurfaceVariant,
        outline = AgntLightOutline,
        outlineVariant = AgntLightOutlineVariant,
        error = AgntLightError,
        onError = AgntLightOnError,
    )

private val DarkColorScheme =
    darkColorScheme(
        primary = AgntDarkPrimary,
        onPrimary = AgntDarkOnPrimary,
        primaryContainer = AgntDarkPrimaryContainer,
        onPrimaryContainer = AgntDarkOnPrimaryContainer,
        secondary = AgntDarkSecondary,
        onSecondary = AgntDarkOnSecondary,
        secondaryContainer = AgntDarkSecondaryContainer,
        onSecondaryContainer = AgntDarkOnSecondaryContainer,
        tertiary = AgntDarkSecondary,
        onTertiary = AgntDarkOnSecondary,
        tertiaryContainer = AgntDarkSecondaryContainer.copy(alpha = 0.96f),
        onTertiaryContainer = AgntDarkOnSecondaryContainer,
        background = AgntDarkBackground,
        onBackground = AgntDarkOnBackground,
        surface = AgntDarkSurface,
        onSurface = AgntDarkOnSurface,
        surfaceVariant = AgntDarkSurfaceVariant,
        onSurfaceVariant = AgntDarkOnSurfaceVariant,
        outline = AgntDarkOutline,
        outlineVariant = AgntDarkOutlineVariant,
        error = AgntDarkError,
        onError = AgntDarkOnError,
    )

@Composable
fun AgntTheme(
    darkTheme: Boolean = false,
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    var appFontStyle by remember(context) { mutableStateOf(AppFontPreferences.readFontStyle(context)) }
    var userBubbleColor by remember(context) { mutableStateOf(UserBubblePreferences.read(context)) }
    DisposableEffect(context) {
        val prefs =
            context.applicationContext.getSharedPreferences(
                ThemePreferences.PREFS_NAME,
                android.content.Context.MODE_PRIVATE,
            )
        val listener =
            android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
                if (key == AppFontStyle.storageKey || key == AppFontStyle.legacyStorageKey) {
                    appFontStyle = AppFontPreferences.readFontStyle(context)
                }
                if (key == UserBubbleColor.storageKey) {
                    userBubbleColor = UserBubblePreferences.read(context)
                }
            }
        prefs.registerOnSharedPreferenceChangeListener(listener)
        onDispose {
            prefs.unregisterOnSharedPreferenceChangeListener(listener)
        }
    }
    val colorScheme =
        when {
            dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
                if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
            }
            darkTheme -> DarkColorScheme
            else -> LightColorScheme
        }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = agntTypography(appFontStyle),
        shapes = AgntShapes,
    ) {
        CompositionLocalProvider(LocalUserBubbleColor provides userBubbleColor) {
            content()
        }
    }
}
