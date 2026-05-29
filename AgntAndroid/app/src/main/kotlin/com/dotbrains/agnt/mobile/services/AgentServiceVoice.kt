package com.dotbrains.agnt.mobile.services

import com.dotbrains.agnt.mobile.core.error.AgentServiceError
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.RPCError
import com.dotbrains.agnt.mobile.core.voice.CodexVoiceTranscriptionPreflight
import com.dotbrains.agnt.mobile.core.voice.GptVoiceTranscriptionClient
import com.dotbrains.agnt.mobile.core.voice.GptVoiceTranscriptionError
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Voice transcription transport (parity [AgentService+Voice.swift](CodexMobile/CodexMobile/Services/AgentService+Voice.swift)).
 * Bridge auth + ChatGPT multipart upload; no recorder/composer UI.
 */

internal fun parseVoiceAuthTokenFromResult(result: JSONValue?): String {
    val root =
        result as? JSONValue.Obj
            ?: throw AgentServiceError.InvalidResponse("voice/resolveAuth did not return a valid token")
    return extractVoiceAuthToken(root.map)
        ?: throw AgentServiceError.InvalidResponse("voice/resolveAuth did not return a valid token")
}

private fun extractVoiceAuthToken(map: Map<String, JSONValue>): String? {
    map["token"]?.stringValue?.trim()?.takeIf { it.isNotEmpty() }?.let {
        return it
    }
    for (key in listOf("data", "result")) {
        val nested = (map[key] as? JSONValue.Obj)?.map ?: continue
        extractVoiceAuthToken(nested)?.let {
            return it
        }
    }
    return null
}

internal suspend fun transcribeWavWithSingleAuthRetry(
    wavBytes: ByteArray,
    resolveToken: suspend () -> String,
    transcribe: suspend (ByteArray, String) -> String,
): String {
    val first = resolveToken()
    return try {
        transcribe(wavBytes, first)
    } catch (_: GptVoiceTranscriptionError.AuthExpired) {
        val second = resolveToken()
        transcribe(wavBytes, second)
    }
}

internal fun AgentService.consumeUnsupportedVoiceBridgeAuth(error: Throwable): Boolean {
    val rpc = (error as? AgentServiceError.RpcFailure)?.rpcError ?: return false
    if (!rpcIndicatesUnsupportedVoiceBridgeAuth(rpc)) return false
    supportsBridgeVoiceAuth = false
    return true
}

/** Exposed for JVM tests (parity iOS `shouldTreatAsUnsupportedVoiceBridgeAuth`). */
internal fun rpcIndicatesUnsupportedVoiceBridgeAuth(rpc: RPCError): Boolean {
    if (rpc.code == -32601) return true
    val message = rpc.message.lowercase()
    val mentionsUnsupportedRequest =
        message.contains("method not found") ||
            message.contains("unknown method") ||
            message.contains("not implemented") ||
            message.contains("does not support") ||
            message.contains("unknown variant") ||
            message.contains("expected one of")
    val mentionsBridgeVoiceMethod =
        message.contains("voice/resolveauth") ||
            message.contains("voice resolveauth") ||
            message.contains("voice/resolveauth`") ||
            message.contains("voice/transcribe") ||
            message.contains("voice transcribe") ||
            message.contains("voice/transcribe`")
    if (rpc.code != -32600 && rpc.code != -32602 && rpc.code != -32000) {
        return mentionsUnsupportedRequest && mentionsBridgeVoiceMethod
    }
    return mentionsUnsupportedRequest && mentionsBridgeVoiceMethod
}

private suspend fun AgentService.resolveVoiceAuthToken(): String {
    val response =
        try {
            sendRequestImpl("voice/resolveAuth", null)
        } catch (e: Exception) {
            consumeUnsupportedVoiceBridgeAuth(e)
            throw e
        }
    return parseVoiceAuthTokenFromResult(response.result)
}

internal suspend fun AgentService.transcribeBridgeVoiceWavImpl(
    wavBytes: ByteArray,
    durationSeconds: Double,
): String =
    withContext(Dispatchers.IO) {
        if (!sessionReady) throw AgentServiceError.Disconnected
        CodexVoiceTranscriptionPreflight(
            byteCount = wavBytes.size,
            durationSeconds = durationSeconds,
        ).validate()
        val client = GptVoiceTranscriptionClient(httpCallClient)
        transcribeWavWithSingleAuthRetry(
            wavBytes = wavBytes,
            resolveToken = { resolveVoiceAuthToken() },
            transcribe = { bytes, token -> client.transcribe(bytes, token) },
        )
    }
