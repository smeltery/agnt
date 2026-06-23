package com.dotbrains.agnt.mobile.ui.terminal

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dotbrains.agnt.mobile.R

/**
 * Step-by-step PowerShell snippets the user can run on a Windows PC to expose an
 * OpenSSH server that the on-device terminal can connect to. A bespoke
 * flat-control-chrome modifier from the original import is replaced with Material 3
 * `Surface` so the component is self-contained.
 */
@Composable
fun TerminalWindowsSetupGuide(
    modifier: Modifier = Modifier,
    scrollable: Boolean = false,
) {
    val contentModifier =
        if (scrollable) {
            modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
        } else {
            modifier.fillMaxWidth()
        }
    Column(
        modifier = contentModifier,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text = stringResource(R.string.terminal_windows_guide_title),
            style =
                MaterialTheme.typography.titleMedium.copy(
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                ),
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            text = stringResource(R.string.terminal_windows_guide_intro),
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 14.sp, lineHeight = 20.sp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TerminalGuideStepCard(
            title = stringResource(R.string.terminal_windows_guide_step_1_title),
            command = stringResource(R.string.terminal_windows_guide_step_1_command),
        )
        TerminalGuideStepCard(
            title = stringResource(R.string.terminal_windows_guide_step_2_title),
            command = stringResource(R.string.terminal_windows_guide_step_2_command),
        )
        TerminalGuideStepCard(
            title = stringResource(R.string.terminal_windows_guide_step_3_title),
            command = stringResource(R.string.terminal_windows_guide_step_3_command),
        )
        TerminalGuideStepCard(
            title = stringResource(R.string.terminal_windows_guide_step_4_title),
            command = stringResource(R.string.terminal_windows_guide_step_4_command),
        )
        TerminalGuideStepCard(
            title = stringResource(R.string.terminal_windows_guide_step_5_title),
            command = stringResource(R.string.terminal_windows_guide_step_5_command),
        )
        TerminalInfoCard(text = stringResource(R.string.terminal_windows_guide_note))
    }
}

@Composable
private fun TerminalGuideStepCard(
    title: String,
    command: String,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = title,
            style =
                MaterialTheme.typography.bodyMedium.copy(
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                ),
            color = MaterialTheme.colorScheme.onSurface,
        )
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(12.dp),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.46f),
            tonalElevation = 1.dp,
        ) {
            Text(
                text = command,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                style =
                    MaterialTheme.typography.bodySmall.copy(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                        lineHeight = 17.sp,
                    ),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun TerminalInfoCard(
    text: String,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.46f),
        tonalElevation = 1.dp,
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 18.sp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
