package com.dotbrains.agnt.mobile.ui.terminal

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.R as LucideR
import com.dotbrains.agnt.mobile.core.terminal.TerminalProfile

/**
 * Modal bottom sheet for editing the on-device SSH connection profile.
 * Mirrors `TerminalConnectionEditorSheet.swift`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalConnectionEditorSheet(
    initialProfile: TerminalProfile,
    initialPrivateKey: String,
    initialPassphrase: String,
    canSave: (TerminalProfile, String) -> Boolean,
    onDismiss: () -> Unit,
    onResetKnownHost: (TerminalProfile) -> Unit,
    onSave: (profile: TerminalProfile, connectionString: String, privateKey: String, passphrase: String) -> Unit,
) {
    var profile by remember { mutableStateOf(initialProfile) }
    var connection by remember { mutableStateOf(initialProfile.connectionString) }
    var privateKey by remember { mutableStateOf(initialPrivateKey) }
    var passphrase by remember { mutableStateOf(initialPassphrase) }
    var showAdvanced by remember { mutableStateOf(profile.port != TerminalProfile.DEFAULT_PORT || profile.cwd.isNotBlank()) }
    var showKey by remember { mutableStateOf(privateKey.isBlank()) }
    var confirmingHostReset by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    val resolvedProfile = remember(profile, connection) { profile.applyingConnectionString(connection).normalizedForSave() }
    val saveEnabled = canSave(resolvedProfile, privateKey)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                TextButton(onClick = onDismiss) { Text("Cancel") }
                Text("New Server", style = MaterialTheme.typography.titleMedium)
                TextButton(
                    onClick = {
                        onSave(resolvedProfile, connection, privateKey.trim(), passphrase)
                    },
                    enabled = saveEnabled,
                ) { Text("Connect") }
            }

            EditorSection("Connection") {
                OutlinedTextField(
                    value = connection,
                    onValueChange = { connection = it },
                    label = { Text("user@hostname") },
                    singleLine = true,
                    keyboardOptions =
                        KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            EditorSection("Nickname") {
                OutlinedTextField(
                    value = profile.nickname,
                    onValueChange = { profile = profile.copy(nickname = it) },
                    label = { Text("Optional label") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            EditorSection("Authentication") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("SSH Key", style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = { showKey = !showKey }) {
                        Text(
                            if (showKey) {
                                "Hide"
                            } else if (privateKey.isBlank()) {
                                "Paste"
                            } else {
                                "Edit"
                            },
                        )
                    }
                }
                if (showKey || privateKey.isBlank()) {
                    OutlinedTextField(
                        value = privateKey,
                        onValueChange = { privateKey = it },
                        label = { Text("Private key (PEM)") },
                        textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .height(160.dp),
                    )
                } else {
                    Text(
                        "Private key saved",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                var passphraseHidden by remember { mutableStateOf(true) }
                OutlinedTextField(
                    value = passphrase,
                    onValueChange = { passphrase = it },
                    label = { Text("Passphrase (optional)") },
                    visualTransformation =
                        if (passphraseHidden) PasswordVisualTransformation() else VisualTransformation.None,
                    singleLine = true,
                    trailingIcon = {
                        IconButton(onClick = { passphraseHidden = !passphraseHidden }) {
                            Icon(
                                painter =
                                    painterResource(
                                        if (passphraseHidden) {
                                            LucideR.drawable.lucide_ic_eye
                                        } else {
                                            LucideR.drawable.lucide_ic_eye_off
                                        },
                                    ),
                                contentDescription = if (passphraseHidden) "Show" else "Hide",
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            EditorSection("SSH") {
                TextButton(
                    onClick = { showAdvanced = !showAdvanced },
                    contentPadding = PaddingValues(0.dp),
                ) {
                    Text(if (showAdvanced) "Hide advanced" else "Advanced configuration")
                }
                if (showAdvanced) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        OutlinedTextField(
                            value = profile.port.toString(),
                            onValueChange = { value ->
                                val parsed = value.toIntOrNull()
                                if (parsed != null) {
                                    profile = profile.copy(port = parsed.coerceIn(1, 65_535))
                                } else if (value.isBlank()) {
                                    profile = profile.copy(port = TerminalProfile.DEFAULT_PORT)
                                }
                            },
                            label = { Text("Port") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                        OutlinedTextField(
                            value = profile.cwd,
                            onValueChange = { profile = profile.copy(cwd = it) },
                            label = { Text("Working directory") },
                            singleLine = true,
                            modifier = Modifier.weight(2f),
                        )
                    }
                }

                HorizontalDivider()
                TextButton(
                    onClick = { confirmingHostReset = true },
                    enabled = profile.host.isNotBlank() || resolvedProfile.host.isNotBlank(),
                    contentPadding = PaddingValues(0.dp),
                ) {
                    Text("Reset known host key")
                }
            }
        }
    }

    if (confirmingHostReset) {
        AlertDialog(
            onDismissRequest = { confirmingHostReset = false },
            confirmButton = {
                TextButton(onClick = {
                    confirmingHostReset = false
                    onResetKnownHost(resolvedProfile)
                }) { Text("Reset") }
            },
            dismissButton = {
                TextButton(onClick = { confirmingHostReset = false }) { Text("Cancel") }
            },
            title = { Text("Reset saved host key?") },
            text = {
                Text("The next connection to this host will trust the key it presents.")
            },
        )
    }
}

@Composable
private fun EditorSection(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            title,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(18.dp),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.46f),
            tonalElevation = 1.dp,
        ) {
            Column(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                content()
            }
        }
    }
}
