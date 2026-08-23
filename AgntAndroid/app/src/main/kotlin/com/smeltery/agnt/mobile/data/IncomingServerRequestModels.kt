package com.smeltery.agnt.mobile.data

import com.smeltery.agnt.mobile.core.model.JSONValue
import com.smeltery.agnt.mobile.core.model.PendingApprovalRequest
import com.smeltery.agnt.mobile.core.model.PendingStructuredInputRequest

internal enum class ServerRequestKind {
    StructuredInput,
    Approval,
    Unsupported,
}

internal fun serverRequestKind(
    method: String,
    normalizedMethod: String,
): ServerRequestKind =
    when {
        isStructuredInputServerRequestMethod(method) -> ServerRequestKind.StructuredInput
        isApprovalServerRequestMethod(normalizedMethod) -> ServerRequestKind.Approval
        else -> ServerRequestKind.Unsupported
    }

internal fun approvalDecisionResult(decision: String): JSONValue = JSONValue.Obj(mapOf("decision" to JSONValue.Str(decision)))

internal fun structuredUserInputResult(answersByQuestionId: Map<String, List<String>>): JSONValue =
    JSONValue.Obj(
        mapOf(
            "answers" to
                JSONValue.Obj(
                    answersByQuestionId.mapValues { (_, answers) ->
                        JSONValue.Obj(
                            mapOf(
                                "answers" to
                                    JSONValue.Arr(
                                        answers
                                            .map { it.trim() }
                                            .filter { it.isNotEmpty() }
                                            .map { JSONValue.Str(it) },
                                    ),
                            ),
                        )
                    },
                ),
        ),
    )

internal fun buildApprovalRequest(
    method: String,
    requestId: JSONValue,
    params: Map<String, JSONValue>?,
    resolvedThreadId: String?,
): PendingApprovalRequest =
    PendingApprovalRequest(
        id = requestKey(requestId),
        method = method,
        threadId = resolvedThreadId,
        turnId = IncomingNotificationParsers.extractTurnId(params),
        itemId = IncomingNotificationParsers.extractItemId(params),
        command = params?.get("command")?.stringValue,
        reason = params?.get("reason")?.stringValue,
    )

internal fun buildStructuredInputRequest(
    requestId: JSONValue,
    params: Map<String, JSONValue>?,
    resolvedThreadId: String?,
): PendingStructuredInputRequest =
    PendingStructuredInputRequest(
        id = requestKey(requestId),
        threadId = resolvedThreadId,
        turnId = IncomingNotificationParsers.extractTurnId(params),
        questions = parseStructuredInputQuestions(params),
    )

internal fun requestKey(requestId: JSONValue): String = JSONValue.toJsonElement(requestId).toString()
