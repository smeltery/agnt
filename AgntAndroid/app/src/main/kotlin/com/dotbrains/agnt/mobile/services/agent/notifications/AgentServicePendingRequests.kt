package com.dotbrains.agnt.mobile.services.agent.notifications

import com.dotbrains.agnt.mobile.core.error.AgentServiceError
import com.dotbrains.agnt.mobile.core.model.PendingApprovalDecision
import com.dotbrains.agnt.mobile.core.model.PendingApprovalRequest
import com.dotbrains.agnt.mobile.core.model.PendingStructuredInputRequest
import com.dotbrains.agnt.mobile.services.agent.AgentService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal fun AgentService.enqueuePendingApprovalRequest(
    request: PendingApprovalRequest,
    responder: (PendingApprovalDecision) -> Unit,
) {
    pendingApprovalResponders[request.id] = responder
    _pendingApprovalRequest.value = request
    notifyPendingApprovalAttention(request)
}

internal fun AgentService.enqueuePendingStructuredInputRequest(
    request: PendingStructuredInputRequest,
    responder: (answersByQuestionId: Map<String, List<String>>) -> Unit,
) {
    pendingStructuredInputResponders[request.id] = responder
    _pendingStructuredInputRequest.value = request
    notifyStructuredInputAttention(request)
}

suspend fun AgentService.resolvePendingApprovalForRepository(
    requestId: String,
    decision: PendingApprovalDecision,
) = withContext(Dispatchers.IO) {
    val id = requestId.trim()
    val responder = pendingApprovalResponders.remove(id) ?: throw AgentServiceError.NoPendingApproval
    if (_pendingApprovalRequest.value?.id == id) {
        _pendingApprovalRequest.value = null
    }
    messageTimelineStore.removeEphemeralPendingServerMarker(id)
    responder(decision)
}

suspend fun AgentService.resolvePendingStructuredInputForRepository(
    requestId: String,
    answersByQuestionId: Map<String, List<String>>,
) = withContext(Dispatchers.IO) {
    val id = requestId.trim()
    val responder =
        pendingStructuredInputResponders.remove(id) ?: throw AgentServiceError.NoPendingApproval
    if (_pendingStructuredInputRequest.value?.id == id) {
        _pendingStructuredInputRequest.value = null
    }
    messageTimelineStore.removeEphemeralPendingServerMarker(id)
    responder(answersByQuestionId)
}

internal fun AgentService.clearPendingServerRequests() {
    pendingApprovalResponders.clear()
    pendingStructuredInputResponders.clear()
    _pendingApprovalRequest.value = null
    _pendingStructuredInputRequest.value = null
}
