package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.ContextWindowUsage
import com.dotbrains.agnt.mobile.core.model.ContextWindowUsageCodec
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.PendingApprovalDecision
import com.dotbrains.agnt.mobile.core.model.PendingApprovalRequest
import com.dotbrains.agnt.mobile.core.model.PendingStructuredInputRequest
import com.dotbrains.agnt.mobile.core.model.RPCMessage
import com.dotbrains.agnt.mobile.core.notification.RunCompletionAttentionKind
import com.dotbrains.agnt.mobile.core.notification.TurnCompletionNotificationLogic
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * Routes Mac→phone JSON-RPC notifications and server-initiated requests.
 * Parity with [AgentService.handleNotification] / [AgentService.handleServerRequest] (iOS).
 */
internal class IncomingEventRouter(
    private val scope: CoroutineScope,
    private val threads: MutableStateFlow<List<CodexThread>>,
    private val activeThreadId: MutableStateFlow<String?>,
    private val messageTimeline: MessageTimelineStore,
    private val commandDetailsStore: CommandExecutionDetailsStore = CommandExecutionDetailsStore(),
    private val onRequestThreadSync: () -> Unit,
    private val onHydrateThread: (String) -> Unit,
    /** [turnId] null ⇒ run attivo senza id ancora (protected fallback iOS). */
    private val onTurnLifecycle: (threadId: String, turnId: String?) -> Unit,
    private val onTurnFinished: (threadId: String) -> Unit,
    private val onTurnCompleted: (threadId: String) -> Unit = { _ -> },
    private val onTurnFailed: (threadId: String) -> Unit = { _ -> },
    /**
     * Streaming reasoning/delta attivo per quel thread+turn (parity iOS `isReasoningTurnActive`).
     */
    private val isTurnStreamingActive: (threadId: String, turnId: String?) -> Boolean,
    private val shouldAutoApproveRequests: () -> Boolean,
    private val onApprovalRequest: (PendingApprovalRequest, (PendingApprovalDecision) -> Unit) -> Unit,
    private val onStructuredInputRequest: (
        PendingStructuredInputRequest,
        (answersByQuestionId: Map<String, List<String>>) -> Unit,
    ) -> Unit,
    private val onRateLimitsUpdated: (Map<String, JSONValue>?) -> Unit = { _ -> },
    /**
     * Live context window from [thread/tokenUsage/updated] or legacy `codex/event` `token_count`
     * (parity iOS `handleThreadTokenUsageUpdated` / `handleLegacyTokenCountEvent`).
     */
    private val onThreadContextUsageLive: (String, ContextWindowUsage) -> Unit = { _, _ -> },
    /**
     * When token events omit thread id, single unambiguous running thread (parity `resolveContextUsageThreadID`).
     */
    private val resolveAmbiguousUsageThreadId: () -> String? = { null },
    /** [thread/started] and similar: server may send stale `cwd` during same-thread rebind. */
    private val remapThreadFromServer: (CodexThread) -> CodexThread = { it },
    /** Local user rename wins over server-pushed rename/title fallback. */
    private val persistedThreadRename: (String) -> String? = { null },
    /**
     * Local notification hook when a turn completes or fails in the background (iOS `notifyRunCompletionIfNeeded`).
     */
    private val onRunCompletionAttention: (
        threadId: String,
        turnId: String?,
        kind: RunCompletionAttentionKind,
    ) -> Unit = { _, _, _ -> },
    /**
     * Toast surface for `system/notice` notifications (e.g. opencode
     * `tui.toast.show` proxied through the bridge). Receives the parsed envelope
     * fields; severity normalization + auto-dismiss live in the consumer.
     */
    private val onSystemNotice: (
        severity: String?,
        title: String?,
        message: String?,
        provider: String?,
        threadId: String?,
        durationMs: Long?,
    ) -> Unit = { _, _, _, _, _, _ -> },
) {
    private val threadIdByTurnId = ConcurrentHashMap<String, String>()
    private val commandExecutionRouter by lazy {
        IncomingCommandExecutionRouter(
            scope = scope,
            messageTimeline = messageTimeline,
            commandDetailsStore = commandDetailsStore,
            envelopeEventObject = ::envelopeEventObject,
            resolveThreadId = ::resolveThreadId,
            recordTurnThread = ::recordTurnThread,
            markTurnActiveFromLiveEvent = ::markTurnActiveFromLiveEvent,
        )
    }
    private val serverRequestRouter by lazy {
        IncomingServerRequestRouter(
            scope = scope,
            messageTimeline = messageTimeline,
            shouldAutoApproveRequests = shouldAutoApproveRequests,
            onApprovalRequest = onApprovalRequest,
            onStructuredInputRequest = onStructuredInputRequest,
            resolveThreadId = ::resolveThreadId,
        )
    }
    private val timelineEventRouter by lazy {
        IncomingTimelineEventRouter(
            scope = scope,
            messageTimeline = messageTimeline,
            commandDetailsStore = commandDetailsStore,
            isTurnStreamingActive = isTurnStreamingActive,
            onTurnCompleted = onTurnCompleted,
            onTurnFailed = onTurnFailed,
            onRunCompletionAttention = onRunCompletionAttention,
            resolveThreadId = ::resolveThreadId,
            recordTurnThread = ::recordTurnThread,
            markTurnActiveFromLiveEvent = ::markTurnActiveFromLiveEvent,
        )
    }

    fun resetCaches() {
        threadIdByTurnId.clear()
    }

    fun dispatchNotification(
        method: String,
        params: JSONValue?,
    ) {
        val m = method.trim()
        val obj = params?.objectValue
        if (m.startsWith("codex/event/")) {
            val suffix =
                normalizeIncomingMethod(m.removePrefix("codex/event/").trim()).replace("/", "")
            if (suffix == "tokencount" && obj != null) {
                val payload =
                    obj["msg"]?.objectValue
                        ?: obj["event"]?.objectValue
                        ?: obj
                handleLegacyTokenCountEvent(obj, payload)
                return
            }
        }
        if (m == "codex/event" && tryConsumeCodexTokenCountEnvelope(obj)) {
            return
        }
        if (m == "codex/event" && tryConsumeCodexCommandExecutionEnvelope(obj)) {
            return
        }
        if (m == "codex/event" && tryConsumeCodexPlanEnvelope(obj)) {
            return
        }
        when (m) {
            "thread/started" -> handleThreadStarted(obj)
            "thread/name/updated" -> handleThreadNameUpdated(obj)
            "turn/started" -> handleTurnStarted(obj)
            "turn/completed" -> handleTurnCompleted(obj)
            "turn/plan/updated" -> timelineEventRouter.handleTurnPlanUpdated(obj)
            "item/agentMessage/delta",
            "codex/event/agent_message_content_delta",
            "codex/event/agent_message_delta",
            -> timelineEventRouter.handleAgentDelta(obj)
            "item/completed",
            "codex/event/item_completed",
            -> timelineEventRouter.handleItemCompleted(obj)
            "codex/event/agent_message" -> timelineEventRouter.handleItemCompleted(obj, completesTurn = true)
            "codex/event/user_message" -> timelineEventRouter.handleUserMirrored(obj)
            "codex/event/background_event" -> timelineEventRouter.handleBackgroundEvent(obj)
            "codex/event/image_generation_end" -> timelineEventRouter.handleImageGenerationEnd(obj)
            "item/reasoning/summaryTextDelta",
            "item/reasoning/summaryPartAdded",
            "item/reasoning/textDelta",
            -> timelineEventRouter.handleReasoningDelta(obj)
            "item/plan/delta" -> timelineEventRouter.handlePlanDelta(obj)
            "codex/event/plan_update",
            "codex/event/plan_updated",
            "codex/event/update_plan",
            "codex/event/plan_delta",
            -> timelineEventRouter.handleTurnPlanUpdated(obj)
            "item/fileChange/outputDelta" -> timelineEventRouter.handleFileChangeDelta(obj)
            "item/toolCall/outputDelta",
            "item/toolCall/output_delta",
            "item/tool_call/outputDelta",
            "item/tool_call/output_delta",
            -> timelineEventRouter.handleToolCallOutputDelta(obj)
            "item/commandExecution/outputDelta",
            "item/commandExecution/output_delta",
            "item/command_execution/outputDelta",
            "item/command_execution/output_delta",
            -> handleCommandExecutionDelta(m, obj)
            "exec_command_begin",
            "codex/event/exec_command_begin",
            -> handleCommandExecutionState(m, obj)
            "exec_command_output_delta",
            "codex/event/exec_command_output_delta",
            -> handleCommandExecutionDelta(m, obj)
            "exec_command_end",
            "codex/event/exec_command_end",
            -> handleCommandExecutionState(m, obj)
            "turn/failed" -> handleTurnFailed(obj)
            "error",
            "codex/event/error",
            -> timelineEventRouter.handleErrorNotification(obj)
            "account/rateLimits/updated" -> onRateLimitsUpdated(obj)
            "thread/tokenUsage/updated" -> handleThreadTokenUsagePush(obj)
            "system/notice" -> handleSystemNotice(obj)
            else -> {
                val nm = normalizeIncomingMethod(m)
                when {
                    m.startsWith("codex/event/") && m.contains("agent") && m.contains("delta") ->
                        timelineEventRouter.handleAgentDelta(obj)
                    m.startsWith("codex/event/") && nm.contains("plan") ->
                        timelineEventRouter.handleTurnPlanUpdated(obj)
                    m.startsWith("codex/event/") && nm.contains("imagegeneration") ->
                        timelineEventRouter.handleImageGenerationEnd(obj)
                    nm.contains("filechange") && (nm.contains("delta") || nm.contains("partadded")) ->
                        timelineEventRouter.handleFileChangeDelta(obj)
                    nm.contains("toolcall") && (nm.contains("delta") || nm.contains("partadded")) ->
                        timelineEventRouter.handleToolCallOutputDelta(obj)
                    (nm.contains("turndiff") || nm.contains("/diff/") || nm.startsWith("diff/")) &&
                        (nm.contains("delta") || nm.contains("partadded")) ->
                        timelineEventRouter.handleFileChangeDelta(obj)
                    else -> Unit
                }
            }
        }
    }

    private fun tryConsumeCodexTokenCountEnvelope(params: Map<String, JSONValue>?): Boolean {
        val p = params ?: return false
        val msg = p["msg"]?.objectValue ?: return false
        val eventType = msg["type"]?.stringValue?.trim()?.lowercase() ?: return false
        if (eventType != "token_count") return false
        handleLegacyTokenCountEvent(p, msg)
        return true
    }

    private fun tryConsumeCodexCommandExecutionEnvelope(params: Map<String, JSONValue>?): Boolean {
        val p = params ?: return false
        val msg = p["msg"]?.objectValue ?: p["event"]?.objectValue ?: return false
        val eventType = msg["type"]?.stringValue?.trim() ?: return false
        return when (eventType) {
            "exec_command_begin" -> {
                handleCommandExecutionState(eventType, p)
                true
            }
            "exec_command_output_delta" -> {
                handleCommandExecutionDelta(eventType, p)
                true
            }
            "exec_command_end" -> {
                handleCommandExecutionState(eventType, p)
                true
            }
            else -> false
        }
    }

    private fun tryConsumeCodexPlanEnvelope(params: Map<String, JSONValue>?): Boolean {
        val p = params ?: return false
        val msg = p["msg"]?.objectValue ?: p["event"]?.objectValue ?: return false
        val eventType =
            msg["type"]
                ?.stringValue
                ?.trim()
                ?.lowercase()
                ?.replace("_", "")
                ?.replace("-", "")
                ?: return false
        if (!eventType.contains("plan")) return false
        timelineEventRouter.handleTurnPlanUpdated(p)
        return true
    }

    private fun handleThreadTokenUsagePush(params: Map<String, JSONValue>?) {
        val p = params ?: return
        val threadId = IncomingNotificationParsers.extractThreadId(p) ?: return
        val usage = ContextWindowUsageCodec.decodeFromIncomingUsageParams(p) ?: return
        onThreadContextUsageLive(threadId.trim(), usage)
    }

    // Parses the `system/notice` envelope shape emitted by the bridge's opencode
    // translator (see agnt-bridge/src/providers/opencode/translate.js#handleToastShow):
    //   { severity, title, message, provider, threadId, durationMs }
    // Field-by-field nullable parsing keeps malformed envelopes from killing the
    // notification pipeline — the consumer rejects empty payloads anyway.
    private fun handleSystemNotice(params: Map<String, JSONValue>?) {
        val p = params ?: return
        val severity = p["severity"]?.stringValue
        val title = p["title"]?.stringValue
        val message = p["message"]?.stringValue
        if (title.isNullOrBlank() && message.isNullOrBlank()) return
        val provider = p["provider"]?.stringValue
        val threadId = p["threadId"]?.stringValue
        val durationMs = p["durationMs"]?.longValue ?: p["durationMs"]?.doubleValue?.toLong()
        onSystemNotice(severity, title, message, provider, threadId, durationMs)
    }

    private fun handleLegacyTokenCountEvent(
        paramsObject: Map<String, JSONValue>,
        payload: Map<String, JSONValue>,
    ) {
        val normalized =
            IncomingNotificationParsers.normalizedLegacyTokenCountParams(paramsObject, payload)
        val usage =
            ContextWindowUsageCodec.decodeFromLegacyTokenCountPayload(payload)
                ?: ContextWindowUsageCodec.decodeFromIncomingUsageParams(normalized)
                ?: return
        val turnHint = IncomingNotificationParsers.extractTurnId(normalized)
        val threadId =
            resolveThreadId(normalized)
                ?: IncomingNotificationParsers.extractThreadId(normalized)
                ?: resolveAmbiguousUsageThreadId()
                ?: return
        turnHint?.let { recordTurnThread(it, threadId) }
        onThreadContextUsageLive(threadId.trim(), usage)
    }

    fun dispatchServerRequest(
        method: String,
        requestId: JSONValue,
        params: JSONValue?,
        respond: (RPCMessage) -> Unit,
    ) = serverRequestRouter.dispatch(method, requestId, params, respond)

    private fun recordTurnThread(
        turnId: String?,
        threadId: String?,
    ) {
        val t = turnId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        val th = threadId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        threadIdByTurnId[t] = th
    }

    private fun markTurnActiveFromLiveEvent(
        threadId: String,
        turnId: String?,
    ) {
        val th = threadId.trim().takeIf { it.isNotEmpty() } ?: return
        val t = turnId?.trim()?.takeIf { it.isNotEmpty() }
        recordTurnThread(t, th)
        onTurnLifecycle(th, t)
    }

    private fun resolveThreadId(params: Map<String, JSONValue>?): String? {
        IncomingNotificationParsers.extractThreadId(params)?.let { return it }
        val turn = IncomingNotificationParsers.extractTurnId(params) ?: return null
        return threadIdByTurnId[turn]
    }

    private fun handleThreadStarted(params: Map<String, JSONValue>?) {
        val threadValue = params?.get("thread") ?: return
        val jo = jsonObjectFromJsonValue(threadValue) ?: return
        val thread = runCatching { CodexThread.fromJsonObject(jo) }.getOrNull() ?: return
        val merged = remapThreadFromServer(thread)
        threads.value = upsertIncomingThread(threads.value, merged)
        if (activeThreadId.value == null) {
            activeThreadId.value = merged.id
        }
        IncomingNotificationParsers.extractTurnId(params)?.let { recordTurnThread(it, merged.id) }
        onRequestThreadSync()
        scope.launch { onHydrateThread(merged.id) }
    }

    private fun handleThreadNameUpdated(params: Map<String, JSONValue>?) {
        if (params == null) return
        val threadId = extractIncomingThreadId(params) ?: return
        val event = envelopeEventObject(params)
        val renameKeys = listOf("threadName", "thread_name", "name", "title")
        val hasExplicitRenameField =
            hasAnyIncomingKey(params, renameKeys) || event?.let { hasAnyIncomingKey(it, renameKeys) } == true
        val name =
            firstIncomingString(params, renameKeys)
                ?: event?.let { firstIncomingString(it, renameKeys) }
        val localRename = CodexThread.normalizeIdentifier(persistedThreadRename(threadId))
        val list = threads.value
        val idx = list.indexOfFirst { it.id == threadId }
        if (localRename != null) {
            val next =
                if (idx >= 0) {
                    list.mapIndexed { i, t ->
                        if (i == idx) {
                            t.copy(title = localRename, name = localRename)
                        } else {
                            t
                        }
                    }
                } else {
                    list + CodexThread(id = threadId, title = localRename, name = localRename)
                }
            threads.value = sortIncomingThreadsForSidebar(next)
            return
        }
        val normalized = CodexThread.normalizeIdentifier(name)
        if (normalized == null) {
            if (hasExplicitRenameField && idx >= 0) {
                threads.value =
                    sortIncomingThreadsForSidebar(
                        list.mapIndexed { i, t ->
                            if (i == idx) {
                                t.copy(title = null, name = null)
                            } else {
                                t
                            }
                        },
                    )
                onRequestThreadSync()
            }
            return
        }
        val next =
            if (idx >= 0) {
                list.mapIndexed { i, t ->
                    if (i == idx) {
                        t.copy(title = normalized, name = normalized)
                    } else {
                        t
                    }
                }
            } else {
                list + CodexThread(id = threadId, title = normalized, name = normalized)
            }
        threads.value = sortIncomingThreadsForSidebar(next)
        onRequestThreadSync()
    }

    private fun handleTurnStarted(params: Map<String, JSONValue>?) {
        val p = params ?: return
        val threadId =
            resolveThreadId(p) ?: IncomingNotificationParsers.extractThreadId(p) ?: return
        val turnId = IncomingNotificationParsers.extractTurnIdForTurnLifecycleEvent(p)
        if (turnId != null) {
            recordTurnThread(turnId, threadId)
        }
        onTurnLifecycle(threadId, turnId)
        if (turnId != null) {
            scope.launch {
                messageTimeline.confirmLatestPendingUserMessage(threadId, turnId)
                messageTimeline.attachLatestTurnlessUserMessageToTurn(threadId, turnId)
                messageTimeline.ensureStreamingAssistantPlaceholder(threadId, turnId)
            }
        }
    }

    private fun handleTurnFailed(params: Map<String, JSONValue>?) {
        val p = params ?: return
        val threadId = resolveThreadId(p) ?: IncomingNotificationParsers.extractThreadId(p) ?: return
        onTurnFailed(threadId)
        timelineEventRouter.handleErrorNotification(p, markFailed = false)
    }

    private fun handleTurnCompleted(params: Map<String, JSONValue>?) {
        val p = params ?: return
        val threadId = resolveThreadId(p) ?: return
        val turnId = IncomingNotificationParsers.extractTurnIdForTurnLifecycleEvent(p)
        onTurnCompleted(threadId)
        if (turnId != null) {
            scope.launch {
                messageTimeline.confirmLatestPendingUserMessage(threadId, turnId)
            }
        }
        val msg =
            firstIncomingString(
                p,
                listOf("failureMessage", "failure_message", "errorMessage", "message"),
            )
        if (!msg.isNullOrEmpty()) {
            scope.launch {
                messageTimeline.appendSystemLine(threadId, turnId, "Turn: $msg")
            }
        }
        val failureMsg = TurnCompletionNotificationLogic.parseTurnFailureMessage(p)
        val terminal = TurnCompletionNotificationLogic.parseTurnTerminalState(p, failureMsg)
        val attention = TurnCompletionNotificationLogic.attentionKindFromTerminalState(terminal)
        if (attention != null) {
            onRunCompletionAttention(threadId, turnId, attention)
        }
    }

    private fun handleCommandExecutionState(
        method: String,
        params: Map<String, JSONValue>?,
    ) = commandExecutionRouter.handleState(method, params)

    private fun handleCommandExecutionDelta(
        method: String,
        params: Map<String, JSONValue>?,
    ) = commandExecutionRouter.handleDelta(method, params)
}
