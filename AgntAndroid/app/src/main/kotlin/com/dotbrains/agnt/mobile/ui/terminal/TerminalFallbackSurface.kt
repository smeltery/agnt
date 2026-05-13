package com.dotbrains.agnt.mobile.ui.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dotbrains.agnt.mobile.core.terminal.TerminalSnapshot

/**
 * Read-only buffer + simple text input used when the WebView surface is unavailable.
 * Mirrors `TerminalFallbackSurface.swift`.
 */
@Composable
fun TerminalFallbackSurface(
    snapshot: TerminalSnapshot,
    fontSize: Double,
    theme: TerminalTheme,
    isRunning: Boolean,
    onInput: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var input by remember { mutableStateOf("") }
    val foreground = parseHex(theme.foreground)
    val background = parseHex(theme.background)
    val border = parseHex(theme.border)
    val muted = parseHex(theme.mutedForeground)
    val rendered = remember(snapshot.bufferData) {
        val text = String(snapshot.bufferData, Charsets.UTF_8)
        text.ifEmpty { "$ " }
    }

    Column(modifier = modifier.fillMaxSize().background(background)) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = if (isRunning) {
                    "Native terminal unavailable. Using text fallback."
                } else {
                    "Open terminal to start a shell."
                },
                style = MaterialTheme.typography.labelSmall,
                color = muted,
            )
            Box(modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())) {
                Text(
                    text = rendered,
                    color = foreground,
                    fontFamily = FontFamily.Monospace,
                    style = TextStyle(fontSize = fontSize.sp),
                )
            }
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, border)
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            BasicTextField(
                value = input,
                onValueChange = { input = it },
                singleLine = true,
                enabled = isRunning,
                textStyle = TextStyle(
                    color = foreground,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 14.sp,
                ),
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Send),
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 6.dp),
            )
            TextButton(
                onClick = {
                    if (input.isNotEmpty()) {
                        onInput(input + "\n")
                        input = ""
                    }
                },
                enabled = isRunning,
            ) { Text("Send") }
            TextButton(
                onClick = { onInput(Char(0x03).toString()) },
                enabled = isRunning,
                shape = RoundedCornerShape(8.dp),
            ) { Text("Ctrl-C") }
        }
    }
}

private fun parseHex(hex: String): Color {
    val cleaned = hex.removePrefix("#")
    return Color(android.graphics.Color.parseColor("#$cleaned"))
}
