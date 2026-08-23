package com.smeltery.agnt.mobile.services.agent

import com.smeltery.agnt.mobile.core.model.CodexAccessMode
import com.smeltery.agnt.mobile.core.model.SystemNoticeSeverity
import com.smeltery.agnt.mobile.data.IncomingEventRouter
import com.smeltery.agnt.mobile.services.agent.notifications.cancelRunOngoingNotification
import com.smeltery.agnt.mobile.services.agent.notifications.enqueuePendingApprovalRequest
import com.smeltery.agnt.mobile.services.agent.notifications.enqueuePendingStructuredInputRequest
import com.smeltery.agnt.mobile.services.agent.notifications.notifyRunCompletionAttention
import com.smeltery.agnt.mobile.services.agent.notifications.notifyRunStartedOngoing
import com.smeltery.agnt.mobile.services.agent.runtime.handleRateLimitsUpdatedParams
import com.smeltery.agnt.mobile.services.agent.runtime.refreshThreadsInternal
import com.smeltery.agnt.mobile.services.agent.threads.applyAuthoritativeProjectPathToServerThread
import com.smeltery.agnt.mobile.services.agent.threads.applyLiveContextWindowUsage
import com.smeltery.agnt.mobile.services.agent.threads.applyPersistedThreadRename
import com.smeltery.agnt.mobile.services.agent.threads.clearThreadGoalMirror
import com.smeltery.agnt.mobile.services.agent.threads.persistedThreadRename
import com.smeltery.agnt.mobile.services.agent.threads.syncThreadHistoryInternal
import com.smeltery.agnt.mobile.services.agent.threads.updateThreadGoalMirror
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

internal class AgentServiceIncomingCoordinator(
    private val service: AgentService,
) {
    val incomingRouter: IncomingEventRouter by lazy {
        IncomingEventRouter(
            scope = service.scope,
            threads = service._threads,
            activeThreadId = service._activeThreadId,
            messageTimeline = service.messageTimelineStore,
            commandDetailsStore = service.commandExecutionDetailsStore,
            onRequestThreadSync = {
                service.scope.launch {
                    if (service.sessionReady) {
                        runCatching { service.refreshThreadsInternal() }
                    }
                }
            },
            onHydrateThread = { tid ->
                service.scope.launch(Dispatchers.IO) {
                    if (service.sessionReady) {
                        runCatching { service.syncThreadHistoryInternal(tid, force = false) }
                    }
                }
            },
            onTurnLifecycle = { threadId, turnId ->
                service.notifyRunStartedOngoing(threadId, turnId)
                if (turnId != null) {
                    noteTurnStarted(threadId, turnId)
                } else {
                    noteProtectedRunningFallback(threadId, true)
                }
            },
            onTurnFinished = ::noteTurnFinished,
            onTurnCompleted = ::noteTurnCompleted,
            onTurnFailed = ::noteTurnFailed,
            isTurnStreamingActive = ::isTurnStreamingActive,
            shouldAutoApproveRequests = { service._selectedAccessMode.value == CodexAccessMode.fullAccess },
            onApprovalRequest = { request, respond ->
                service.enqueuePendingApprovalRequest(request, respond)
            },
            onStructuredInputRequest = { request, respond ->
                service.enqueuePendingStructuredInputRequest(request, respond)
            },
            onRateLimitsUpdated = { params -> service.handleRateLimitsUpdatedParams(params) },
            onThreadContextUsageLive = { threadId, usage -> service.applyLiveContextWindowUsage(threadId, usage) },
            onThreadGoalUpdated = { goal -> service.updateThreadGoalMirror(goal) },
            onThreadGoalCleared = { threadId -> service.clearThreadGoalMirror(threadId) },
            resolveAmbiguousUsageThreadId = ::resolveFallbackSingleThreadForUsage,
            remapThreadFromServer = { thread ->
                service.applyPersistedThreadRename(service.applyAuthoritativeProjectPathToServerThread(thread))
            },
            persistedThreadRename = { threadId -> service.persistedThreadRename(threadId) },
            onRunCompletionAttention = { threadId, turnId, kind ->
                service.notifyRunCompletionAttention(threadId, turnId, kind)
            },
            onSystemNotice = { severity, title, message, provider, threadId, durationMs ->
                service.systemNoticesStore.enqueue(
                    severity = SystemNoticeSeverity.fromBridgeValue(severity),
                    title = title,
                    message = message,
                    provider = provider,
                    threadId = threadId,
                    durationMsOverride = durationMs,
                )
            },
        )
    }

    fun noteProtectedRunningFallback(
        threadId: String,
        active: Boolean,
    ) {
        val normalizedThreadId = threadId.trim()
        if (normalizedThreadId.isEmpty()) return
        service._protectedRunningFallbackThreadIds.value =
            if (active) {
                clearThreadOutcome(normalizedThreadId)
                service._protectedRunningFallbackThreadIds.value + normalizedThreadId
            } else {
                service._protectedRunningFallbackThreadIds.value - normalizedThreadId
            }
    }

    fun noteTurnStarted(
        threadId: String,
        turnId: String,
    ) {
        val normalizedThreadId = threadId.trim()
        val normalizedTurnId = turnId.trim()
        if (normalizedThreadId.isEmpty() || normalizedTurnId.isEmpty()) return
        service._runningTurnIdByThread.value =
            service._runningTurnIdByThread.value + (normalizedThreadId to normalizedTurnId)
        service._protectedRunningFallbackThreadIds.value =
            service._protectedRunningFallbackThreadIds.value - normalizedThreadId
        clearThreadOutcome(normalizedThreadId)
    }

    fun noteTurnFinished(threadId: String) {
        val normalizedThreadId = threadId.trim()
        if (normalizedThreadId.isEmpty()) return
        service._runningTurnIdByThread.value =
            service._runningTurnIdByThread.value.filterKeys { it != normalizedThreadId }
        service._protectedRunningFallbackThreadIds.value =
            service._protectedRunningFallbackThreadIds.value - normalizedThreadId
        service.cancelRunOngoingNotification(normalizedThreadId)
    }

    fun noteTurnCompleted(threadId: String) {
        val normalizedThreadId = threadId.trim()
        if (normalizedThreadId.isEmpty()) return
        noteTurnFinished(normalizedThreadId)
        clearThreadOutcome(normalizedThreadId)
        if (service._activeThreadId.value == normalizedThreadId) return
        service._readyThreadIds.value = service._readyThreadIds.value + normalizedThreadId
        val title =
            service._threads.value
                .firstOrNull { it.id == normalizedThreadId }
                ?.displayTitle
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
        service._threadCompletionBannerThreadId.value = normalizedThreadId
        service._threadCompletionBannerTitle.value = title ?: "Chat"
    }

    fun noteTurnFailed(threadId: String) {
        val normalizedThreadId = threadId.trim()
        if (normalizedThreadId.isEmpty()) return
        noteTurnFinished(normalizedThreadId)
        clearThreadOutcome(normalizedThreadId)
        if (service._activeThreadId.value == normalizedThreadId) return
        service._failedThreadIds.value = service._failedThreadIds.value + normalizedThreadId
    }

    fun clearThreadOutcome(threadId: String) {
        val normalizedThreadId = threadId.trim()
        if (normalizedThreadId.isEmpty()) return
        service._readyThreadIds.value = service._readyThreadIds.value - normalizedThreadId
        service._failedThreadIds.value = service._failedThreadIds.value - normalizedThreadId
        if (service._threadCompletionBannerThreadId.value == normalizedThreadId) {
            service._threadCompletionBannerThreadId.value = null
            service._threadCompletionBannerTitle.value = null
        }
    }

    fun resolveFallbackSingleThreadForUsage(): String? {
        val running = service._runningTurnIdByThread.value.keys
        val fallback = service._protectedRunningFallbackThreadIds.value
        val candidates = running + fallback
        return candidates.singleOrNull()
    }

    private fun isTurnStreamingActive(
        threadId: String,
        turnId: String?,
    ): Boolean {
        val runningTurns = service._runningTurnIdByThread.value
        val fallbackThreads = service._protectedRunningFallbackThreadIds.value
        val activeTurnId = runningTurns[threadId]
        return when {
            turnId.isNullOrBlank() -> activeTurnId != null || fallbackThreads.contains(threadId)
            else -> activeTurnId == turnId || (activeTurnId == null && fallbackThreads.contains(threadId))
        }
    }
}
