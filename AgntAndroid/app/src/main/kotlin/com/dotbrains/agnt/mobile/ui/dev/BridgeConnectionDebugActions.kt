package com.dotbrains.agnt.mobile.ui.dev

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.AppContainer
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.CodexTrustedMacRegistry
import com.dotbrains.agnt.mobile.core.model.RPCMessage
import com.dotbrains.agnt.mobile.core.security.CodexSecureKeys
import com.dotbrains.agnt.mobile.core.security.PhoneIdentityStore
import com.dotbrains.agnt.mobile.data.CodexRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Composable
internal fun PhaseFDebugRpcSection(
    ready: Boolean,
    repository: CodexRepository,
    json: Json,
    logJson: Json,
    activeThreadId: String?,
    threads: List<CodexThread>,
    scope: CoroutineScope,
    onLog: (String) -> Unit,
) {
    HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
    Text(
        text = "Phase F debug â€” labeled RPC",
        style = MaterialTheme.typography.titleSmall,
    )
    Text(
        text = "Sends common bridge methods with fixed payloads; full reply is written to the log at the bottom.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    val invokeLabeled: (String, String) -> Unit = { method, paramsJson ->
        scope.launch {
            onLog(
                try {
                    withContext(Dispatchers.IO) {
                        runPhaseFJsonRpc(repository, json, logJson, method, paramsJson)
                    }
                } catch (e: Exception) {
                    "[$method] failed:\n${formatRpcDebugError(e)}"
                },
            )
        }
    }
    Button(
        onClick = { invokeLabeled("thread/list", phaseFThreadListParamsJson(archived = false)) },
        enabled = ready,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text("thread/list")
    }
    Button(
        onClick = { invokeLabeled("thread/list", phaseFThreadListParamsJson(archived = true)) },
        enabled = ready,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text("thread/list (archived)")
    }
    Button(
        onClick = {
            val tid = resolvePhaseFThreadId(activeThreadId, threads)
            if (tid == null) {
                onLog("thread/read: no thread id â€” run thread/list above or open a thread on the Mac.")
            } else {
                invokeLabeled(
                    "thread/read",
                    phaseFThreadScopedParamsJson(json, threadId = tid, includeTurns = false),
                )
            }
        },
        enabled = ready,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text("thread/read")
    }
    Button(
        onClick = {
            val tid = resolvePhaseFThreadId(activeThreadId, threads)
            if (tid == null) {
                onLog("thread/contextWindow/read: no thread id â€” run thread/list or set active thread.")
            } else {
                invokeLabeled(
                    "thread/contextWindow/read",
                    phaseFThreadScopedParamsJson(json, threadId = tid, includeTurns = null),
                )
            }
        },
        enabled = ready,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text("thread/contextWindow/read")
    }
    Button(
        onClick = { invokeLabeled("account/rateLimits/read", "{}") },
        enabled = ready,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text("account/rateLimits/read")
    }
}

private fun phaseFThreadListParamsJson(archived: Boolean): String {
    val base =
        """{"sourceKinds":["cli","vscode","appServer","exec","unknown"],"cursor":null,"limit":40"""
    return if (archived) "$base,\"archived\":true}" else "$base}"
}

private fun resolvePhaseFThreadId(
    activeThreadId: String?,
    threads: List<CodexThread>,
): String? =
    activeThreadId?.trim()?.takeIf { it.isNotEmpty() }
        ?: threads
            .firstOrNull()
            ?.id
            ?.trim()
            ?.takeIf { it.isNotEmpty() }

private fun phaseFThreadScopedParamsJson(
    json: Json,
    threadId: String,
    includeTurns: Boolean?,
): String {
    val obj: JsonElement =
        buildJsonObject {
            put("threadId", threadId)
            if (includeTurns != null) {
                put("includeTurns", includeTurns)
            }
        }
    return json.encodeToString(JsonElement.serializer(), obj)
}

private suspend fun runPhaseFJsonRpc(
    repository: CodexRepository,
    json: Json,
    logJson: Json,
    method: String,
    paramsJson: String,
): String {
    val params = parseOptionalRpcParams(json, paramsJson)
    val reply = repository.sendRequest(method, params)
    return "[$method]\n${formatRpcMessageForLog(logJson, reply)}"
}

internal fun parseOptionalRpcParams(
    json: Json,
    raw: String,
) = bridgeDebugParseOptionalRpcParams(json, raw)

internal fun formatRpcMessageForLog(
    logJson: Json,
    msg: RPCMessage,
): String = bridgeDebugFormatRpcMessageForLog(logJson, msg)

internal fun formatRpcDebugError(e: Throwable): String = bridgeDebugFormatRpcDebugError(e)

internal fun buildPersistedStateReport(): String {
    val snap = AppContainer.sessionPersistence.loadRelaySnapshot()
    val registry =
        AppContainer.secureStore.readCodable<CodexTrustedMacRegistry>(CodexSecureKeys.trustedMacRegistry)
            ?: CodexTrustedMacRegistry.empty
    val phone = PhoneIdentityStore.loadOrCreate(AppContainer.secureStore)
    val messages = AppContainer.messagePersistence.load()
    val changeSets = AppContainer.aiChangeSetPersistence.load()
    val msgTotal = messages.values.sumOf { it.size }
    val sid = snap.relaySessionId?.trim().orEmpty()
    val sidShort = if (sid.length > 12) "${sid.take(8)}â€¦" else sid
    return buildString {
        appendLine("Relay snapshot")
        appendLine("  sessionId: ${sidShort.ifEmpty { "(none)" }}")
        appendLine("  relayUrl: ${snap.relayUrl?.take(80) ?: "(none)"}")
        appendLine("  macDeviceId: ${snap.relayMacDeviceId ?: "(none)"}")
        appendLine("  lastTrustedMacDeviceId: ${snap.lastTrustedMacDeviceId ?: "(none)"}")
        appendLine("  relayLastAppliedBridgeOutboundSeq: ${snap.relayLastAppliedBridgeOutboundSeq ?: "(none)"}")
        appendLine("  forceQrBootstrapNextHandshake: ${AppContainer.sessionPersistence.shouldForceQrBootstrapOnNextHandshake()}")
        appendLine("  lastActiveThreadId: ${AppContainer.sessionPersistence.loadLastActiveThreadId() ?: "(none)"}")
        appendLine("Trusted Mac registry: ${registry.records.size} record(s)")
        for ((id, rec) in registry.records) {
            appendLine("  - mac $id displayName=${rec.displayName ?: "â€”"}")
        }
        appendLine("Phone identity")
        appendLine("  deviceId: ${phone.phoneDeviceId}")
        appendLine("  publicKey (b64 prefix): ${phone.phoneIdentityPublicKey.take(24)}â€¦")
        appendLine("Message history: ${messages.size} thread(s), $msgTotal message(s) total")
        appendLine("AI change sets: ${changeSets.size} entr(y/ies)")
    }
}

internal fun isLoopbackRelayHost(relayUrl: String): Boolean = bridgeDebugIsLoopbackRelayHost(relayUrl)

/** Replace host in relay base URL when user connects from emulator/phone (QR often uses 127.0.0.1). */
internal fun applyRelayHostOverride(
    relayUrl: String,
    overrideHost: String,
): String = bridgeDebugApplyRelayHostOverride(relayUrl, overrideHost)

internal fun formatConnectError(e: Throwable): String = bridgeDebugFormatConnectError(e)
