package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import com.dotbrains.agnt.mobile.core.model.CodexPlanState
import com.dotbrains.agnt.mobile.core.model.CodexPlanStep
import com.dotbrains.agnt.mobile.core.model.CodexSubagentAction
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant

internal class MessageTimelineSystemItems(
    private val mutex: Mutex,
    private val messagesByThread: MutableStateFlow<Map<String, List<CodexMessage>>>,
    private val subagentDirectory: MessageTimelineSubagentDirectory,
    private val publishMessages: (Map<String, List<CodexMessage>>) -> Unit,
) {
    suspend fun appendStreamingSystemItemDelta(
        threadId: String,
        turnId: String?,
        itemId: String?,
        kind: CodexMessageKind,
        delta: String,
    ) {
        if (delta.isEmpty()) return
        mutex.withLock {
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val fileChangePathKeys =
                if (kind == CodexMessageKind.fileChange) normalizedFileChangePathKeys(delta) else emptySet()
            val idx = findStreamingSystemItemIndex(list, kind, turnId, itemId, fileChangePathKeys)
            if (idx >= 0) {
                val message = list[idx]
                list[idx] =
                    message.copy(
                        text = message.text + delta,
                        isStreaming = true,
                        turnId = turnId ?: message.turnId,
                        itemId = itemId ?: message.itemId,
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
            val map = messagesByThread.value.toMutableMap()
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
                val message = list[idx]
                val existing = message.text.trim()
                val shouldReplace =
                    existing.isEmpty() ||
                        existing.equals("[file change]", ignoreCase = true) ||
                        existing.equals("file change", ignoreCase = true) ||
                        existing.equals("applying file changes...", ignoreCase = true) ||
                        isStructuredFileChangeSnapshot(incoming)
                if (shouldReplace) {
                    list[idx] =
                        message.copy(
                            text = incoming,
                            isStreaming = true,
                            turnId = turnId ?: message.turnId,
                            itemId = itemId ?: message.itemId,
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
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val existing =
                list.any { message ->
                    message.role == CodexMessageRole.system &&
                        message.kind == kind &&
                        message.isStreaming &&
                        (
                            (itemId != null && message.itemId == itemId) ||
                                (itemId == null && turnId != null && message.turnId == turnId)
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

    suspend fun mergeLateReasoningDelta(
        threadId: String,
        turnId: String?,
        itemId: String?,
        delta: String,
    ): Boolean {
        if (delta.trim().isEmpty()) return false
        return mutex.withLock {
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val idx =
                list.indexOfLast { message ->
                    message.role == CodexMessageRole.system &&
                        message.kind == CodexMessageKind.thinking &&
                        (
                            (itemId != null && message.itemId == itemId) ||
                                (itemId == null && turnId != null && message.turnId == turnId)
                        )
                }
            if (idx < 0) return@withLock false
            val message = list[idx]
            list[idx] =
                message.copy(
                    text = mergeSnapshot(message.text, delta),
                    isStreaming = false,
                    turnId = turnId ?: message.turnId,
                    itemId = itemId ?: message.itemId,
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
            val map = messagesByThread.value.toMutableMap()
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
                val message = list[idx]
                val merged =
                    when (kind) {
                        CodexMessageKind.commandExecution -> finalText
                        CodexMessageKind.fileChange ->
                            when {
                                isFileChangePlaceholder(finalText) && isStructuredFileChangeSnapshot(message.text) -> message.text
                                isFileChangePlaceholder(message.text) && !isFileChangePlaceholder(finalText) -> finalText
                                message.text.isEmpty() -> finalText
                                else -> mergeSnapshot(message.text, finalText)
                            }
                        else ->
                            if (message.text.isEmpty()) finalText else mergeSnapshot(message.text, finalText)
                    }
                list[idx] =
                    message.copy(
                        text = merged,
                        isStreaming = false,
                        turnId = turnId ?: message.turnId,
                        itemId = itemId ?: message.itemId,
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
        text: String?,
        explanation: String?,
        steps: List<CodexPlanStep>?,
        isStreaming: Boolean,
    ) {
        mutex.withLock {
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val idx =
                list.indexOfLast { message ->
                    message.role == CodexMessageRole.system &&
                        message.kind == CodexMessageKind.plan &&
                        ((itemId != null && message.itemId == itemId) || (itemId == null && turnId != null && message.turnId == turnId))
                }
            if (idx >= 0) {
                val current = list[idx]
                val mergedText =
                    text?.trim()?.takeIf { it.isNotEmpty() }?.let { incoming ->
                        if (current.text.isEmpty()) incoming else mergeSnapshot(current.text, incoming)
                    } ?: current.text
                val currentState = current.planState ?: CodexPlanState()
                val nextState =
                    currentState.copy(
                        explanation = explanation?.trim()?.takeIf { it.isNotEmpty() } ?: currentState.explanation,
                        steps = steps ?: currentState.steps,
                    )
                list[idx] =
                    current.copy(
                        text = mergedText,
                        isStreaming = isStreaming,
                        turnId = turnId ?: current.turnId,
                        itemId = itemId ?: current.itemId,
                        planState = nextState.takeIf { it.explanation != null || it.steps.isNotEmpty() },
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
                        planState = nextState.takeIf { it.explanation != null || it.steps.isNotEmpty() },
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
            val map = messagesByThread.value.toMutableMap()
            val list = map[threadId].orEmpty().toMutableList()
            val summaryRefs = subagentDirectory.summaryRefsForTurn(list, turnId)
            summaryRefs.forEach { ref -> subagentDirectory.upsert(ref.threadId, ref.agentId, ref.nickname, ref.role) }
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
}
