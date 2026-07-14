package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexImageAttachment
import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole

internal fun mergeSnapshot(
    existing: String,
    incoming: String,
): String {
    if (existing.isEmpty()) return incoming
    if (incoming == existing) return existing
    if (existing.endsWith(incoming)) return existing
    if (incoming.length > existing.length && incoming.startsWith(existing)) return incoming
    if (existing.length > incoming.length && existing.startsWith(incoming)) return existing
    return incoming
}

internal fun matchesCompletedMessageCandidate(
    candidate: CodexMessage,
    turnId: String?,
    itemId: String?,
): Boolean {
    val candidateItemId = candidate.itemId?.trim()?.takeIf { it.isNotEmpty() }
    val candidateTurnId = candidate.turnId?.trim()?.takeIf { it.isNotEmpty() }
    if (itemId != null && candidateItemId == itemId) {
        return true
    }
    if (turnId != null && candidateTurnId == turnId) {
        return itemId == null || candidate.isStreaming || candidateItemId == null || candidateItemId == itemId
    }
    return false
}

internal fun matchesAssistantDeltaCandidate(
    candidate: CodexMessage,
    turnId: String?,
    itemId: String?,
): Boolean {
    val candidateItemId = candidate.itemId?.trim()?.takeIf { it.isNotEmpty() }
    val candidateTurnId = candidate.turnId?.trim()?.takeIf { it.isNotEmpty() }
    if (itemId != null && candidateItemId == itemId) return true
    if (itemId != null && candidateItemId == null) {
        return turnId == null || candidateTurnId == null || candidateTurnId == turnId
    }
    if (itemId == null && turnId != null) {
        return candidateItemId == null && candidateTurnId == turnId
    }
    if (itemId == null && turnId == null) {
        return candidateItemId == null && candidateTurnId == null
    }
    return false
}

internal fun findStreamingSystemItemIndex(
    list: List<CodexMessage>,
    kind: CodexMessageKind,
    turnId: String?,
    itemId: String?,
    fileChangePathKeys: Set<String>,
    allowCompletedFileChange: Boolean = false,
): Int {
    val direct =
        list.indexOfLast { m ->
            m.role == CodexMessageRole.system &&
                m.kind == kind &&
                (m.isStreaming || (allowCompletedFileChange && kind == CodexMessageKind.fileChange)) &&
                (
                    itemId != null &&
                        m.itemId == itemId ||
                        (itemId == null && turnId != null && m.turnId == turnId)
                )
        }
    if (direct >= 0) return direct

    if (kind != CodexMessageKind.fileChange || turnId.isNullOrBlank()) return -1
    if (fileChangePathKeys.isNotEmpty()) {
        val pathMatch =
            list.indexOfLast { m ->
                m.role == CodexMessageRole.system &&
                    m.kind == CodexMessageKind.fileChange &&
                    (m.isStreaming || allowCompletedFileChange) &&
                    (m.turnId == turnId || m.turnId == null) &&
                    normalizedFileChangePathKeys(m.text).any { it in fileChangePathKeys }
            }
        if (pathMatch >= 0) return pathMatch
    }

    return -1
}

