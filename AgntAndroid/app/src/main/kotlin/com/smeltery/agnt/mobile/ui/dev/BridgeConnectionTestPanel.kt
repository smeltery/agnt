package com.smeltery.agnt.mobile.ui.dev

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.smeltery.agnt.mobile.AppContainer
import com.smeltery.agnt.mobile.core.model.CodexPairingQRPayload
import com.smeltery.agnt.mobile.core.transport.ConnectionState
import com.smeltery.agnt.mobile.data.CodexRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json

/**
 * Debug harness: pairing, connect, JSON-RPC request/notification, persisted state dump, clear pairing.
 * Shipped only in debug builds ([com.smeltery.agnt.mobile.BuildConfig.DEBUG]).
 */
@Composable
fun BridgeConnectionTestPanel(
    repository: CodexRepository,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val ready by repository.isSessionReady.collectAsStateWithLifecycle()
    val connectionState by repository.connectionState.collectAsStateWithLifecycle()
    val threads by repository.threads.collectAsStateWithLifecycle()
    val activeThreadId by repository.activeThreadId.collectAsStateWithLifecycle()

    var qrJson by remember { mutableStateOf("") }
    var tokenOverride by remember { mutableStateOf("") }
    var relayHostOverride by remember { mutableStateOf("") }
    var log by remember { mutableStateOf("") }
    var showQrScanner by remember { mutableStateOf(false) }
    var rpcMethod by remember { mutableStateOf("") }
    var rpcParamsJson by remember { mutableStateOf("{}") }

    val context = LocalContext.current

    fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED

    val cameraPermissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                showQrScanner = true
                log = "Camera permission granted."
            } else {
                log = "Camera permission denied. Enable it in Settings → Apps → agnt → Permissions."
            }
        }

    val json =
        remember {
            Json {
                ignoreUnknownKeys = true
                encodeDefaults = true
            }
        }
    val logJson =
        remember {
            Json {
                ignoreUnknownKeys = true
                encodeDefaults = true
                prettyPrint = true
            }
        }

    Card(
        modifier = modifier.fillMaxWidth(),
        colors =
            CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
            ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "Debug: bridge connection",
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text =
                    when (val cs = connectionState) {
                        ConnectionState.Offline -> "Connection: offline"
                        ConnectionState.Connecting -> "Connection: connectingâ€¦"
                        ConnectionState.Connected -> "Connection: connected (JSON-RPC session ready)"
                        is ConnectionState.Error -> "Connection: error â€” ${cs.message}"
                    },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                text =
                    if (ready) {
                        "Session: initialize OK Â· ${threads.size} thread(s) in cache" +
                            (activeThreadId?.let { " Â· active=$it" } ?: "")
                    } else {
                        "Session: not ready for RPC"
                    },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(
                onClick = {
                    scope.launch {
                        runCatching { repository.refreshThreads() }
                            .onFailure { e -> log = "refreshThreads: ${e.message}" }
                            .onSuccess { log = "refreshThreads: OK (see count above after recomposition)." }
                    }
                },
                enabled = ready,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Refresh thread list (thread/list)")
            }
            PhaseFDebugRpcSection(
                ready = ready,
                repository = repository,
                json = json,
                logJson = logJson,
                activeThreadId = activeThreadId,
                threads = threads,
                scope = scope,
                onLog = { log = it },
            )
            Text(
                text =
                    "Apply saves pairing from the JSON. Connect builds ws URL as relay + / + sessionId. " +
                        "Bearer defaults to sessionId. " +
                        "Emulator: set relay host override to 10.0.2.2. " +
                        "Physical phone: same Wiâ€‘Fi as the PC, override host = PC LAN IP (e.g. 192.168.x.x); " +
                        "127.0.0.1 in the JSON always means â€œthis deviceâ€, not your computer. " +
                        "Windows: allow Node through the firewall for the relay port (default 9000).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text =
                    if (hasCameraPermission()) {
                        "Camera: allowed â€” you can scan the bridge pairing QR."
                    } else {
                        "Camera: not granted â€” tap â€œScan pairing QRâ€ to allow the camera."
                    },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(
                onClick = {
                    if (hasCameraPermission()) {
                        showQrScanner = true
                    } else {
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Scan pairing QR")
            }
            OutlinedTextField(
                value = qrJson,
                onValueChange = { qrJson = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Pairing QR JSON") },
                minLines = 4,
                maxLines = 10,
            )
            OutlinedTextField(
                value = tokenOverride,
                onValueChange = { tokenOverride = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Bearer token (optional)") },
                singleLine = true,
                placeholder = { Text("empty = use sessionId") },
            )
            OutlinedTextField(
                value = relayHostOverride,
                onValueChange = { relayHostOverride = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Relay host override (required if relay is 127.0.0.1)") },
                singleLine = true,
                placeholder = { Text("PC IPv4 e.g. 192.168.1.10 â€” emulator: 10.0.2.2") },
            )
            Button(
                onClick = {
                    scope.launch {
                        log =
                            try {
                                val payload = json.decodeFromString<CodexPairingQRPayload>(qrJson.trim())
                                withContext(Dispatchers.IO) {
                                    AppContainer.sessionPersistence.applyPairingPayload(
                                        payload,
                                        AppContainer.secureStore,
                                    )
                                }
                                "Pairing saved. Relay=${payload.relay.take(48)}â€¦"
                            } catch (e: Exception) {
                                "Apply failed: ${e.message ?: e::class.simpleName}"
                            }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Apply QR JSON")
            }
            Button(
                onClick = {
                    scope.launch {
                        log =
                            try {
                                val snap =
                                    withContext(Dispatchers.IO) {
                                        AppContainer.sessionPersistence.loadRelaySnapshot()
                                    }
                                val relayRaw =
                                    snap.relayUrl?.trim()?.takeIf { it.isNotEmpty() }
                                        ?: error("No relay URL â€” apply QR JSON first.")
                                if (relayHostOverride.trim().isEmpty() &&
                                    isLoopbackRelayHost(relayRaw)
                                ) {
                                    error(
                                        "Relay uses 127.0.0.1 / localhost â€” on the phone that means " +
                                            "the phone itself, not your PC, so nothing is listening on port 9000 here. " +
                                            "Type your computer's Wiâ€‘Fi IP in \"Relay host override\" " +
                                            "(ipconfig â†’ IPv4, e.g. 192.168.1.x). " +
                                            "Emulator: use 10.0.2.2. Same Wiâ€‘Fi as the PC; Windows: firewall allow Node on 9000.",
                                    )
                                }
                                withContext(Dispatchers.IO) {
                                    val relay =
                                        applyRelayHostOverride(relayRaw, relayHostOverride)
                                    val sessionId =
                                        snap.relaySessionId?.trim()?.takeIf { it.isNotEmpty() }
                                            ?: error("No session id â€” apply QR JSON first.")
                                    val url = "${relay.trimEnd('/')}/$sessionId"
                                    val token = tokenOverride.trim().ifEmpty { sessionId }
                                    repository.connect(serverUrl = url, token = token, role = null)
                                }
                                "connect() finished OK."
                            } catch (e: Exception) {
                                "Connect failed:\n${formatConnectError(e)}"
                            }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Connect (saved pairing)")
            }
            Button(
                onClick = {
                    scope.launch {
                        log =
                            try {
                                withContext(Dispatchers.IO) {
                                    repository.disconnect()
                                }
                                "Disconnected."
                            } catch (e: Exception) {
                                "Disconnect: ${e.message ?: e::class.simpleName}"
                            }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Disconnect")
            }

            HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
            Text(
                text = "RPC (session must be connected)",
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                text =
                    "Methods under workspace/* (and similar) need a path on the machine running the bridge â€” " +
                        "add \"cwd\" or \"currentWorkingDirectory\" in Params (JSON), e.g. " +
                        "{\"cwd\":\"C:\\\\Users\\\\you\\\\Desktop\\\\apps\\\\agnt\"}. " +
                        "That path is validated on the PC/Mac, not on the phone.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = rpcMethod,
                onValueChange = { rpcMethod = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Method") },
                singleLine = true,
                enabled = ready,
                placeholder = { Text("e.g. workspace/revertPatchPreview (needs cwd in params)") },
            )
            OutlinedTextField(
                value = rpcParamsJson,
                onValueChange = { rpcParamsJson = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Params (JSON object or empty)") },
                minLines = 2,
                maxLines = 6,
                enabled = ready,
                placeholder = { Text("{\"cwd\":\"C:\\\\â€¦\\\\repo\"} for workspace/* on bridge host") },
            )
            Button(
                onClick = {
                    scope.launch {
                        log =
                            try {
                                val method = rpcMethod.trim().ifEmpty { error("Enter a method name.") }
                                val params = parseOptionalRpcParams(json, rpcParamsJson)
                                val reply =
                                    withContext(Dispatchers.IO) {
                                        repository.sendRequest(method, params)
                                    }
                                "sendRequest OK:\n${formatRpcMessageForLog(logJson, reply)}"
                            } catch (e: Exception) {
                                "sendRequest failed:\n${formatRpcDebugError(e)}"
                            }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = ready,
            ) {
                Text("Send JSON-RPC request")
            }
            Button(
                onClick = {
                    scope.launch {
                        log =
                            try {
                                val method = rpcMethod.trim().ifEmpty { error("Enter a method name.") }
                                val params = parseOptionalRpcParams(json, rpcParamsJson)
                                withContext(Dispatchers.IO) {
                                    repository.sendNotification(method, params)
                                }
                                "sendNotification sent: $method"
                            } catch (e: Exception) {
                                "sendNotification failed:\n${formatRpcDebugError(e)}"
                            }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = ready,
            ) {
                Text("Send notification (no response)")
            }

            HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
            Text(
                text = "Persisted state",
                style = MaterialTheme.typography.titleSmall,
            )
            Button(
                onClick = {
                    scope.launch {
                        log =
                            try {
                                withContext(Dispatchers.IO) {
                                    buildPersistedStateReport()
                                }
                            } catch (e: Exception) {
                                "Dump state failed: ${e.message ?: e::class.simpleName}"
                            }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Dump saved session / identity / caches")
            }
            Button(
                onClick = {
                    scope.launch {
                        log =
                            try {
                                withContext(Dispatchers.IO) {
                                    AppContainer.sessionPersistence.clearRelaySession()
                                }
                                "Relay pairing cleared. Apply QR JSON again before Connect."
                            } catch (e: Exception) {
                                "Clear pairing failed: ${e.message ?: e::class.simpleName}"
                            }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Clear relay pairing (debug)")
            }

            if (log.isNotEmpty()) {
                Text(
                    text = log,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }

    if (showQrScanner && hasCameraPermission()) {
        Dialog(onDismissRequest = { showQrScanner = false }) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors =
                    CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                    ),
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = "Scan the pairing QR from the bridge terminal",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    PairingQrScanner(
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .height(360.dp),
                        onDecodedPayload = { raw ->
                            qrJson = raw
                            showQrScanner = false
                            log = "QR captured. Tap â€œApply QR JSONâ€ to save pairing."
                        },
                    )
                    TextButton(
                        onClick = { showQrScanner = false },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Cancel")
                    }
                }
            }
        }
    }
}
