package com.smeltery.agnt.mobile.data

import com.smeltery.agnt.mobile.core.model.CodexImageAttachment
import com.smeltery.agnt.mobile.core.model.CodexMessageKind
import com.smeltery.agnt.mobile.core.model.CodexMessageRole
import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.core.model.JSONValue
import com.smeltery.agnt.mobile.core.notification.RunCompletionAttentionKind
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal class IncomingTimelineEventRouter(
    private val scope: CoroutineScope,
    private val messageTimeline: MessageTimelineStore,
    private val commandDetailsStore: CommandExecutionDetailsStore,
    private val isTurnStreamingActive: (threadId: String, turnId: String?) -> Boolean,
    private val onTurnCompleted: (threadId: String) -> Unit,
    private val onTurnFailed: (threadId: String) -> Unit,
    private val onRunCompletionAttention: (
        threadId: String,
        turnId: String?,
        kind: RunCompletionAttentionKind,
    ) -> Unit,
    private val resolveThreadId: (Map<String, JSONValue>?) -> String?,
    private val recordTurnThread: (turnId: String?, threadId: String?) -> Unit,
    private val markTurnActiveFromLiveEvent: (threadId: String, turnId: String?) -> Unit,
) {
    fun handleAgentDelta(params: Map<String, JSONValue>?) {
        val delta = IncomingNotificationParsers.extractAssistantDelta(params) ?: return
        val turnId = IncomingNotificationParsers.extractTurnId(params)
        val threadId = resolveThreadId(params) ?: IncomingNotificationParsers.extractThreadId(params) ?: return
        val itemId = IncomingNotificationParsers.extractItemId(params)
        val assistantPhase = IncomingNotificationParsers.extractAssistantPhase(params)
        markTurnActiveFromLiveEvent(threadId, turnId)
        scope.launch {
            messageTimeline.appendAssistantDelta(threadId, turnId, itemId, delta, assistantPhase)
        }
    }

    fun handleItemCompleted(
        params: Map<String, JSONValue>?,
        completesTurn: Boolean = false,
    ) {
        val p = params ?: return
        val ev = envelopeEventObject(p)
        val itemObj = IncomingNotificationParsers.extractIncomingItemObject(p, ev)
        if (itemObj == null) {
            handleLegacyAgentCompleted(p, completesTurn)
            return
        }
        val decoded = ThreadHistoryDecoder.decodeCompletedItem(itemObj)
        if (decoded == null) {
            handleLegacyAgentCompleted(p, completesTurn)
            return
        }
        val threadId = resolveThreadId(p) ?: IncomingNotificationParsers.extractThreadId(p) ?: return
        val turnId = IncomingNotificationParsers.extractTurnId(p)
        val itemId = extractItemIdDeep(p, itemObj)
        recordTurnThread(turnId, threadId)
        when (decoded.kind) {
            CodexMessageKind.chat ->
                when (decoded.role) {
                    CodexMessageRole.assistant -> {
                        val text = decoded.text.trim()
                        if (text.isEmpty() && decoded.attachments.isEmpty()) return
                        val assistantPhase =
                            decoded.assistantPhase ?: IncomingNotificationParsers.extractAssistantPhase(p, itemObj)
                        scope.launch {
                            messageTimeline.completeAssistantMessage(
                                threadId = threadId,
                                turnId = turnId,
                                itemId = itemId,
                                text = text,
                                attachments = decoded.attachments,
                                assistantPhase = assistantPhase,
                            )
                        }
                        if (completesTurn && turnId.isNullOrBlank()) {
                            onTurnCompleted(threadId)
                        }
                    }
                    CodexMessageRole.user -> {
                        val text = decoded.text.trim()
                        if (text.isEmpty() && decoded.attachments.isEmpty()) return
                        scope.launch {
                            messageTimeline.appendMirroredUser(threadId, turnId, text, decoded.attachments)
                        }
                    }
                    else -> handleLegacyAgentCompleted(p)
                }
            CodexMessageKind.thinking,
            CodexMessageKind.fileChange,
            CodexMessageKind.commandExecution,
            -> {
                val text = decoded.text.trim()
                if (text.isEmpty()) return
                if (decoded.kind == CodexMessageKind.commandExecution) {
                    val state =
                        CommandExecutionEventParser.parse(
                            params = p,
                            eventObject = itemObj,
                            method = "item/completed",
                        )
                    commandDetailsStore.upsertFromState(
                        itemId = state.itemId ?: itemId,
                        fullCommand = state.fullCommand,
                        cwd = state.cwd,
                        exitCode = state.exitCode,
                        durationMs = state.durationMs,
                    )
                }
                scope.launch {
                    messageTimeline.completeSystemItem(threadId, turnId, itemId, decoded.kind, text)
                }
            }
            CodexMessageKind.plan -> {
                val text = decoded.text.trim()
                scope.launch {
                    messageTimeline.upsertPlanMessage(
                        threadId = threadId,
                        turnId = turnId,
                        itemId = itemId,
                        text = text.ifEmpty { null },
                        explanation = decoded.planState?.explanation,
                        steps = decoded.planState?.steps,
                        isStreaming = false,
                    )
                }
            }
            CodexMessageKind.subagentAction -> {
                val action = decoded.subagentAction ?: return
                scope.launch {
                    messageTimeline.upsertSubagentActionMessage(
                        threadId = threadId,
                        turnId = turnId,
                        itemId = itemId,
                        action = action,
                        isStreaming = false,
                    )
                }
            }
            else -> handleLegacyAgentCompleted(p)
        }
    }

    fun handleUserMirrored(params: Map<String, JSONValue>?) {
        val text = IncomingNotificationParsers.extractUserMirrorText(params) ?: return
        val turnId = IncomingNotificationParsers.extractTurnId(params)
        val threadId = resolveThreadId(params) ?: return
        markTurnActiveFromLiveEvent(threadId, turnId)
        scope.launch {
            messageTimeline.appendMirroredUser(threadId, turnId, text)
            if (!turnId.isNullOrBlank()) {
                messageTimeline.ensureStreamingAssistantPlaceholder(threadId, turnId)
            }
        }
    }

    fun handleBackgroundEvent(params: Map<String, JSONValue>?) {
        val p = params ?: return
        val text =
            (
                IncomingNotificationParsers.extractTextDelta(p)
                    ?: firstIncomingString(p, listOf("message", "activity", "status"))
                    ?: envelopeEventObject(p)?.let { firstIncomingString(it, listOf("message", "activity", "status")) }
            )?.trim()?.takeIf { it.isNotEmpty() } ?: return
        val turnId = IncomingNotificationParsers.extractTurnId(p)
        val threadId = resolveThreadId(p) ?: return
        markTurnActiveFromLiveEvent(threadId, turnId)
        val itemId = IncomingNotificationParsers.extractItemId(p)
        scope.launch {
            if (!turnId.isNullOrBlank()) {
                messageTimeline.upsertStreamingSystemItemSnapshot(
                    threadId = threadId,
                    turnId = turnId,
                    itemId = itemId,
                    kind = CodexMessageKind.thinking,
                    snapshot = text,
                )
            } else {
                messageTimeline.appendSystemLine(
                    threadId = threadId,
                    turnId = null,
                    text = text,
                    kind = CodexMessageKind.thinking,
                )
            }
        }
    }

    fun handleReasoningDelta(params: Map<String, JSONValue>?) {
        val p = params ?: return
        val delta = IncomingNotificationParsers.extractTextDelta(p) ?: return
        if (delta.isEmpty()) return
        val turnId = IncomingNotificationParsers.extractTurnId(p)
        val threadId = resolveThreadId(p) ?: return
        recordTurnThread(turnId, threadId)
        val itemId = IncomingNotificationParsers.extractItemId(p)
        if (!isTurnStreamingActive(threadId, turnId)) {
            scope.launch {
                messageTimeline.mergeLateReasoningDelta(threadId, turnId, itemId, delta)
            }
            return
        }
        scope.launch {
            when {
                itemId != null ->
                    messageTimeline.appendStreamingSystemItemDelta(
                        threadId = threadId,
                        turnId = turnId,
                        itemId = itemId,
                        kind = CodexMessageKind.thinking,
                        delta = delta,
                    )
                !turnId.isNullOrEmpty() ->
                    messageTimeline.appendStreamingSystemItemDelta(
                        threadId = threadId,
                        turnId = turnId,
                        itemId = null,
                        kind = CodexMessageKind.thinking,
                        delta = delta,
                    )
                else ->
                    messageTimeline.appendSystemLine(
                        threadId = threadId,
                        turnId = null,
                        text = delta,
                        kind = CodexMessageKind.thinking,
                    )
            }
        }
    }

    fun handlePlanDelta(params: Map<String, JSONValue>?) {
        val p = params ?: return
        val event = envelopeEventObject(p)
        val threadId =
            resolveThreadId(p)
                ?: firstIncomingString(p, listOf("threadId", "thread_id"))
                    ?.let { CodexThread.normalizeIdentifier(it) }
                ?: event
                    ?.let { firstIncomingString(it, listOf("threadId", "thread_id")) }
                    ?.let { CodexThread.normalizeIdentifier(it) }
                ?: return
        val turnId =
            firstIncomingString(p, listOf("turnId", "turn_id"))
                ?: event?.let { firstIncomingString(it, listOf("turnId", "turn_id")) }
                ?: return
        val itemId =
            firstIncomingString(p, listOf("itemId", "item_id"))
                ?: event?.let { firstIncomingString(it, listOf("itemId", "item_id")) }
                ?: return
        val delta = p["delta"]?.stringValue ?: event?.get("delta")?.stringValue ?: return
        if (delta.isEmpty()) return
        markTurnActiveFromLiveEvent(threadId, turnId)
        scope.launch {
            messageTimeline.upsertPlanMessage(
                threadId = threadId,
                turnId = turnId,
                itemId = itemId,
                text = delta,
                isStreaming = true,
            )
        }
    }

    fun handleTurnPlanUpdated(params: Map<String, JSONValue>?) {
        val p = params ?: return
        val event = envelopeEventObject(p)
        val threadId =
            resolveThreadId(p)
                ?: firstIncomingString(p, listOf("threadId", "thread_id"))
                    ?.let { CodexThread.normalizeIdentifier(it) }
                ?: event
                    ?.let { firstIncomingString(it, listOf("threadId", "thread_id")) }
                    ?.let { CodexThread.normalizeIdentifier(it) }
                ?: return
        val turnId =
            firstIncomingString(p, listOf("turnId", "turn_id"))
                ?: event?.let { firstIncomingString(it, listOf("turnId", "turn_id")) }
                ?: return
        markTurnActiveFromLiveEvent(threadId, turnId)
        val explanation =
            firstIncomingString(p, listOf("explanation", "summary"))
                ?: event?.let { firstIncomingString(it, listOf("explanation", "summary")) }
        val steps = decodeIncomingPlanSteps(p["plan"] ?: event?.get("plan"))
        scope.launch {
            messageTimeline.upsertPlanMessage(
                threadId = threadId,
                turnId = turnId,
                itemId = null,
                explanation = explanation,
                steps = steps,
                isStreaming = true,
            )
        }
    }

    fun handleFileChangeDelta(params: Map<String, JSONValue>?) {
        val p = params ?: return
        val turnId = IncomingNotificationParsers.extractTurnId(p)
        val threadId = resolveThreadId(p) ?: return
        markTurnActiveFromLiveEvent(threadId, turnId)
        val itemId = IncomingNotificationParsers.extractItemId(p)
        val itemObj =
            IncomingNotificationParsers.extractIncomingItemObject(
                params = p,
                event = envelopeEventObject(p),
            )
        val rendered = itemObj?.let { FileChangeItemBodyRenderer.renderFromIncomingItem(it) }?.trim().orEmpty()
        val delta = IncomingNotificationParsers.extractTextDelta(p)?.trim().orEmpty()
        if (shouldIgnoreFileChangeDelta(rendered, delta)) return
        scope.launch {
            if (rendered.isNotEmpty()) {
                messageTimeline.upsertStreamingSystemItemSnapshot(
                    threadId = threadId,
                    turnId = turnId,
                    itemId = itemId,
                    kind = CodexMessageKind.fileChange,
                    snapshot = rendered,
                )
                return@launch
            }
            if (delta.isEmpty() || delta.equals("[file change]", ignoreCase = true)) return@launch
            when {
                itemId != null ->
                    messageTimeline.appendStreamingSystemItemDelta(
                        threadId,
                        turnId,
                        itemId,
                        CodexMessageKind.fileChange,
                        delta,
                    )
                !turnId.isNullOrEmpty() ->
                    messageTimeline.appendStreamingSystemItemDelta(
                        threadId,
                        turnId,
                        null,
                        CodexMessageKind.fileChange,
                        delta,
                    )
                else ->
                    messageTimeline.appendSystemLine(
                        threadId,
                        null,
                        delta,
                        CodexMessageKind.fileChange,
                    )
            }
        }
    }

    fun handleImageGenerationEnd(params: Map<String, JSONValue>?) {
        val p = params ?: return
        val event = envelopeEventObject(p)
        val imagePath =
            firstIncomingString(p, listOf("saved_path", "savedPath", "path", "url", "image_url"))
                ?: event?.let { firstIncomingString(it, listOf("saved_path", "savedPath", "path", "url", "image_url")) }
                ?: return
        val attachment =
            TurnAttachmentCodec.attachmentFromHistorySource(imagePath)
                ?: CodexImageAttachment(thumbnailBase64JPEG = "", sourceURL = imagePath)
        val turnId = IncomingNotificationParsers.extractTurnId(p)
        val threadId = resolveThreadId(p) ?: return
        recordTurnThread(turnId, threadId)
        val itemId =
            IncomingNotificationParsers.extractItemId(p)
                ?: firstIncomingString(p, listOf("call_id", "callId", "id"))
                ?: event?.let { firstIncomingString(it, listOf("call_id", "callId", "id")) }
        scope.launch {
            messageTimeline.completeAssistantMessage(
                threadId = threadId,
                turnId = turnId,
                itemId = itemId,
                text = "",
                attachments = listOf(attachment),
                assistantPhase = "final",
            )
        }
    }

    fun handleToolCallOutputDelta(params: Map<String, JSONValue>?) {
        handleFileChangeDelta(params)
    }

    fun handleErrorNotification(
        params: Map<String, JSONValue>?,
        markFailed: Boolean = true,
    ) {
        val threadId = resolveThreadId(params) ?: return
        val turnId = IncomingNotificationParsers.extractTurnId(params)
        val text = IncomingNotificationParsers.extractErrorMessage(params) ?: return
        if (markFailed) {
            onTurnFailed(threadId)
        }
        scope.launch {
            messageTimeline.appendSystemLine(threadId, turnId, "Error: $text")
        }
        onRunCompletionAttention(threadId, turnId, RunCompletionAttentionKind.Failed)
    }

    private fun handleLegacyAgentCompleted(
        params: Map<String, JSONValue>,
        completesTurn: Boolean = false,
    ) {
        val threadId = resolveThreadId(params) ?: return
        val turnId = IncomingNotificationParsers.extractTurnId(params)
        val itemId = IncomingNotificationParsers.extractItemId(params)
        val text =
            IncomingNotificationParsers.extractAssistantDelta(params)
                ?: IncomingNotificationParsers.extractUserMirrorText(params)
                ?: return
        if (text.isBlank()) return
        val assistantPhase = IncomingNotificationParsers.extractAssistantPhase(params)
        recordTurnThread(turnId, threadId)
        scope.launch {
            messageTimeline.completeAssistantMessage(
                threadId = threadId,
                turnId = turnId,
                itemId = itemId,
                text = text,
                assistantPhase = assistantPhase,
            )
        }
        if (completesTurn && turnId.isNullOrBlank()) {
            onTurnCompleted(threadId)
        }
    }
}
