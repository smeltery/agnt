package com.smeltery.agnt.mobile.data

import com.smeltery.agnt.mobile.core.model.CodexPlanStep
import com.smeltery.agnt.mobile.core.model.CodexPlanStepStatus
import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.core.model.JSONValue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject

internal fun normalizeIncomingMethod(method: String): String = method.lowercase().replace("_", "").replace("-", "")

internal fun upsertIncomingThread(
    list: List<CodexThread>,
    thread: CodexThread,
): List<CodexThread> {
    val i = list.indexOfFirst { it.id == thread.id }
    val merged =
        if (i >= 0) {
            val existing = list[i]
            val filled = thread.withMissingDisplayFieldsFrom(existing)
            list.mapIndexed { idx, t ->
                if (idx == i) {
                    filled.copy(syncState = existing.syncState)
                } else {
                    t
                }
            }
        } else {
            list + thread
        }
    return sortIncomingThreadsForSidebar(merged)
}

internal fun sortIncomingThreadsForSidebar(value: List<CodexThread>): List<CodexThread> {
    val past = java.time.Instant.EPOCH
    return value.sortedWith { lhs, rhs ->
        val l = lhs.updatedAt ?: lhs.createdAt ?: past
        val r = rhs.updatedAt ?: rhs.createdAt ?: past
        r.compareTo(l)
    }
}

internal fun extractIncomingThreadId(params: Map<String, JSONValue>): String? {
    fun norm(s: String?) = CodexThread.normalizeIdentifier(s)
    norm(params["threadId"]?.stringValue)?.let { return it }
    norm(params["thread_id"]?.stringValue)?.let { return it }
    norm(params["conversationId"]?.stringValue)?.let { return it }
    norm(params["conversation_id"]?.stringValue)?.let { return it }
    norm(params["thread"]?.objectValue?.get("id")?.stringValue)?.let { return it }
    val event = envelopeEventObject(params) ?: return null
    norm(event["threadId"]?.stringValue)?.let { return it }
    norm(event["thread_id"]?.stringValue)?.let { return it }
    norm(event["thread"]?.objectValue?.get("id")?.stringValue)?.let { return it }
    return null
}

internal fun decodeIncomingPlanSteps(value: JSONValue?): List<CodexPlanStep> {
    val items = value?.arrayValue ?: return emptyList()
    return items.mapNotNull { item ->
        val objectValue = item.objectValue ?: return@mapNotNull null
        val step = firstIncomingString(objectValue, listOf("step")) ?: return@mapNotNull null
        val rawStatus = firstIncomingString(objectValue, listOf("status")) ?: return@mapNotNull null
        val normalizedStatus =
            rawStatus.lowercase().replace("_", "").replace("-", "")
        val status =
            when (normalizedStatus) {
                "pending" -> CodexPlanStepStatus.pending
                "inprogress" -> CodexPlanStepStatus.inProgress
                "completed" -> CodexPlanStepStatus.completed
                else -> null
            } ?: return@mapNotNull null
        CodexPlanStep(step = step, status = status)
    }
}

internal fun envelopeEventObject(params: Map<String, JSONValue>): Map<String, JSONValue>? = params["msg"]?.objectValue ?: params["event"]?.objectValue

internal fun firstIncomingString(
    obj: Map<String, JSONValue>,
    keys: List<String>,
): String? {
    for (k in keys) {
        obj[k]
            ?.stringValue
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?.let { return it }
    }
    return null
}

internal fun hasAnyIncomingKey(
    obj: Map<String, JSONValue>?,
    keys: List<String>,
): Boolean {
    if (obj == null) return false
    return keys.any { obj.containsKey(it) }
}

internal fun jsonObjectFromJsonValue(v: JSONValue): JsonObject? {
    if (v !is JSONValue.Obj) return null
    return buildJsonObject {
        v.map.forEach { (k, child) ->
            put(k, JSONValue.toJsonElement(child))
        }
    }
}

internal fun extractItemIdDeep(
    params: Map<String, JSONValue>,
    itemObject: Map<String, JSONValue>,
): String? {
    listOf(
        itemObject["id"]?.stringValue,
        itemObject["call_id"]?.stringValue,
        itemObject["callId"]?.stringValue,
    ).forEach { s ->
        s?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
    }
    return IncomingNotificationParsers.extractItemId(params)
}
