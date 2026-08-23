package com.smeltery.agnt.mobile.services.agent.connection

import com.smeltery.agnt.mobile.core.crypto.AgntNativeCrypto
import com.smeltery.agnt.mobile.core.model.AGNT_TRUSTED_SESSION_RESOLVE_CLOCK_SKEW_TOLERANCE_SECONDS
import com.smeltery.agnt.mobile.core.model.CodexRelayErrorResponse
import com.smeltery.agnt.mobile.core.model.CodexTrustedMacRecord
import com.smeltery.agnt.mobile.core.model.CodexTrustedSessionResolveError
import com.smeltery.agnt.mobile.core.model.CodexTrustedSessionResolveRequest
import com.smeltery.agnt.mobile.core.model.CodexTrustedSessionResolveResponse
import com.smeltery.agnt.mobile.core.model.base64DecodeOrEmpty
import com.smeltery.agnt.mobile.core.model.codexTrustedSessionResolveResponseTranscriptBytes
import com.smeltery.agnt.mobile.core.model.codexTrustedSessionResolveTranscriptBytes
import com.smeltery.agnt.mobile.core.security.PhoneIdentityStore
import com.smeltery.agnt.mobile.core.security.SecureStore
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.Base64
import java.util.UUID

/**
 * Resolves the relay URL candidates for the E2EE trusted-session-resolve endpoint. The relay may be
 * pointed at either `.../relay` (front-door) or a bare host; both shapes resolve to
 * `.../v1/trusted/session/resolve`.
 */
object AgntTrustedSessionResolveURLBuilder {
    fun candidates(relayUrl: String): List<String> {
        val normalized = relayUrl.trim()
        if (normalized.isEmpty()) return emptyList()
        val httpish =
            when {
                normalized.startsWith("wss://", ignoreCase = true) ->
                    "https://${normalized.substring(6)}"
                normalized.startsWith("ws://", ignoreCase = true) ->
                    "http://${normalized.substring(5)}"
                else -> normalized
            }
        val parsed = httpish.toHttpUrlOrNull() ?: return emptyList()
        val pathParts =
            parsed.encodedPath
                .trim('/')
                .split('/')
                .filter { it.isNotEmpty() }
        val candidates = mutableListOf<String>()
        val builder = parsed.newBuilder().query(null).fragment(null)
        if (pathParts.lastOrNull() == "relay") {
            val prefix = pathParts.dropLast(1)
            val resolvePath = (prefix + listOf("v1", "trusted", "session", "resolve")).joinToString("/")
            candidates += builder.encodedPath("/$resolvePath").build().toString()
        }
        val rootResolve = builder.encodedPath("/v1/trusted/session/resolve").build().toString()
        if (!candidates.contains(rootResolve)) {
            candidates += rootResolve
        }
        return candidates
    }
}

/**
 * E2EE trusted-session-resolve HTTP client. Signs a per-request transcript with the phone identity
 * key, posts it to the relay, and verifies the relay's signed response before applying the resolved
 * bridge session. Provider-agnostic: built on QR pairing + the phone/Mac identity keys.
 */
internal class AgntTrustedSessionResolveClient(
    private val httpClient: OkHttpClient,
    private val secureStore: SecureStore,
    private val json: Json,
) {
    @Volatile
    private var activeCall: okhttp3.Call? = null

    fun cancel() {
        activeCall?.cancel()
        activeCall = null
    }

    suspend fun resolveTrustedMacSession(
        trustedMac: CodexTrustedMacRecord,
        relayUrlOverride: String? = null,
    ): CodexTrustedSessionResolveResponse {
        val relayURL =
            relayUrlOverride?.trim()?.takeIf { it.isNotEmpty() }
                ?: trustedMac.relayURL?.trim()?.takeIf { it.isNotEmpty() }
                ?: throw CodexTrustedSessionResolveError.NoTrustedMac
        val resolveURLs = AgntTrustedSessionResolveURLBuilder.candidates(relayURL)
        if (resolveURLs.isEmpty()) {
            throw CodexTrustedSessionResolveError.InvalidResponse("The trusted device relay URL is invalid.")
        }
        var lastRetriable: CodexTrustedSessionResolveError? = null
        resolveURLs.forEachIndexed { index, resolveURL ->
            try {
                return sendResolveRequest(trustedMac, resolveURL, relayURL)
            } catch (error: CodexTrustedSessionResolveError) {
                if (shouldTryNextCandidate(error) && index < resolveURLs.lastIndex) {
                    lastRetriable = error
                } else {
                    throw error
                }
            }
        }
        throw lastRetriable ?: CodexTrustedSessionResolveError.UnsupportedRelay
    }

    private fun shouldTryNextCandidate(error: CodexTrustedSessionResolveError): Boolean =
        when (error) {
            is CodexTrustedSessionResolveError.UnsupportedRelay,
            is CodexTrustedSessionResolveError.InvalidResponse,
            is CodexTrustedSessionResolveError.Network,
            -> true
            is CodexTrustedSessionResolveError.MacOffline,
            is CodexTrustedSessionResolveError.RePairRequired,
            CodexTrustedSessionResolveError.NoTrustedMac,
            -> false
        }

    private fun sendResolveRequest(
        trustedMac: CodexTrustedMacRecord,
        resolveURL: String,
        relayURL: String,
    ): CodexTrustedSessionResolveResponse {
        val phone = PhoneIdentityStore.loadOrCreate(secureStore)
        val nonce = UUID.randomUUID().toString()
        val timestamp = System.currentTimeMillis()
        val transcriptBytes =
            codexTrustedSessionResolveTranscriptBytes(
                macDeviceId = trustedMac.macDeviceId,
                phoneDeviceId = phone.phoneDeviceId,
                phoneIdentityPublicKey = phone.phoneIdentityPublicKey,
                nonce = nonce,
                timestamp = timestamp,
            )
        val phonePrivate = base64DecodeOrEmpty(phone.phoneIdentityPrivateKey)
        val signature = Base64.getEncoder().encodeToString(AgntNativeCrypto.ed25519Sign(transcriptBytes, phonePrivate))
        val requestBody =
            CodexTrustedSessionResolveRequest(
                macDeviceId = trustedMac.macDeviceId,
                phoneDeviceId = phone.phoneDeviceId,
                phoneIdentityPublicKey = phone.phoneIdentityPublicKey,
                nonce = nonce,
                timestamp = timestamp,
                signature = signature,
            )
        val bodyJson = json.encodeToString(CodexTrustedSessionResolveRequest.serializer(), requestBody)
        val request =
            Request
                .Builder()
                .url(resolveURL)
                .post(bodyJson.toRequestBody("application/json".toMediaType()))
                .build()
        val call = httpClient.newCall(request)
        activeCall = call
        val response =
            try {
                call.execute()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (call.isCanceled()) throw CancellationException()
                throw CodexTrustedSessionResolveError.Network(
                    "Could not reach the trusted device relay. Check your connection and try again.",
                )
            } finally {
                if (activeCall == call) activeCall = null
            }
        response.use { httpResponse ->
            val data = httpResponse.body?.string().orEmpty()
            if (httpResponse.code in 200..299) {
                val resolved =
                    runCatching {
                        json.decodeFromString<CodexTrustedSessionResolveResponse>(data)
                    }.getOrNull()
                        ?: throw CodexTrustedSessionResolveError.InvalidResponse(
                            "The trusted device relay returned malformed session data.",
                        )
                if (!resolved.ok) {
                    throw CodexTrustedSessionResolveError.InvalidResponse(
                        "The trusted device relay returned malformed session data.",
                    )
                }
                validateResolvedTrustedSession(
                    resolved,
                    trustedMac,
                    phone.phoneDeviceId,
                    phone.phoneIdentityPublicKey,
                    nonce,
                    timestamp,
                )
                return resolved
            }
            val errorResponse = runCatching { json.decodeFromString<CodexRelayErrorResponse>(data) }.getOrNull()
            when (errorResponse?.code) {
                "session_unavailable" ->
                    throw CodexTrustedSessionResolveError.MacOffline("Your trusted device is offline right now.")
                "phone_not_trusted", "invalid_signature" ->
                    throw CodexTrustedSessionResolveError.RePairRequired(
                        "This phone is no longer trusted by the paired device. Scan a new QR code to reconnect.",
                    )
                "resolve_request_replayed", "resolve_request_expired" ->
                    throw CodexTrustedSessionResolveError.Network(
                        "The trusted reconnect request expired. Try reconnecting again.",
                    )
                else ->
                    if (httpResponse.code == 404) {
                        throw CodexTrustedSessionResolveError.UnsupportedRelay
                    } else {
                        throw CodexTrustedSessionResolveError.Network(
                            errorResponse?.error
                                ?: "The trusted device relay could not resolve the current bridge session.",
                        )
                    }
            }
        }
    }

    private fun validateResolvedTrustedSession(
        resolved: CodexTrustedSessionResolveResponse,
        trustedMac: CodexTrustedMacRecord,
        phoneDeviceId: String,
        phoneIdentityPublicKey: String,
        nonce: String,
        timestamp: Long,
    ) {
        if (resolved.macDeviceId != trustedMac.macDeviceId) {
            throw CodexTrustedSessionResolveError.InvalidResponse(
                "The trusted device relay returned a session for a different device.",
            )
        }
        val resolvedPublicKey = resolved.macIdentityPublicKey.trim()
        if (resolvedPublicKey != trustedMac.macIdentityPublicKey.trim()) {
            throw CodexTrustedSessionResolveError.InvalidResponse(
                "The trusted device relay returned a session with a mismatched Mac identity key.",
            )
        }
        val skewSeconds = kotlin.math.abs(resolved.responseTimestamp - System.currentTimeMillis()) / 1000.0
        if (skewSeconds > AGNT_TRUSTED_SESSION_RESOLVE_CLOCK_SKEW_TOLERANCE_SECONDS) {
            throw CodexTrustedSessionResolveError.InvalidResponse(
                "The trusted device relay returned an expired session response.",
            )
        }
        val responseTranscript =
            codexTrustedSessionResolveResponseTranscriptBytes(
                macDeviceId = resolved.macDeviceId,
                macIdentityPublicKey = resolved.macIdentityPublicKey,
                displayName = resolved.displayName,
                sessionId = resolved.sessionId,
                phoneDeviceId = phoneDeviceId,
                phoneIdentityPublicKey = phoneIdentityPublicKey,
                nonce = nonce,
                timestamp = timestamp,
                responseTimestamp = resolved.responseTimestamp,
            )
        val macPub = base64DecodeOrEmpty(resolved.macIdentityPublicKey)
        val macSig = base64DecodeOrEmpty(resolved.signature)
        if (!AgntNativeCrypto.ed25519Verify(responseTranscript, macSig, macPub)) {
            throw CodexTrustedSessionResolveError.InvalidResponse(
                "The trusted device relay returned an invalid session signature.",
            )
        }
    }
}
