package com.dotbrains.agnt.mobile.ui.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp

@Composable
fun TerminalAccessoryBar(
    actions: List<TerminalAccessoryButton>,
    pendingModifier: TerminalPendingModifier?,
    theme: TerminalTheme,
    isEnabled: Boolean,
    onAction: (TerminalAccessoryButton) -> Unit,
) {
    val borderColor = parseHex(theme.border)
    val foreground = parseHex(theme.foreground)
    val accent = parseHex(theme.palette.getOrElse(10) { theme.foreground })

    Box(
        modifier =
            Modifier
                .fillMaxWidth()
                .background(parseHex(theme.background)),
    ) {
        Row(
            modifier =
                Modifier
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 8.dp, vertical = 6.dp)
                    .height(40.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            actions.forEach { action ->
                val isActive = action.modifier != null && action.modifier == pendingModifier
                val textColor = if (isActive) accent else foreground
                val bgColor =
                    if (isActive) {
                        accent.copy(alpha = 0.18f)
                    } else {
                        foreground.copy(alpha = 0.07f)
                    }
                TextButton(
                    onClick = { onAction(action) },
                    enabled = isEnabled,
                    shape = RoundedCornerShape(10.dp),
                    modifier =
                        Modifier
                            .widthIn(min = if (action.label.length > 1) 44.dp else 36.dp)
                            .background(bgColor, RoundedCornerShape(10.dp))
                            .border(1.dp, if (isActive) accent.copy(alpha = 0.32f) else borderColor, RoundedCornerShape(10.dp)),
                ) {
                    Text(
                        text = if (action.isModifier) action.label.uppercase() else action.label,
                        style = MaterialTheme.typography.labelMedium,
                        color = textColor,
                    )
                }
            }
        }
    }
}

private fun parseHex(hex: String): Color {
    val cleaned = hex.removePrefix("#")
    return Color(android.graphics.Color.parseColor("#$cleaned"))
}

@Suppress("unused")
private fun Color.toHexArgb(): Int = toArgb()
