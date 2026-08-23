package com.smeltery.agnt.mobile.data

import com.smeltery.agnt.mobile.core.model.JSONValue
import com.smeltery.agnt.mobile.core.model.PendingApprovalDecision
import com.smeltery.agnt.mobile.core.model.PendingApprovalRequest
import com.smeltery.agnt.mobile.core.model.PendingStructuredInputRequest
import com.smeltery.agnt.mobile.core.model.RPCError
import com.smeltery.agnt.mobile.core.model.RPCMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

internal class IncomingServerRequestRouter(
    private val scope: CoroutineScope,
    private val messageTimeline: MessageTimelineStore,
    private val shouldAutoApproveRequests: () -> Boolean,
    private val onApprovalRequest: (PendingApprovalRequest, (PendingApprovalDecision) -> Unit) -> Unit,
    private val onStructuredInputRequest: (
        PendingStructuredInputRequest,
        (answersByQuestionId: Map<String, List<String>>) -> Unit,
    ) -> Unit,
    private val resolveThreadId: (Map<String, JSONValue>?) -> String?,
) {
    fun dispatch(
        method: String,
        requestId: JSONValue,
        params: JSONValue?,
        respond: (RPCMessage) -> Unit,
    ) {
        val m = method.trim()
        scope.launch(Dispatchers.IO) {
            val normalizedMethod = normalizeIncomingMethod(m)
            when (serverRequestKind(m, normalizedMethod)) {
                ServerRequestKind.StructuredInput -> {
                    val request = buildStructuredInputRequest(requestId, params)
                    appendStructuredInputTimelineMarker(request)
                    onStructuredInputRequest(request) { answers ->
                        respond(
                            RPCMessage.success(
                                id = requestId,
                                result = structuredUserInputResult(answers),
                                includeJsonRpc = false,
                            ),
                        )
                    }
                }
                ServerRequestKind.Approval -> {
                    if (shouldAutoApproveRequests()) {
                        respond(
                            RPCMessage.success(
                                id = requestId,
                                result = approvalDecisionResult("accept"),
                                includeJsonRpc = false,
                            ),
                        )
                        return@launch
                    }
                    val paramsObject = params?.objectValue
                    val request = buildApprovalRequest(m, requestId, paramsObject, resolveThreadId(paramsObject))
                    appendPendingApprovalTimelineMarker(request)
                    onApprovalRequest(request) { decision ->
                        val rpc =
                            when (decision) {
                                PendingApprovalDecision.Decline -> "decline"
                                PendingApprovalDecision.Accept -> "accept"
                                PendingApprovalDecision.AcceptForSession -> "acceptForSession"
                            }
                        respond(
                            RPCMessage.success(
                                id = requestId,
                                result = approvalDecisionResult(rpc),
                                includeJsonRpc = false,
                            ),
                        )
                    }
                }
                ServerRequestKind.Unsupported -> {
                    respond(
                        RPCMessage.failure(
                            id = requestId,
                            error =
                                RPCError(
                                    code = -32601,
                                    message = "Unsupported request method: $m",
                                ),
                            includeJsonRpc = false,
                        ),
                    )
                }
            }
        }
    }

    private suspend fun appendStructuredInputTimelineMarker(request: PendingStructuredInputRequest) {
        val threadId = request.threadId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        messageTimeline.appendStructuredInputPromptMarker(
            threadId = threadId,
            turnId = request.turnId?.trim()?.takeIf { it.isNotEmpty() },
            messageId = request.id,
            bodyText = StructuredInputTimelineFormatter.bodyText(request.questions),
        )
    }

    private suspend fun appendPendingApprovalTimelineMarker(request: PendingApprovalRequest) {
        val threadId = request.threadId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        messageTimeline.appendPendingApprovalMarker(
            threadId = threadId,
            turnId = request.turnId?.trim()?.takeIf { it.isNotEmpty() },
            itemId = request.itemId?.trim()?.takeIf { it.isNotEmpty() },
            messageId = request.id,
            bodyText =
                PendingApprovalTimelineFormatter.bodyText(
                    request.method,
                    request.command,
                    request.reason,
                ),
        )
    }

    private fun buildStructuredInputRequest(
        requestId: JSONValue,
        params: JSONValue?,
    ): PendingStructuredInputRequest =
        params
            ?.objectValue
            .let { obj -> buildStructuredInputRequest(requestId, obj, resolveThreadId(obj)) }
}
