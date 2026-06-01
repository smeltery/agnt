package com.dotbrains.agnt.mobile.services

import android.util.Log
import com.dotbrains.agnt.mobile.core.model.RelayHealthParser
import com.dotbrains.agnt.mobile.core.model.RelayHealthSnapshot
import com.dotbrains.agnt.mobile.core.persistence.SessionPersistence
import com.dotbrains.agnt.mobile.core.transport.validateRelayUrl
import com.dotbrains.agnt.mobile.pairing.applyRelayHostOverride
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

private const val RELAY_HEALTH_LOG_TAG = "AgntRelayHealth"

class RelayHealthClient(
    private val httpClient: OkHttpClient,
    private val sessionPersistence: SessionPersistence,
) {
    suspend fun fetchHealth(relayHostOverride: String = ""): RelayHealthSnapshot? =
        withContext(Dispatchers.IO) {
            val relayUrl =
                sessionPersistence
                    .loadRelaySnapshot()
                    .relayUrl
                    ?.trim()
                    ?.takeIf { it.isNotEmpty() }
                    ?: return@withContext null
            val adjusted =
                applyRelayHostOverride(relayUrl, relayHostOverride).let { raw ->
                    when {
                        raw.startsWith("wss://", ignoreCase = true) -> "https://${raw.substring(6)}"
                        raw.startsWith("ws://", ignoreCase = true) -> "http://${raw.substring(5)}"
                        else -> raw
                    }
                }
            val parsed = validateRelayUrl(adjusted)?.httpUrl ?: adjusted.toHttpUrlOrNull() ?: return@withContext null
            val healthUrl =
                parsed
                    .newBuilder()
                    .encodedPath("/health")
                    .query(null)
                    .fragment(null)
                    .build()
            val request =
                Request
                    .Builder()
                    .url(healthUrl)
                    .get()
                    .build()
            val response =
                runCatching { httpClient.newCall(request).execute() }
                    .onFailure { error ->
                        Log.w(RELAY_HEALTH_LOG_TAG, "Relay health request failed host=${healthUrl.host}: ${error.message}")
                    }.getOrNull()
                    ?: return@withContext null
            response.use { httpResponse ->
                if (httpResponse.code == 404) {
                    Log.i(RELAY_HEALTH_LOG_TAG, "Relay health endpoint unavailable host=${healthUrl.host} status=404")
                    return@withContext null
                }
                if (!httpResponse.isSuccessful) {
                    Log.w(
                        RELAY_HEALTH_LOG_TAG,
                        "Relay health returned failure host=${healthUrl.host} status=${httpResponse.code}",
                    )
                    return@withContext RelayHealthSnapshot(ok = false)
                }
                val body = httpResponse.body?.string().orEmpty()
                return@withContext RelayHealthParser.parse(body)
            }
        }
}
