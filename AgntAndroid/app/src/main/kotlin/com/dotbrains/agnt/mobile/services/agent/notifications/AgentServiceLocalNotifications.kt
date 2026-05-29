package com.dotbrains.agnt.mobile.services.agent.notifications

import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.PendingApprovalRequest
import com.dotbrains.agnt.mobile.core.model.PendingStructuredInputRequest
import com.dotbrains.agnt.mobile.core.notification.RunCompletionAttentionKind
import com.dotbrains.agnt.mobile.services.agent.AgentService

private fun AgentService.threadDisplayTitleForNotification(threadId: String): String {
    val tid = threadId.trim()
    if (tid.isEmpty()) return appContext.getString(R.string.notification_default_thread_title)
    return _threads.value
        .firstOrNull { it.id == tid }
        ?.displayTitle
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?: appContext.getString(R.string.notification_default_thread_title)
}

internal fun AgentService.notifyRunCompletionAttention(
    threadId: String,
    turnId: String?,
    kind: RunCompletionAttentionKind,
) {
    localNotificationPresenter.maybeNotifyRunCompletion(
        threadId = threadId,
        turnId = turnId,
        kind = kind,
        displayTitle = threadDisplayTitleForNotification(threadId),
    )
}

internal fun AgentService.notifyPendingApprovalAttention(request: PendingApprovalRequest) {
    val th = request.threadId?.trim()?.takeIf { it.isNotEmpty() } ?: return
    localNotificationPresenter.maybeNotifyPendingApproval(
        request = request,
        displayTitle = threadDisplayTitleForNotification(th),
    )
}

internal fun AgentService.notifyStructuredInputAttention(request: PendingStructuredInputRequest) {
    val th = request.threadId?.trim()?.takeIf { it.isNotEmpty() } ?: return
    localNotificationPresenter.maybeNotifyStructuredInput(
        request = request,
        displayTitle = threadDisplayTitleForNotification(th),
    )
}
