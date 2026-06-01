package com.dotbrains.agnt.mobile.core.model

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class RelayHealthSnapshot(
    val ok: Boolean,
    val relay: RelayHealthRelayMetrics? = null,
    val push: RelayHealthPushMetrics? = null,
    val runtime: RelayHealthRuntimeMetrics? = null,
)

data class RelayHealthRelayMetrics(
    val sessionsWithOpenMac: Int? = null,
    val sessionsWithStaleMac: Int? = null,
    val sessionsWithClients: Int? = null,
    val heartbeatTerminations: Int? = null,
)

data class RelayHealthPushMetrics(
    val enabled: Boolean? = null,
    val registeredDevices: Int? = null,
)

data class RelayHealthRuntimeMetrics(
    val eventLoopDelayMsMax: Double? = null,
    val heapUsedMb: Double? = null,
)

object RelayHealthParser {
    fun parse(body: String): RelayHealthSnapshot {
        val root =
            runCatching {
                kotlinx.serialization.json.Json
                    .parseToJsonElement(body)
                    .jsonObject
            }.getOrNull()
                ?: return RelayHealthSnapshot(ok = false)
        val ok = root["ok"]?.jsonPrimitive?.booleanOrNull ?: false
        return RelayHealthSnapshot(
            ok = ok,
            relay = parseRelay(root["relay"].objectOrNull()),
            push = parsePush(root["push"].objectOrNull()),
            runtime = parseRuntime(root["runtime"].objectOrNull()),
        )
    }

    private fun parseRelay(obj: JsonObject?): RelayHealthRelayMetrics? {
        obj ?: return null
        return RelayHealthRelayMetrics(
            sessionsWithOpenMac = obj.int("sessionsWithOpenMac"),
            sessionsWithStaleMac = obj.int("sessionsWithStaleMac"),
            sessionsWithClients = obj.int("sessionsWithClients"),
            heartbeatTerminations = obj.int("heartbeatTerminations"),
        )
    }

    private fun parsePush(obj: JsonObject?): RelayHealthPushMetrics? {
        obj ?: return null
        return RelayHealthPushMetrics(
            enabled = obj["enabled"]?.jsonPrimitive?.booleanOrNull,
            registeredDevices = obj.int("registeredDevices"),
        )
    }

    private fun parseRuntime(obj: JsonObject?): RelayHealthRuntimeMetrics? {
        obj ?: return null
        val delay = obj["eventLoopDelayMs"].objectOrNull()
        return RelayHealthRuntimeMetrics(
            eventLoopDelayMsMax = delay?.get("max")?.jsonPrimitive?.doubleOrNull,
            heapUsedMb = obj.double("heapUsedMb"),
        )
    }

    private fun JsonObject.int(key: String): Int? = this[key]?.jsonPrimitive?.intOrNull

    private fun JsonObject.double(key: String): Double? = this[key]?.jsonPrimitive?.doubleOrNull

    private fun JsonElement?.objectOrNull(): JsonObject? = this as? JsonObject
}
