package com.smeltery.agnt.mobile.services.agent.threads

import android.util.Log
import com.smeltery.agnt.mobile.core.error.AgentServiceError
import com.smeltery.agnt.mobile.core.model.JSONValue
import com.smeltery.agnt.mobile.core.model.RPCMessage
import com.smeltery.agnt.mobile.core.readAgntAppVersionName
import com.smeltery.agnt.mobile.services.agent.AgentService
import com.smeltery.agnt.mobile.services.agent.connection.handleEncryptedEnvelope
import com.smeltery.agnt.mobile.services.agent.connection.secureWireText
import com.smeltery.agnt.mobile.services.agent.connection.sendRawText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

private const val AGNT_WIRE_LOG_TAG = "AgntWire"

/**
 * Mirrors [AgentService+Messages.swift](../../../../../../../../CodexMobile/CodexMobile/Services/AgentService+Messages.swift).
 * Low-level JSON-RPC framing lives in [com.smeltery.agnt.mobile.core.protocol.JsonRpcCodec].
 */
internal suspend fun AgentService.sendRequestImpl(
    method: String,
    params: JSONValue?,
): RPCMessage {
    testRpcRequestHandler?.let { handler ->
        return handler(method, params)
    }
    if (!sessionReady) throw AgentServiceError.Disconnected
    val id = JSONValue.Str(UUID.randomUUID().toString())
    val req = RPCMessage.request(id = id, method = method, params = params, includeJsonRpc = false)
    val deferred = CompletableDeferred<RPCMessage>()
    pendingRpc[idKey(id)] = deferred
    try {
        sendMessage(req)
        return deferred.await()
    } finally {
        pendingRpc.remove(idKey(id))
    }
}

internal suspend fun AgentService.sendNotificationImpl(
    method: String,
    params: JSONValue?,
) {
    if (!sessionReady) throw AgentServiceError.Disconnected
    sendMessage(RPCMessage.notification(method = method, params = params, includeJsonRpc = false))
}

internal fun AgentService.sendMessage(message: RPCMessage) {
    val payload = jsonRpc.encodeMessage(message)
    val wire = secureWireText(payload)
    sendRawText(wire)
}

internal fun AgentService.processWireText(raw: String) {
    if (isSecureWirePreClassification(raw)) {
        val kind = wireMessageKind(raw) ?: return
        if (kind == "encryptedEnvelope") {
            handleEncryptedEnvelope(raw)
        } else {
            controlMux?.offer(kind, raw)
        }
        return
    }
    val message = jsonRpc.decodeMessage(raw) ?: return
    dispatchIncomingRpc(message)
}

private fun AgentService.isSecureWirePreClassification(text: String): Boolean {
    if (!text.contains("\"kind\":")) return false
    val markers =
        listOf(
            "\"serverHello\"",
            "\"secureReady\"",
            "\"secureError\"",
            "\"encryptedEnvelope\"",
        )
    return markers.any { text.contains(it) }
}

private fun AgentService.wireMessageKind(text: String): String? =
    try {
        val el = json.parseToJsonElement(text)
        (el as? JsonObject)?.get("kind")?.jsonPrimitive?.content
    } catch (e: Exception) {
        Log.w(AGNT_WIRE_LOG_TAG, "dropped malformed secure-control message bytes=${text.toByteArray().size}: ${e.javaClass.simpleName}")
        null
    }

internal fun AgentService.dispatchIncomingRpc(message: RPCMessage) {
    val method = message.method?.trim()
    if (method != null && message.id != null) {
        incomingRouter.dispatchServerRequest(
            method = method,
            requestId = message.id!!,
            params = message.params,
        ) { response ->
            runCatching { sendMessage(response) }
        }
        return
    }
    if (method != null) {
        incomingRouter.dispatchNotification(method, message.params)
        return
    }
    val id = message.id ?: return
    completePendingRpc(id, message)
}

