package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexImageAttachment
import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageDeliveryState
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageOrderCounter
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import com.dotbrains.agnt.mobile.core.model.CodexPlanStep
import com.dotbrains.agnt.mobile.core.model.CodexSubagentAction
import com.dotbrains.agnt.mobile.core.persistence.CodexMessagePersistence
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant
import java.util.UUID

/**
 * In-memory timeline + encrypted persistence (iOS [messagesByThread] + persistMessages).
 */
internal class MessageTimelineStore(
    initialMessages: Map<String, List<CodexMessage>>,
    private val saveMessages: (Map<String, List<CodexMessage>>) -> Unit,
) {
    private val mutex = Mutex()
    private val subagentDirectory = MessageTimelineSubagentDirectory()

    private val _messagesByThread = MutableStateFlow<Map<String, List<CodexMessage>>>(emptyMap())
    val messagesByThread: StateFlow<Map<String, List<CodexMessage>>> = _messagesByThread.asStateFlow()
    private val systemItems by lazy {
        MessageTimelineSystemItems(
            mutex = mutex,
            messagesByThread = _messagesByThread,
            subagentDirectory = subagentDirectory,
            publishMessages = ::publishMessages,
        )
    }
    private val chatMessages by lazy {
        MessageTimelineChatMessages(
            mutex = mutex,
            messagesByThread = _messagesByThread,
            subagentDirectory = subagentDirectory,
            publishMessages = ::publishMessages,
        )
    }

    init {
        val normalizedInitialMessages =
            initialMessages.mapValues { (_, messages) ->
                HistoryMessageMerge.normalize(messages)
            }
        CodexMessageOrderCounter.seedFrom(normalizedInitialMessages)
        subagentDirectory.rebuild(normalizedInitialMessages.values.flatten())
        _messagesByThread.value =
            normalizedInitialMessages.mapValues { (_, messages) ->
                messages.map(subagentDirectory::resolveMessage)
            }
    }

    constructor(
        persistence: CodexMessagePersistence,
        lastActiveThreadId: String? = null,
        initialTailLimit: Int = DEFAULT_INITIAL_TAIL_LIMIT,
    ) : this(
        initialMessages = persistence.loadInitialThreadTail(lastActiveThreadId, initialTailLimit),
        saveMessages = { map -> persistence.save(map) },
    )

    internal constructor(
        initialMessages: Map<String, List<CodexMessage>> = emptyMap(),
    ) : this(
        initialMessages = initialMessages,
        saveMessages = {},
    )

    private fun publishMessages(map: Map<String, List<CodexMessage>>) {
        _messagesByThread.value = map
        saveMessages(map)
    }

    suspend fun mergeThreadHistory(
        threadId: String,
        incoming: List<CodexMessage>,
    ) {
        if (incoming.isEmpty()) return
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            val existing = map[threadId].orEmpty()
            subagentDirectory.rebuild(existing + incoming)
            map[threadId] =
                HistoryMessageMerge
                    .merge(existing, incoming)
                    .map(subagentDirectory::resolveMessage)
            publishMessages(map)
        }
    }

    /** Server reports thread gone — drop persisted rows (parity iOS `removeThreadTimelineState` + prune messages). */
    suspend fun removeThreadMessages(threadId: String) {
        val tid = threadId.trim()
        if (tid.isEmpty()) return
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            if (map.remove(tid) == null) return@withLock
            publishMessages(map)
        }
    }

    suspend fun appendThinkingDelta(
        threadId: String,
        turnId: String,
        itemId: String?,
        delta: String,
    ) {
        appendStreamingSystemItemDelta(
            threadId = threadId,
            turnId = turnId,
            itemId = itemId,
            kind = CodexMessageKind.thinking,
            delta = delta,
        )
    }

    suspend fun appendStreamingSystemItemDelta(
        threadId: String,
        turnId: String?,
        itemId: String?,
        kind: CodexMessageKind,
        delta: String,
    ) = systemItems.appendStreamingSystemItemDelta(threadId, turnId, itemId, kind, delta)

    suspend fun upsertStreamingSystemItemSnapshot(
        threadId: String,
        turnId: String?,
        itemId: String?,
        kind: CodexMessageKind,
        snapshot: String,
    ) = systemItems.upsertStreamingSystemItemSnapshot(threadId, turnId, itemId, kind, snapshot)

    suspend fun ensureStreamingSystemItem(
        threadId: String,
        turnId: String?,
        itemId: String?,
        kind: CodexMessageKind,
        initialText: String,
    ) = systemItems.ensureStreamingSystemItem(threadId, turnId, itemId, kind, initialText)

    suspend fun mergeLateReasoningDelta(
        threadId: String,
        turnId: String?,
        itemId: String?,
        delta: String,
    ): Boolean = systemItems.mergeLateReasoningDelta(threadId, turnId, itemId, delta)

    suspend fun completeSystemItem(
        threadId: String,
        turnId: String?,
        itemId: String?,
        kind: CodexMessageKind,
        text: String,
    ) = systemItems.completeSystemItem(threadId, turnId, itemId, kind, text)

    suspend fun upsertPlanMessage(
        threadId: String,
        turnId: String?,
        itemId: String?,
        text: String? = null,
        explanation: String? = null,
        steps: List<CodexPlanStep>? = null,
        isStreaming: Boolean,
    ) = systemItems.upsertPlanMessage(threadId, turnId, itemId, text, explanation, steps, isStreaming)

    suspend fun upsertSubagentActionMessage(
        threadId: String,
        turnId: String?,
        itemId: String?,
        action: CodexSubagentAction,
        isStreaming: Boolean,
    ) = systemItems.upsertSubagentActionMessage(threadId, turnId, itemId, action, isStreaming)

    suspend fun appendAssistantDelta(
        threadId: String,
        turnId: String?,
        itemId: String?,
        delta: String,
        assistantPhase: String? = null,
    ) = chatMessages.appendAssistantDelta(threadId, turnId, itemId, delta, assistantPhase)

    suspend fun ensureStreamingAssistantPlaceholder(
        threadId: String,
        turnId: String?,
    ) = chatMessages.ensureStreamingAssistantPlaceholder(threadId, turnId)

    suspend fun completeAssistantMessage(
        threadId: String,
        turnId: String?,
        itemId: String?,
        text: String,
        attachments: List<CodexImageAttachment> = emptyList(),
        assistantPhase: String? = null,
    ) = chatMessages.completeAssistantMessage(threadId, turnId, itemId, text, attachments, assistantPhase)

    suspend fun appendSystemLine(
        threadId: String,
        turnId: String?,
        text: String,
        kind: CodexMessageKind = CodexMessageKind.chat,
    ) {
        val t = text.trim()
        if (t.isEmpty()) return
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            list.add(
                CodexMessage(
                    threadId = threadId,
                    role = CodexMessageRole.system,
                    kind = kind,
                    text = t,
                    createdAt = Instant.now(),
                    turnId = turnId,
                    isStreaming = false,
                ),
            )
            map[threadId] = list
            publishMessages(map)
        }
    }

    /**
     * Item-scoped marker when the shell shows the global approval dialog (J.7b). Non-interactive here;
     * [messageId] matches [PendingApprovalRequest.id] for future removal/updates.
     */
    suspend fun appendPendingApprovalMarker(
        threadId: String,
        turnId: String?,
        itemId: String?,
        messageId: String,
        bodyText: String,
    ) {
        val t = bodyText.trim()
        if (t.isEmpty()) return
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val id = messageId.trim().ifEmpty { UUID.randomUUID().toString() }
            if (list.any { it.id == id }) return@withLock
            list.add(
                CodexMessage(
                    id = id,
                    threadId = threadId,
                    role = CodexMessageRole.system,
                    kind = CodexMessageKind.pendingApproval,
                    text = t,
                    createdAt = Instant.now(),
                    turnId = turnId,
                    itemId = itemId,
                    isStreaming = false,
                ),
            )
            map[threadId] = list
            publishMessages(map)
        }
    }

    /**
     * Item-scoped marker when the shell shows the structured input dialog (J.7b). Non-interactive;
     * [messageId] matches [PendingStructuredInputRequest.id] so it can be removed after response.
     * Uses [CodexMessageKind.userInputPrompt]; not persisted ([CodexMessagePersistence] filter).
     */
    suspend fun appendStructuredInputPromptMarker(
        threadId: String,
        turnId: String?,
        messageId: String,
        bodyText: String,
    ) {
        val t = bodyText.trim()
        if (t.isEmpty()) return
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val id = messageId.trim().ifEmpty { UUID.randomUUID().toString() }
            if (list.any { it.id == id }) return@withLock
            list.add(
                CodexMessage(
                    id = id,
                    threadId = threadId,
                    role = CodexMessageRole.system,
                    kind = CodexMessageKind.userInputPrompt,
                    text = t,
                    createdAt = Instant.now(),
                    turnId = turnId,
                    isStreaming = false,
                ),
            )
            map[threadId] = list
            publishMessages(map)
        }
    }

    /**
     * Removes ephemeral server-request timeline rows keyed by RPC id ([PendingApprovalRequest.id],
     * [PendingStructuredInputRequest.id]) across threads once the shell completes the RPC.
     */
    suspend fun removeEphemeralPendingServerMarker(messageId: String) {
        val mid = messageId.trim()
        if (mid.isEmpty()) return
        mutex.withLock {
            val ephemeralKinds =
                setOf(CodexMessageKind.pendingApproval, CodexMessageKind.userInputPrompt)
            val map = _messagesByThread.value.toMutableMap()
            var changed = false
            for ((tid, list) in map.entries.toList()) {
                val newList =
                    list.filterNot { it.id == mid && ephemeralKinds.contains(it.kind) }
                if (newList.size != list.size) {
                    map[tid] = newList
                    changed = true
                }
            }
            if (changed) {
                publishMessages(map)
            }
        }
    }

    suspend fun appendPendingUserMessage(
        threadId: String,
        text: String,
        attachments: List<CodexImageAttachment> = emptyList(),
    ): String = chatMessages.appendPendingUserMessage(threadId, text, attachments)

    suspend fun markUserMessageOutcome(
        threadId: String,
        messageId: String,
        deliveryState: CodexMessageDeliveryState,
        turnId: String?,
    ) = chatMessages.markUserMessageOutcome(threadId, messageId, deliveryState, turnId)

    suspend fun appendMirroredUser(
        threadId: String,
        turnId: String?,
        text: String,
        attachments: List<CodexImageAttachment> = emptyList(),
    ) = chatMessages.appendMirroredUser(threadId, turnId, text, attachments)

    suspend fun confirmLatestPendingUserMessage(
        threadId: String,
        turnId: String,
    ) = chatMessages.confirmLatestPendingUserMessage(threadId, turnId)

    suspend fun attachLatestTurnlessUserMessageToTurn(
        threadId: String,
        turnId: String,
    ) = chatMessages.attachLatestTurnlessUserMessageToTurn(threadId, turnId)

    private companion object {
        const val DEFAULT_INITIAL_TAIL_LIMIT = 16
    }
}
