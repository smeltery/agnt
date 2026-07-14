package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexImageAttachment
import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageDeliveryState
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageOrderCounter
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import com.dotbrains.agnt.mobile.core.model.CodexPlanState
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

    private fun publishResolvedMessages(map: MutableMap<String, List<CodexMessage>>) {
        publishMessages(
            map.mapValues { (_, messages) ->
                messages.map(subagentDirectory::resolveMessage)
            },
        )
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

    /**
     * Delta streaming su righe system (thinking, file change, plan, output comando) — parity iOS `appendStreamingSystemItemDelta`.
     */
    suspend fun appendStreamingSystemItemDelta(
        threadId: String,
        turnId: String?,
        itemId: String?,
        kind: CodexMessageKind,
        delta: String,
    ) {
        if (delta.isEmpty()) return
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val fileChangePathKeys =
                if (kind == CodexMessageKind.fileChange) normalizedFileChangePathKeys(delta) else emptySet()
            val idx =
                findStreamingSystemItemIndex(list, kind, turnId, itemId, fileChangePathKeys)
            if (idx >= 0) {
                val m = list[idx]
                list[idx] =
                    m.copy(
                        text = m.text + delta,
                        isStreaming = true,
                        turnId = turnId ?: m.turnId,
                        itemId = itemId ?: m.itemId,
                    )
                pruneDuplicateFileChangeRows(list, idx, turnId, fileChangePathKeys, false)
            } else {
                list.add(
                    CodexMessage(
                        threadId = threadId,
                        role = CodexMessageRole.system,
                        kind = kind,
                        text = delta,
                        createdAt = Instant.now(),
                        turnId = turnId,
                        itemId = itemId,
                        isStreaming = true,
                    ),
                )
            }
            map[threadId] = list
            publishMessages(map)
        }
    }

    /**
     * Like [appendStreamingSystemItemDelta], but treats [snapshot] as an authoritative replacement when it looks like
     * structured file-change payload (Path/Kind/Totals or fenced diff). This matches iOS behavior where file-change
     * completed payloads overwrite streaming placeholders.
     */
    suspend fun upsertStreamingSystemItemSnapshot(
        threadId: String,
        turnId: String?,
        itemId: String?,
        kind: CodexMessageKind,
        snapshot: String,
    ) {
        val incoming = snapshot.trim()
        if (incoming.isEmpty()) return
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val fileChangePathKeys =
                if (kind == CodexMessageKind.fileChange) normalizedFileChangePathKeys(incoming) else emptySet()
            val idx =
                findStreamingSystemItemIndex(
                    list = list,
                    kind = kind,
                    turnId = turnId,
                    itemId = itemId,
                    fileChangePathKeys = fileChangePathKeys,
                    allowCompletedFileChange = true,
                )
            if (idx >= 0) {
                val m = list[idx]
                val existing = m.text.trim()
                val shouldReplace =
                    existing.isEmpty() ||
                        existing.equals("[file change]", ignoreCase = true) ||
                        existing.equals("file change", ignoreCase = true) ||
                        existing.equals("applying file changes...", ignoreCase = true) ||
                        isStructuredFileChangeSnapshot(incoming)
                if (shouldReplace) {
                    list[idx] =
                        m.copy(
                            text = incoming,
                            isStreaming = true,
                            turnId = turnId ?: m.turnId,
                            itemId = itemId ?: m.itemId,
                        )
                    pruneDuplicateFileChangeRows(
                        list,
                        idx,
                        turnId,
                        fileChangePathKeys,
                        isStructuredFileChangeSnapshot(incoming),
                    )
                }
            } else {
                list.add(
                    CodexMessage(
                        threadId = threadId,
                        role = CodexMessageRole.system,
                        kind = kind,
                        text = incoming,
                        createdAt = Instant.now(),
                        turnId = turnId,
                        itemId = itemId,
                        isStreaming = true,
                    ),
                )
            }
            map[threadId] = list
            publishMessages(map)
        }
    }

    /**
     * Ensures a streaming system item exists for the given identity, without appending output deltas into its `text`.
     * This is used for command execution previews where the live output is stored separately.
     */
    suspend fun ensureStreamingSystemItem(
        threadId: String,
        turnId: String?,
        itemId: String?,
        kind: CodexMessageKind,
        initialText: String,
    ) {
        val seed = initialText.trim()
        if (seed.isEmpty()) return
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val existing =
                list.any { m ->
                    m.role == CodexMessageRole.system &&
                        m.kind == kind &&
                        m.isStreaming &&
                        (
                            (itemId != null && m.itemId == itemId) ||
                                (itemId == null && turnId != null && m.turnId == turnId)
                        )
                }
            if (!existing) {
                list.add(
                    CodexMessage(
                        threadId = threadId,
                        role = CodexMessageRole.system,
                        kind = kind,
                        text = seed,
                        createdAt = Instant.now(),
                        turnId = turnId,
                        itemId = itemId,
                        isStreaming = true,
                    ),
                )
                map[threadId] = list
                publishMessages(map)
            }
        }
    }

    /** Reasoning in arrivo dopo fine turno: merge nella riga thinking esistente (parity iOS `mergeLateReasoningDeltaIfPossible`). */
    suspend fun mergeLateReasoningDelta(
        threadId: String,
        turnId: String?,
        itemId: String?,
        delta: String,
    ): Boolean {
        if (delta.trim().isEmpty()) return false
        return mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val idx =
                list.indexOfLast { m ->
                    m.role == CodexMessageRole.system &&
                        m.kind == CodexMessageKind.thinking &&
                        (
                            (itemId != null && m.itemId == itemId) ||
                                (itemId == null && turnId != null && m.turnId == turnId)
                        )
                }
            if (idx < 0) {
                return@withLock false
            }
            val m = list[idx]
            list[idx] =
                m.copy(
                    text = mergeSnapshot(m.text, delta),
                    isStreaming = false,
                    turnId = turnId ?: m.turnId,
                    itemId = itemId ?: m.itemId,
                )
            map[threadId] = list
            publishMessages(map)
            true
        }
    }

    suspend fun completeSystemItem(
        threadId: String,
        turnId: String?,
        itemId: String?,
        kind: CodexMessageKind,
        text: String,
    ) {
        val finalText = text.trim()
        if (finalText.isEmpty()) return
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val fileChangePathKeys =
                if (kind == CodexMessageKind.fileChange) normalizedFileChangePathKeys(finalText) else emptySet()
            val idx =
                findCompletedSystemItemIndex(
                    list = list,
                    kind = kind,
                    turnId = turnId,
                    itemId = itemId,
                    finalText = finalText,
                    fileChangePathKeys = fileChangePathKeys,
                    isAuthoritativeFileChangeSnapshot = isStructuredFileChangeSnapshot(finalText),
                )
            if (idx >= 0) {
                val m = list[idx]
                val merged =
                    when (kind) {
                        CodexMessageKind.commandExecution -> finalText
                        CodexMessageKind.fileChange ->
                            if (isFileChangePlaceholder(finalText) && isStructuredFileChangeSnapshot(m.text)) {
                                m.text
                            } else if (isFileChangePlaceholder(m.text) && !isFileChangePlaceholder(finalText)) {
                                finalText
                            } else if (m.text.isEmpty()) {
                                finalText
                            } else {
                                mergeSnapshot(m.text, finalText)
                            }
                        else ->
                            if (m.text.isEmpty()) {
                                finalText
                            } else {
                                mergeSnapshot(m.text, finalText)
                            }
                    }
                list[idx] =
                    m.copy(
                        text = merged,
                        isStreaming = false,
                        turnId = turnId ?: m.turnId,
                        itemId = itemId ?: m.itemId,
                    )
                pruneDuplicateFileChangeRows(
                    list,
                    idx,
                    turnId,
                    fileChangePathKeys,
                    isStructuredFileChangeSnapshot(finalText),
                )
                pruneDuplicateCommandExecutionRows(list, idx, turnId, finalText)
            } else {
                list.add(
                    CodexMessage(
                        threadId = threadId,
                        role = CodexMessageRole.system,
                        kind = kind,
                        text = finalText,
                        createdAt = Instant.now(),
                        turnId = turnId,
                        itemId = itemId,
                        isStreaming = false,
                    ),
                )
                pruneDuplicateCommandExecutionRows(list, list.lastIndex, turnId, finalText)
            }
            map[threadId] = list
            publishMessages(map)
        }
    }

    suspend fun upsertPlanMessage(
        threadId: String,
        turnId: String?,
        itemId: String?,
        text: String? = null,
        explanation: String? = null,
        steps: List<CodexPlanStep>? = null,
        isStreaming: Boolean,
    ) {
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val idx =
                list.indexOfLast { message ->
                    message.role == CodexMessageRole.system &&
                        message.kind == CodexMessageKind.plan &&
                        (
                            (itemId != null && message.itemId == itemId) ||
                                (itemId == null && turnId != null && message.turnId == turnId)
                        )
                }

            if (idx >= 0) {
                val current = list[idx]
                val mergedText =
                    text?.trim()?.takeIf { it.isNotEmpty() }?.let { incoming ->
                        if (current.text.isEmpty()) {
                            incoming
                        } else {
                            mergeSnapshot(current.text, incoming)
                        }
                    } ?: current.text
                val currentState = current.planState ?: CodexPlanState()
                val nextState =
                    currentState.copy(
                        explanation =
                            explanation?.trim()?.takeIf { it.isNotEmpty() }
                                ?: currentState.explanation,
                        steps = steps ?: currentState.steps,
                    )
                list[idx] =
                    current.copy(
                        text = mergedText,
                        isStreaming = isStreaming,
                        turnId = turnId ?: current.turnId,
                        itemId = itemId ?: current.itemId,
                        planState =
                            if (nextState.explanation != null || nextState.steps.isNotEmpty()) {
                                nextState
                            } else {
                                null
                            },
                    )
            } else {
                val trimmedText = text?.trim()?.takeIf { it.isNotEmpty() } ?: "Planning..."
                val nextState =
                    CodexPlanState(
                        explanation = explanation?.trim()?.takeIf { it.isNotEmpty() },
                        steps = steps ?: emptyList(),
                    )
                list.add(
                    CodexMessage(
                        threadId = threadId,
                        role = CodexMessageRole.system,
                        kind = CodexMessageKind.plan,
                        text = trimmedText,
                        createdAt = Instant.now(),
                        turnId = turnId,
                        itemId = itemId,
                        isStreaming = isStreaming,
                        planState =
                            if (nextState.explanation != null || nextState.steps.isNotEmpty()) {
                                nextState
                            } else {
                                null
                            },
                    ),
                )
            }

            map[threadId] = list
            publishMessages(map)
        }
    }

    suspend fun upsertSubagentActionMessage(
        threadId: String,
        turnId: String?,
        itemId: String?,
        action: CodexSubagentAction,
        isStreaming: Boolean,
    ) {
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val summaryRefs = subagentDirectory.summaryRefsForTurn(list, turnId)
            summaryRefs.forEach { ref ->
                subagentDirectory.upsert(ref.threadId, ref.agentId, ref.nickname, ref.role)
            }
            val incomingAction = subagentDirectory.resolveAction(subagentDirectory.enrichAction(action, summaryRefs))
            subagentDirectory.removeAssistantSummaries(list, turnId)
            val idx =
                list.indexOfLast { message ->
                    message.role == CodexMessageRole.system &&
                        message.kind == CodexMessageKind.subagentAction &&
                        (
                            (itemId != null && message.itemId == itemId) ||
                                (
                                    itemId == null &&
                                        turnId != null &&
                                        message.turnId == turnId &&
                                        message.subagentAction?.normalizedTool == incomingAction.normalizedTool
                                )
                        )
                }

            if (idx >= 0) {
                val current = list[idx]
                val mergedAction =
                    subagentDirectory.resolveAction(subagentDirectory.mergeActions(current.subagentAction, incomingAction))
                list[idx] =
                    current.copy(
                        text = mergedAction.summaryText,
                        isStreaming = isStreaming,
                        turnId = turnId ?: current.turnId,
                        itemId = itemId ?: current.itemId,
                        subagentAction = mergedAction,
                    )
            } else {
                list.add(
                    CodexMessage(
                        threadId = threadId,
                        role = CodexMessageRole.system,
                        kind = CodexMessageKind.subagentAction,
                        text = incomingAction.summaryText,
                        createdAt = Instant.now(),
                        turnId = turnId,
                        itemId = itemId,
                        isStreaming = isStreaming,
                        subagentAction = incomingAction,
                    ),
                )
            }
            map[threadId] = list
            publishMessages(map)
        }
    }

    suspend fun appendAssistantDelta(
        threadId: String,
        turnId: String?,
        itemId: String?,
        delta: String,
        assistantPhase: String? = null,
    ) {
        if (delta.isEmpty()) return
        mutex.withLock {
            val resolvedTurnId = turnId?.trim()?.takeIf { it.isNotEmpty() }
            val resolvedItemId = itemId?.trim()?.takeIf { it.isNotEmpty() }
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val idx =
                list.indexOfLast { m ->
                    m.role == CodexMessageRole.assistant &&
                        m.kind == CodexMessageKind.chat &&
                        m.isStreaming &&
                        matchesAssistantDeltaCandidate(
                            candidate = m,
                            turnId = resolvedTurnId,
                            itemId = resolvedItemId,
                        )
                }
            if (idx >= 0) {
                val m = list[idx]
                list[idx] =
                    m.copy(
                        text = m.text + delta,
                        assistantPhase = assistantPhase ?: m.assistantPhase,
                        isStreaming = true,
                        turnId = resolvedTurnId ?: m.turnId,
                        itemId = resolvedItemId ?: m.itemId,
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
            val map = _messagesByThread.value.toMutableMap()
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
        attachments: List<CodexImageAttachment> = emptyList(),
        assistantPhase: String? = null,
    ) {
        val finalText = text.trim()
        if (finalText.isEmpty() && attachments.isEmpty()) return
        mutex.withLock {
            val resolvedTurnId = turnId?.trim()?.takeIf { it.isNotEmpty() }
            val resolvedItemId = itemId?.trim()?.takeIf { it.isNotEmpty() }
            val normalizedFinalText = normalizedMessageText(finalText)
            val now = Instant.now()

            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            if (subagentDirectory.absorbAssistantSummary(list, resolvedTurnId, finalText)) {
                map[threadId] = list
                publishMessages(map)
                return@withLock
            }
            val idx =
                list.indexOfLast { m ->
                    m.role == CodexMessageRole.assistant &&
                        m.kind == CodexMessageKind.chat &&
                        matchesCompletedMessageCandidate(
                            candidate = m,
                            turnId = resolvedTurnId,
                            itemId = resolvedItemId,
                        )
                }
            if (idx >= 0) {
                val m = list[idx]
                list[idx] =
                    m.copy(
                        text = if (m.text.isEmpty()) finalText else mergeSnapshot(m.text, finalText),
                        assistantPhase = assistantPhase ?: m.assistantPhase,
                        isStreaming = false,
                        turnId = resolvedTurnId ?: m.turnId,
                        itemId = resolvedItemId ?: m.itemId,
                        attachments = if (attachments.isNotEmpty()) attachments else m.attachments,
                    )
            } else {
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
            map[threadId] = list
            publishMessages(map)
        }
    }

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
    ): String {
        val trimmed = text.trim()
        val id = UUID.randomUUID().toString()
        if (trimmed.isEmpty() && attachments.isEmpty()) return id
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
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
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val idx = list.indexOfFirst { it.id == messageId }
            if (idx >= 0) {
                val m = list[idx]
                list[idx] =
                    m.copy(
                        deliveryState = deliveryState,
                        turnId = turnId ?: m.turnId,
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
        attachments: List<CodexImageAttachment> = emptyList(),
    ) {
        val t = text.trim()
        val normalizedText = normalizedMessageText(t)
        if (t.isEmpty() && attachments.isEmpty()) return
        mutex.withLock {
            val map = _messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val existingIdx =
                list.indexOfLast { m ->
                    m.role == CodexMessageRole.user &&
                        normalizedMessageText(m.text) == normalizedText &&
                        compatibleUserAttachments(m.attachments, attachments) &&
                        (
                            (turnId != null && (m.turnId == null || m.turnId == turnId)) ||
                                (turnId == null && m.turnId == null)
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
                if (next != existing) {
                    list[existingIdx] = next
                }
            } else {
                val insertionIndex =
                    turnId
                        ?.let { resolvedTurnId ->
                            list
                                .indexOfFirst { message ->
                                    message.turnId == resolvedTurnId && message.role != CodexMessageRole.user
                                }.takeIf { it >= 0 }
                        }
                        ?: list.size
                list.add(
                    insertionIndex,
                    CodexMessage(
                        threadId = threadId,
                        role = CodexMessageRole.user,
                        kind = CodexMessageKind.chat,
                        text = t,
                        createdAt = Instant.now(),
                        turnId = turnId,
                        deliveryState = CodexMessageDeliveryState.confirmed,
                        isStreaming = false,
                        attachments = attachments,
                    ),
                )
                if (insertionIndex < list.lastIndex) {
                    reassignOrderIndexesInCurrentOrder(list)
                }
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
            val map = _messagesByThread.value.toMutableMap()
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
            val map = _messagesByThread.value.toMutableMap()
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

    private fun reassignOrderIndexesInCurrentOrder(list: MutableList<CodexMessage>) {
        for (index in list.indices) {
            list[index] = list[index].copy(orderIndex = CodexMessageOrderCounter.next())
        }
    }

    private companion object {
        const val DEFAULT_INITIAL_TAIL_LIMIT = 48
    }
}
