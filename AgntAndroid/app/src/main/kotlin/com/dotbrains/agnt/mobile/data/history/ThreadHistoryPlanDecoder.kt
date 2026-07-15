package com.dotbrains.agnt.mobile.data.history

import com.dotbrains.agnt.mobile.core.model.CodexPlanState
import com.dotbrains.agnt.mobile.core.model.CodexPlanStep
import com.dotbrains.agnt.mobile.core.model.CodexPlanStepStatus
import com.dotbrains.agnt.mobile.core.model.JSONValue
import java.time.Instant
import java.time.format.DateTimeFormatter

internal fun decodeHistoryBaseInstant(threadObject: Map<String, JSONValue>): Instant =
    decodeHistoryInstant(threadObject)
        ?: Instant.EPOCH

internal fun decodeHistoryInstant(obj: Map<String, JSONValue>): Instant? {
    for (key in listOf("createdAt", "created_at", "updatedAt", "updated_at")) {
        obj[key]?.let { v ->
            when (v) {
                is JSONValue.Str -> parseHistoryIso(v.value)?.let { return it }
                is JSONValue.NumLong -> return historyUnixToInstant(v.value.toDouble())
                is JSONValue.NumDouble -> return historyUnixToInstant(v.value)
                else -> Unit
            }
        }
    }
    return null
}

private fun historyUnixToInstant(raw: Double): Instant {
    val sec = if (raw > 10_000_000_000.0) raw / 1000.0 else raw
    return Instant.ofEpochMilli((sec * 1000).toLong())
}

private fun parseHistoryIso(s: String): Instant? =
    runCatching { Instant.parse(s.trim()) }.getOrNull()
        ?: runCatching {
            DateTimeFormatter.ISO_OFFSET_DATE_TIME.parse(s.trim(), Instant::from)
        }.getOrNull()

internal fun decodeHistoryPlanState(itemObject: Map<String, JSONValue>): CodexPlanState? {
    val explanation =
        decodeHistoryNormalizedPlanText(itemObject["explanation"])
            ?: decodeHistoryNormalizedPlanText(itemObject["summary"])
    val steps =
        (itemObject["plan"]?.arrayValue ?: emptyList()).mapNotNull { stepValue ->
            val stepObject = stepValue.objectValue ?: return@mapNotNull null
            val step = decodeHistoryNormalizedPlanText(stepObject["step"]) ?: return@mapNotNull null
            val rawStatus = decodeHistoryNormalizedPlanText(stepObject["status"]) ?: return@mapNotNull null
            val status =
                when (rawStatus.lowercase().replace("_", "").replace("-", "")) {
                    "pending" -> CodexPlanStepStatus.pending
                    "inprogress" -> CodexPlanStepStatus.inProgress
                    "completed" -> CodexPlanStepStatus.completed
                    else -> null
                } ?: return@mapNotNull null
            CodexPlanStep(step = step, status = status)
        }
    if (explanation == null && steps.isEmpty()) return null
    return CodexPlanState(explanation = explanation, steps = steps)
}

internal fun finalizedHistoryPlanState(
    planState: CodexPlanState?,
    turnCompleted: Boolean,
): CodexPlanState? {
    val state = planState ?: return null
    if (!turnCompleted || state.steps.isEmpty() || state.steps.none { it.status != CodexPlanStepStatus.completed }) {
        return state
    }
    return state.copy(
        steps = state.steps.map { step -> step.copy(status = CodexPlanStepStatus.completed) },
    )
}

internal fun isCompletedHistoryTurn(turnObject: Map<String, JSONValue>): Boolean {
    val status =
        turnObject["status"]?.stringValue
            ?: turnObject["state"]?.stringValue
            ?: (turnObject["terminalState"] as? JSONValue.Obj)?.map?.get("status")?.stringValue
            ?: (turnObject["terminal_state"] as? JSONValue.Obj)?.map?.get("status")?.stringValue
            ?: return false
    val normalized = status.lowercase().replace("_", "").replace("-", "")
    return normalized == "completed" || normalized == "success" || normalized == "succeeded"
}

private fun decodeHistoryNormalizedPlanText(value: JSONValue?): String? {
    val raw =
        when (value) {
            is JSONValue.Str -> value.value
            else -> null
        } ?: return null
    val trimmed = raw.trim()
    return trimmed.ifEmpty { null }
}