internal fun AgentService.completePendingRpc(
    id: JSONValue,
    message: RPCMessage,
) {
    val key = idKey(id)
    val def = pendingRpc.remove(key) ?: return
    val err = message.error
    if (err != null) {
        def.completeExceptionally(AgentServiceError.RpcFailure(err))
    } else {
        def.complete(message)
    }
}

internal fun idKey(id: JSONValue): String =
    when (id) {
        is JSONValue.Str -> "s:${id.value}"
        is JSONValue.NumLong -> "i:${id.value}"
        is JSONValue.NumDouble -> "d:${id.value}"
        is JSONValue.Bool -> "b:${id.value}"
        is JSONValue.Null -> "null"
        else -> "complex:$id"
    }

internal suspend fun AgentService.initializeSession() {
    val appVersion = readAppVersion()
    val clientInfo =
        JSONValue.Obj(
            mapOf(
                "name" to JSONValue.Str("codexmobile_android"),
                "title" to JSONValue.Str("CodexMobile Android"),
                "version" to JSONValue.Str(appVersion),
            ),
        )
    val modern =
        JSONValue.Obj(
            mapOf(
                "clientInfo" to clientInfo,
                "capabilities" to
                    JSONValue.Obj(
                        mapOf("experimentalApi" to JSONValue.Bool(true)),
                    ),
            ),
        )
    val response =
        try {
            rpcRequestWhileHandshaking("initialize", modern)
        } catch (e: Exception) {
            if (!shouldRetryInitializeWithoutCapabilities(e)) {
                throw e
            }
            val legacy = JSONValue.Obj(mapOf("clientInfo" to clientInfo))
            rpcRequestWhileHandshaking("initialize", legacy)
        }
    captureActiveProviderFromInitializeResponse(response)
    sendMessage(RPCMessage.notification(method = "initialized", params = null, includeJsonRpc = false))
}

// Reads the bridge-managed `result.providerId` so the UI can pre-emptively gate
// Codex-only affordances (voice transcribe, account login, structured-JSON
// thread/generateTitle) instead of waiting for a `-32601` round-trip. Older
// bridges that don't publish providerId yield ActiveProvider.Unknown — the
// existing fail-once-then-hide fallbacks (bridgeSupportsVoiceTranscription,
// runCatching on thread/generateTitle) cover that gap.
internal fun AgentService.captureActiveProviderFromInitializeResponse(response: RPCMessage) {
    val resultObject = (response.result as? JSONValue.Obj)?.map ?: return
    val providerId = resultObject["providerId"]?.stringValue
    _activeProvider.value =
        com.smeltery.agnt.mobile.core.model.ActiveProvider
            .fromBridgeId(providerId)
}

private fun shouldRetryInitializeWithoutCapabilities(e: Throwable): Boolean {
    val rpc = (e as? AgentServiceError.RpcFailure)?.rpcError ?: return false
    if (rpc.code != -32600 && rpc.code != -32602) return false
    val msg = rpc.message.lowercase()
    if (!msg.contains("capabilities") && !msg.contains("experimentalapi")) return false
    return msg.contains("unknown") ||
        msg.contains("unexpected") ||
        msg.contains("unrecognized") ||
        msg.contains("invalid") ||
        msg.contains("unsupported") ||
        msg.contains("field")
}

internal suspend fun AgentService.rpcRequestWhileHandshaking(
    method: String,
    params: JSONValue?,
): RPCMessage {
    val id = JSONValue.Str(UUID.randomUUID().toString())
    val req = RPCMessage.request(id = id, method = method, params = params, includeJsonRpc = false)
    val deferred = CompletableDeferred<RPCMessage>()
    pendingRpc[idKey(id)] = deferred
    try {
        sendMessage(req)
        return deferred.await()
    } finally {
        pendingRpc.remove(idKey(id))
    }
}

internal fun AgentService.readAppVersion(): String = readAgntAppVersionName(appContext)
