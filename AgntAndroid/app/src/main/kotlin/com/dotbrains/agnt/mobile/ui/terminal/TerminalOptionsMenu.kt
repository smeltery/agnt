package com.dotbrains.agnt.mobile.ui.terminal

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.core.terminal.TerminalStatus
import com.composables.icons.lucide.R as LucideR

/**
 * Status pill + drop-down with text-size, sessions, and connection actions.
 * Mirrors `TerminalOptionsMenu.swift`.
 */
@Composable
fun TerminalOptionsMenu(
    statusLabel: String,
    statusTone: Color,
    errorDetail: String?,
    fontSize: Double,
    sessions: List<TerminalSessionItem>,
    activeTerminalId: String,
    isRunning: Boolean,
    hasConnectionConfiguration: Boolean,
    canClear: Boolean,
    canResetKnownHost: Boolean,
    onSelectSession: (String) -> Unit,
    onOpenNewTerminal: () -> Unit,
    onToggleConnection: () -> Unit,
    onOpenConnectionEditor: () -> Unit,
    onClear: () -> Unit,
    onResetKnownHost: () -> Unit,
    onAdjustFontSize: (Double) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }

    TextButton(onClick = { expanded = true }) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            androidx.compose.foundation.Canvas(modifier = Modifier.size(8.dp)) {
                drawCircle(color = statusTone)
            }
            Text(
                statusLabel,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }

    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
        DropdownMenuItem(
            enabled = false,
            text = {
                androidx.compose.foundation.layout.Column {
                    Text(statusLabel, style = MaterialTheme.typography.labelLarge)
                    if (!errorDetail.isNullOrBlank()) {
                        Text(
                            errorDetail,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            },
            onClick = {},
        )
        HorizontalDivider()
        DropdownMenuItem(
            text = { Text("A- ${formatFontSize(nextSmaller(fontSize))} pt") },
            enabled = fontSize > TERMINAL_FONT_SIZE_MIN,
            onClick = {
                onAdjustFontSize(-TERMINAL_FONT_SIZE_STEP)
                expanded = false
            },
        )
        DropdownMenuItem(
            text = { Text("A+ ${formatFontSize(nextLarger(fontSize))} pt") },
            enabled = fontSize < TERMINAL_FONT_SIZE_MAX,
            onClick = {
                onAdjustFontSize(TERMINAL_FONT_SIZE_STEP)
                expanded = false
            },
        )
        HorizontalDivider()
        sessions.forEach { session ->
            // Per-tab status dot + cwd subtitle. Mirrors the iOS multi-tab
            // menu (TerminalScreen.swift), which shows the same status color
            // and the cwd path under each tab label so users can pick the
            // right session at a glance when several are running.
            DropdownMenuItem(
                text = {
                    androidx.compose.foundation.layout.Column {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            androidx.compose.foundation.Canvas(modifier = Modifier.size(8.dp)) {
                                drawCircle(color = toneFor(session.status))
                            }
                            Text(
                                session.displayLabel,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                        val cwdText = session.cwd.trim().takeIf { it.isNotEmpty() }
                        if (cwdText != null) {
                            Text(
                                text = cwdText,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                modifier = Modifier.padding(start = 16.dp),
                            )
                        }
                    }
                },
                trailingIcon = {
                    if (session.terminalId == activeTerminalId) {
                        Icon(
                            painter = painterResource(LucideR.drawable.lucide_ic_check),
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                },
                onClick = {
                    onSelectSession(session.terminalId)
                    expanded = false
                },
            )
        }
        DropdownMenuItem(
            text = { Text("Open new terminal") },
            leadingIcon = {
                Icon(
                    painter = painterResource(LucideR.drawable.lucide_ic_plus),
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                )
            },
            onClick = {
                onOpenNewTerminal()
                expanded = false
            },
        )
        HorizontalDivider()
        DropdownMenuItem(
            text = { Text(if (isRunning) "Disconnect" else "Connect") },
            enabled = hasConnectionConfiguration || isRunning,
            onClick = {
                onToggleConnection()
                expanded = false
            },
        )
        DropdownMenuItem(
            text = { Text("SSH connection") },
            onClick = {
                onOpenConnectionEditor()
                expanded = false
            },
        )
        DropdownMenuItem(
            text = { Text("Clear") },
            enabled = canClear,
            onClick = {
                onClear()
                expanded = false
            },
        )
        DropdownMenuItem(
            text = { Text("Reset host key") },
            enabled = canResetKnownHost,
            onClick = {
                onResetKnownHost()
                expanded = false
            },
        )
    }
}

/** Tone color pill for status, mirrors iOS palette. */
fun toneFor(status: TerminalStatus): Color =
    when (status) {
        TerminalStatus.Running -> Color(0xFF34D399)
        TerminalStatus.Starting -> Color(0xFFF59E0B)
        TerminalStatus.Error -> Color(0xFFEF4444)
        TerminalStatus.Idle, TerminalStatus.Closed, TerminalStatus.Exited -> Color(0xFFEF4444)
    }

private fun nextSmaller(value: Double): Double = (value - TERMINAL_FONT_SIZE_STEP).coerceAtLeast(TERMINAL_FONT_SIZE_MIN)

private fun nextLarger(value: Double): Double = (value + TERMINAL_FONT_SIZE_STEP).coerceAtMost(TERMINAL_FONT_SIZE_MAX)

private fun formatFontSize(value: Double): String = "%.1f".format(value)
