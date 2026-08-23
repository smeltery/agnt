package com.smeltery.agnt.mobile.data.history

import com.smeltery.agnt.mobile.core.model.CodexMessageKind
import com.smeltery.agnt.mobile.core.model.JSONValue
import com.smeltery.agnt.mobile.core.model.TurnThinkingDisclosureHints

internal fun normalizedHistoryItemType(raw: String): String = raw.replace("_", "").replace("-", "").lowercase()

internal fun sanitizeHistoryTextForKind(
    kind: CodexMessageKind,
    rawText: String,
): String {
    val text = rawText.trim()
    return when (kind) {
        CodexMessageKind.thinking ->
            TurnThinkingDisclosureHints.stripSimpleThinkingTags(text).trim()
        else -> text
    }
}

internal fun firstHistoryValue(
    obj: Map<String, JSONValue>?,
    vararg keys: String,
): JSONValue? {
    if (obj == null) return null
    for (key in keys) {
        obj[key]?.let { return it }
    }
    return null
}

internal fun firstHistoryStringValue(
    obj: Map<String, JSONValue>?,
    vararg keys: String,
): String? =
    firstHistoryValue(obj, *keys)
        ?.stringValue
        ?.trim()
        ?.takeIf { it.isNotEmpty() }

internal fun normalizedHistoryIdentifier(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }
