package com.smeltery.agnt.mobile.data

import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.core.model.CodexThreadGoal
import com.smeltery.agnt.mobile.core.model.ContextWindowUsage
import com.smeltery.agnt.mobile.core.model.JSONValue
import com.smeltery.agnt.mobile.core.model.PendingApprovalDecision
import com.smeltery.agnt.mobile.core.model.PendingApprovalRequest
import com.smeltery.agnt.mobile.core.model.PendingStructuredInputRequest
import com.smeltery.agnt.mobile.core.model.RPCMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withTimeout

internal const val ROUTER_TEST_TIMEOUT_MS = 5_000L

internal suspend fun routerResponseFor(
    method: String,
    requestId: JSONValue,
    shouldAutoApproveRequests: Boolean = false,
): RPCMessage {
    val response = CompletableDeferred<RPCMessage>()
    newRouter(
        shouldAutoApproveRequests = { shouldAutoApproveRequests },
    ).dispatchServerRequest(
        method = method,
        requestId = requestId,
        params = null,
        respond = { response.complete(it) },
    )
    return withTimeout(ROUTER_TEST_TIMEOUT_MS) { response.await() }
}

internal fun newRouter(
    threads: MutableStateFlow<List<CodexThread>> = MutableStateFlow(emptyList()),
    messageTimeline: MessageTimelineStore = MessageTimelineStore(),
    shouldAutoApproveRequests: () -> Boolean = { false },
    onApprovalRequest: (PendingApprovalRequest, (PendingApprovalDecision) -> Unit) -> Unit = { _, _ -> },
    onStructuredInputRequest: (
        PendingStructuredInputRequest,
        (answersByQuestionId: Map<String, List<String>>) -> Unit,
    ) -> Unit = { _, _ -> },
    onRateLimitsUpdated: (Map<String, JSONValue>?) -> Unit = { _ -> },
    onThreadContextUsageLive: (String, ContextWindowUsage) -> Unit = { _, _ -> },
    onThreadGoalUpdated: (CodexThreadGoal) -> Unit = { _ -> },
    onThreadGoalCleared: (String) -> Unit = { _ -> },
    resolveAmbiguousUsageThreadId: () -> String? = { null },
    persistedThreadRename: (String) -> String? = { null },
    onSystemNotice: (
        severity: String?,
        title: String?,
        message: String?,
        provider: String?,
        threadId: String?,
        durationMs: Long?,
    ) -> Unit = { _, _, _, _, _, _ -> },
): IncomingEventRouter =
    IncomingEventRouter(
        scope = CoroutineScope(Dispatchers.Unconfined),
        threads = threads,
        activeThreadId = MutableStateFlow(null),
        messageTimeline = messageTimeline,
        onRequestThreadSync = {},
        onHydrateThread = {},
        onTurnLifecycle = { _, _ -> },
        onTurnFinished = {},
        isTurnStreamingActive = { _, _ -> false },
        shouldAutoApproveRequests = shouldAutoApproveRequests,
        onApprovalRequest = onApprovalRequest,
        onStructuredInputRequest = onStructuredInputRequest,
        onRateLimitsUpdated = onRateLimitsUpdated,
        onThreadContextUsageLive = onThreadContextUsageLive,
        onThreadGoalUpdated = onThreadGoalUpdated,
        onThreadGoalCleared = onThreadGoalCleared,
        resolveAmbiguousUsageThreadId = resolveAmbiguousUsageThreadId,
        persistedThreadRename = persistedThreadRename,
        onSystemNotice = onSystemNotice,
    )