internal fun findCompletedSystemItemIndex(
    list: List<CodexMessage>,
    kind: CodexMessageKind,
    turnId: String?,
    itemId: String?,
    finalText: String,
    fileChangePathKeys: Set<String>,
    isAuthoritativeFileChangeSnapshot: Boolean,
): Int {
    if (kind == CodexMessageKind.fileChange && !turnId.isNullOrBlank()) {
        if (fileChangePathKeys.isNotEmpty()) {
            val pathMatch =
                list.indexOfLast { m ->
                    m.role == CodexMessageRole.system &&
                        m.kind == CodexMessageKind.fileChange &&
                        (m.turnId == turnId || m.turnId == null) &&
                        normalizedFileChangePathKeys(m.text).any { it in fileChangePathKeys }
                }
            if (pathMatch >= 0) return pathMatch
            return itemId?.let { exactItemId ->
                list.indexOfLast { m ->
                    m.role == CodexMessageRole.system &&
                        m.kind == CodexMessageKind.fileChange &&
                        m.itemId == exactItemId
                }
            } ?: -1
        } else if (isAuthoritativeFileChangeSnapshot) {
            val unique = uniqueFileChangeIndexForTurn(list, turnId, allowsTurnlessFallback = true)
            if (unique >= 0) return unique
        }
    }

    if (kind == CodexMessageKind.commandExecution && !turnId.isNullOrBlank()) {
        val incomingCommandKey = normalizedCommandExecutionPreviewKey(finalText)
        if (incomingCommandKey != null) {
            val commandMatch =
                list.indexOfLast { m ->
                    m.role == CodexMessageRole.system &&
                        m.kind == CodexMessageKind.commandExecution &&
                        m.turnId == turnId &&
                        normalizedCommandExecutionPreviewKey(m.text) == incomingCommandKey
                }
            if (commandMatch >= 0) return commandMatch
        }
    }

    return list.indexOfLast { m ->
        m.role == CodexMessageRole.system &&
            m.kind == kind &&
            matchesCompletedMessageCandidate(
                candidate = m,
                turnId = turnId,
                itemId = itemId,
            )
    }
}

internal fun pruneDuplicateCommandExecutionRows(
    list: MutableList<CodexMessage>,
    keepIndex: Int,
    turnId: String?,
    finalText: String,
) {
    if (turnId.isNullOrBlank() || keepIndex !in list.indices) return
    val keepId = list[keepIndex].id
    val commandKey = normalizedCommandExecutionPreviewKey(finalText) ?: return
    list.removeAll { candidate ->
        candidate.id != keepId &&
            candidate.role == CodexMessageRole.system &&
            candidate.kind == CodexMessageKind.commandExecution &&
            candidate.turnId == turnId &&
            normalizedCommandExecutionPreviewKey(candidate.text) == commandKey
    }
}

internal fun pruneDuplicateFileChangeRows(
    list: MutableList<CodexMessage>,
    keepIndex: Int,
    turnId: String?,
    fileChangePathKeys: Set<String>,
    isAuthoritativeSnapshot: Boolean,
) {
    if (turnId.isNullOrBlank() || keepIndex !in list.indices) return
    val keepId = list[keepIndex].id
    val keepText = list[keepIndex].text.trim()
    list.removeAll { candidate ->
        if (candidate.id == keepId ||
            candidate.role != CodexMessageRole.system ||
            candidate.kind != CodexMessageKind.fileChange
        ) {
            return@removeAll false
        }
        val sameTurn = candidate.turnId == turnId
        val turnlessFallback = isAuthoritativeSnapshot && candidate.turnId == null
        if (!sameTurn && !turnlessFallback) return@removeAll false

        if (fileChangePathKeys.isNotEmpty()) {
            val candidateKeys = normalizedFileChangePathKeys(candidate.text)
            if (isAuthoritativeSnapshot) {
                return@removeAll candidateKeys.isNotEmpty() && candidateKeys.all { it in fileChangePathKeys }
            }
            return@removeAll candidateKeys.any { it in fileChangePathKeys }
        }
        candidate.text.trim() == keepText
    }
}

private fun uniqueFileChangeIndexForTurn(
    list: List<CodexMessage>,
    turnId: String,
    allowsTurnlessFallback: Boolean,
): Int {
    val candidates =
        list.withIndex().filter { (_, message) ->
            message.role == CodexMessageRole.system &&
                message.kind == CodexMessageKind.fileChange &&
                (message.turnId == turnId || (allowsTurnlessFallback && message.turnId == null))
        }
    return if (candidates.size == 1) candidates.single().index else -1
}

internal fun normalizedMessageText(text: String): String = text.trim().replace("\\s+".toRegex(), " ")

internal fun compatibleUserAttachments(
    existing: List<CodexImageAttachment>,
    incoming: List<CodexImageAttachment>,
): Boolean = UserChatAttachmentMatcher.compatible(existing, incoming)
