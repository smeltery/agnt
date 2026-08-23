package com.smeltery.agnt.mobile.data

internal suspend fun agntResolveCommitMessage(
    rawMessage: String,
    generateDraft: suspend () -> String,
): String? {
    val trimmed = rawMessage.trim()
    if (trimmed.isNotEmpty()) return trimmed
    return generateDraft().trim().takeIf { it.isNotEmpty() }
}
