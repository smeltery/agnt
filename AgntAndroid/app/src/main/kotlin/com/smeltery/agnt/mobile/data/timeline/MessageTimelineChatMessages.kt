package com.smeltery.agnt.mobile.data

import com.smeltery.agnt.mobile.core.model.CodexImageAttachment
import com.smeltery.agnt.mobile.core.model.CodexMessage
import com.smeltery.agnt.mobile.core.model.CodexMessageDeliveryState
import com.smeltery.agnt.mobile.core.model.CodexMessageKind
import com.smeltery.agnt.mobile.core.model.CodexMessageOrderCounter
import com.smeltery.agnt.mobile.core.model.CodexMessageRole
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant
import java.util.UUID

internal class MessageTimelineChatMessages(
    private val mutex: Mutex,
    private val messagesByThread: MutableStateFlow<Map<String, List<CodexMessage>>>,
    private val subagentDirectory: MessageTimelineSubagentDirectory,
    private val publishMessages: (Map<String, List<CodexMessage>>) -> Unit,
) {
    suspend fun appendAssistantDelta(
        threadId: String,
        turnId: String?,
        itemId: String?,
        delta: String,
        assistantPhase: String?,
    ) {
        if (delta.isEmpty()) return
        mutex.withLock {
            val resolvedTurnId = turnId?.trim()?.takeIf { it.isNotEmpty() }
            val resolvedItemId = itemId?.trim()?.takeIf { it.isNotEmpty() }
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val idx =
                list.indexOfLast { message ->
                    message.role == CodexMessageRole.assistant &&
                        message.kind == CodexMessageKind.chat &&
                        message.isStreaming &&
                        matchesAssistantDeltaCandidate(
                            candidate = message,
                            turnId = resolvedTurnId,
                            itemId = resolvedItemId,
                        )
                }
            if (idx >= 0) {
                val message = list[idx]
                list[idx] =
                    message.copy(
                        text = message.text + delta,
                        assistantPhase = assistantPhase ?: message.assistantPhase,
                        isStreaming = true,
                        turnId = resolvedTurnId ?: message.turnId,
                        itemId = resolvedItemId ?: message.itemId,
                    )
            } else {
                list.add(
                    CodexMessage(
                        threadId = threadId,
                        role = CodexMessageRole.assistant,
                        kind = CodexMessageKind.chat,
                        assistantPhase = assistantPhase,
                        text = delta,
                        createdAt = Instant.now(),
                        turnId = resolvedTurnId,
                        itemId = resolvedItemId,
                        isStreaming = true,
                    ),
                )
            }
            map[threadId] = list
            publishMessages(map)
        }
    }

    suspend fun ensureStreamingAssistantPlaceholder(
        threadId: String,
        turnId: String?,
    ) {
        val resolvedTurnId = turnId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        mutex.withLock {
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val existing =
                list.any { message ->
                    message.role == CodexMessageRole.assistant &&
                        message.kind == CodexMessageKind.chat &&
                        message.turnId == resolvedTurnId &&
                        message.isStreaming
                }
            if (!existing) {
                list.add(
                    CodexMessage(
                        threadId = threadId,
                        role = CodexMessageRole.assistant,
                        kind = CodexMessageKind.chat,
                        text = "",
                        createdAt = Instant.now(),
                        turnId = resolvedTurnId,
                        isStreaming = true,
                    ),
                )
                map[threadId] = list
                publishMessages(map)
            }
        }
    }

    suspend fun completeAssistantMessage(
        threadId: String,
        turnId: String?,
        itemId: String?,
        text: String,
        attachments: List<CodexImageAttachment>,
        assistantPhase: String?,
    ) {
        val finalText = text.trim()
        if (finalText.isEmpty() && attachments.isEmpty()) return
        mutex.withLock {
            val resolvedTurnId = turnId?.trim()?.takeIf { it.isNotEmpty() }
            val resolvedItemId = itemId?.trim()?.takeIf { it.isNotEmpty() }
            val normalizedFinalText = normalizedMessageText(finalText)
            val now = Instant.now()
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            if (subagentDirectory.absorbAssistantSummary(list, resolvedTurnId, finalText)) {
                map[threadId] = list
                publishMessages(map)
                return@withLock
            }
            val idx =
                list.indexOfLast { message ->
                    message.role == CodexMessageRole.assistant &&
                        message.kind == CodexMessageKind.chat &&
                        matchesCompletedMessageCandidate(
                            candidate = message,
                            turnId = resolvedTurnId,
                            itemId = resolvedItemId,
                        )
                }
            if (idx >= 0) {
                val message = list[idx]
                list[idx] =
                    message.copy(
                        text = if (message.text.isEmpty()) finalText else mergeSnapshot(message.text, finalText),
                        assistantPhase = assistantPhase ?: message.assistantPhase,
                        isStreaming = false,
                        turnId = resolvedTurnId ?: message.turnId,
                        itemId = resolvedItemId ?: message.itemId,
                        attachments = if (attachments.isNotEmpty()) attachments else message.attachments,
                    )
            } else {
                upsertDuplicateOrAppendAssistant(
                    list = list,
                    threadId = threadId,
                    resolvedTurnId = resolvedTurnId,
                    resolvedItemId = resolvedItemId,
                    normalizedFinalText = normalizedFinalText,
                    finalText = finalText,
                    assistantPhase = assistantPhase,
                    attachments = attachments,
                    now = now,
                )
            }
            map[threadId] = list
            publishMessages(map)
        }
    }

    suspend fun appendPendingUserMessage(
        threadId: String,
        text: String,
        attachments: List<CodexImageAttachment>,
    ): String {
        val trimmed = text.trim()
        val id = UUID.randomUUID().toString()
        if (trimmed.isEmpty() && attachments.isEmpty()) return id
        mutex.withLock {
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            list.add(
                CodexMessage(
                    id = id,
                    threadId = threadId,
                    role = CodexMessageRole.user,
                    kind = CodexMessageKind.chat,
                    text = trimmed,
                    createdAt = Instant.now(),
                    deliveryState = CodexMessageDeliveryState.pending,
                    isStreaming = false,
                    attachments = attachments,
                ),
            )
            map[threadId] = list
            publishMessages(map)
        }
        return id
    }

    suspend fun markUserMessageOutcome(
        threadId: String,
        messageId: String,
        deliveryState: CodexMessageDeliveryState,
        turnId: String?,
    ) {
        mutex.withLock {
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val idx = list.indexOfFirst { it.id == messageId }
            if (idx >= 0) {
                val message = list[idx]
                list[idx] =
                    message.copy(
                        deliveryState = deliveryState,
                        turnId = turnId ?: message.turnId,
                    )
            }
            map[threadId] = list
            publishMessages(map)
        }
    }

    suspend fun appendMirroredUser(
        threadId: String,
        turnId: String?,
        text: String,
        attachments: List<CodexImageAttachment>,
    ) {
        val trimmed = text.trim()
        val normalizedText = normalizedMessageText(trimmed)
        if (trimmed.isEmpty() && attachments.isEmpty()) return
        mutex.withLock {
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val existingIdx =
                list.indexOfLast { message ->
                    message.role == CodexMessageRole.user &&
                        normalizedMessageText(message.text) == normalizedText &&
                        compatibleUserAttachments(message.attachments, attachments) &&
                        (
                            (turnId != null && (message.turnId == null || message.turnId == turnId)) ||
                                (turnId == null && message.turnId == null)
                        )
                }
            if (existingIdx >= 0) {
                val existing = list[existingIdx]
                val next =
                    existing.copy(
                        deliveryState = CodexMessageDeliveryState.confirmed,
                        turnId = turnId ?: existing.turnId,
                        attachments = UserChatAttachmentMatcher.merge(existing.attachments, attachments),
                    )
                if (next != existing) list[existingIdx] = next
            } else {
                val insertionIndex =
                    turnId
                        ?.let { resolvedTurnId ->
                            val firstNonUserForTurn =
                                list.indexOfFirst { message ->
                                    message.turnId == resolvedTurnId && message.role != CodexMessageRole.user
                                }
                            firstNonUserForTurn.takeIf { it >= 0 }
                        }
                        ?: list.size
                list.add(
                    insertionIndex,
                    CodexMessage(
                        threadId = threadId,
                        role = CodexMessageRole.user,
                        kind = CodexMessageKind.chat,
                        text = trimmed,
                        createdAt = Instant.now(),
                        turnId = turnId,
                        deliveryState = CodexMessageDeliveryState.confirmed,
                        isStreaming = false,
                        attachments = attachments,
                    ),
                )
                if (insertionIndex < list.lastIndex) reassignOrderIndexesInCurrentOrder(list)
            }
            map[threadId] = list
            publishMessages(map)
        }
    }

    suspend fun confirmLatestPendingUserMessage(
        threadId: String,
        turnId: String,
    ) {
        val resolvedTurnId = turnId.trim()
        if (resolvedTurnId.isEmpty()) return
        mutex.withLock {
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val idx =
                list.indices.reversed().firstOrNull { index ->
                    val candidate = list[index]
                    candidate.role == CodexMessageRole.user &&
                        candidate.deliveryState == CodexMessageDeliveryState.pending &&
                        (candidate.turnId == null || candidate.turnId == resolvedTurnId)
                } ?: return@withLock
            val message = list[idx]
            list[idx] =
                message.copy(
                    deliveryState = CodexMessageDeliveryState.confirmed,
                    turnId = resolvedTurnId,
                )
            map[threadId] = list
            publishMessages(map)
        }
    }

    suspend fun attachLatestTurnlessUserMessageToTurn(
        threadId: String,
        turnId: String,
    ) {
        val resolvedTurnId = turnId.trim().takeIf { it.isNotEmpty() } ?: return
        mutex.withLock {
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val idx =
                list.indices.reversed().firstOrNull { index ->
                    val candidate = list[index]
                    candidate.role == CodexMessageRole.user &&
                        candidate.kind == CodexMessageKind.chat &&
                        candidate.turnId == null &&
                        candidate.deliveryState == CodexMessageDeliveryState.confirmed
                } ?: return@withLock
            list[idx] = list[idx].copy(turnId = resolvedTurnId)
            map[threadId] = list
            publishMessages(map)
        }
    }

    private fun upsertDuplicateOrAppendAssistant(
        list: MutableList<CodexMessage>,
        threadId: String,
        resolvedTurnId: String?,
        resolvedItemId: String?,
        normalizedFinalText: String,
        finalText: String,
        assistantPhase: String?,
        attachments: List<CodexImageAttachment>,
        now: Instant,
    ) {
        val duplicateIdx =
            list.indexOfLast { candidate ->
                candidate.role == CodexMessageRole.assistant &&
                    candidate.kind == CodexMessageKind.chat &&
                    normalizedMessageText(candidate.text) == normalizedFinalText &&
                    (
                        candidate.isStreaming ||
                            (resolvedTurnId != null && candidate.turnId == resolvedTurnId) ||
                            (resolvedItemId != null && candidate.itemId == resolvedItemId)
                    )
            }
        if (duplicateIdx >= 0) {
            val candidate = list[duplicateIdx]
            list[duplicateIdx] =
                candidate.copy(
                    text = if (candidate.text.isEmpty()) finalText else mergeSnapshot(candidate.text, finalText),
                    assistantPhase = assistantPhase ?: candidate.assistantPhase,
                    isStreaming = false,
                    turnId = resolvedTurnId ?: candidate.turnId,
                    itemId = resolvedItemId ?: candidate.itemId,
                    attachments = if (attachments.isNotEmpty()) attachments else candidate.attachments,
                )
        } else {
            list.add(
                CodexMessage(
                    threadId = threadId,
                    role = CodexMessageRole.assistant,
                    kind = CodexMessageKind.chat,
                    assistantPhase = assistantPhase,
                    text = finalText,
                    createdAt = now,
                    turnId = resolvedTurnId,
                    itemId = resolvedItemId,
                    isStreaming = false,
                    attachments = attachments,
                ),
            )
        }
    }

    private fun reassignOrderIndexesInCurrentOrder(list: MutableList<CodexMessage>) {
        for (index in list.indices) {
            list[index] = list[index].copy(orderIndex = CodexMessageOrderCounter.next())
        }
    }
}
