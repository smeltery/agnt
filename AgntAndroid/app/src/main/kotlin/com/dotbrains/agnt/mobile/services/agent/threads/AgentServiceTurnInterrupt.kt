package com.dotbrains.agnt.mobile.services.agent.threads

import com.dotbrains.agnt.mobile.core.error.AgentServiceError
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.data.ThreadTurnInterruptSnapshot
import com.dotbrains.agnt.mobile.data.ThreadTurnSnapshot
import com.dotbrains.agnt.mobile.services.agent.AgentService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

internal suspend fun AgentService.interruptTurnInternal(
    threadId: String,
    hintTurnId: String?,
) {
    if (!sessionReady) throw AgentServiceError.Disconnected
    val tid = threadId.trim()
    if (tid.isEmpty()) throw AgentServiceError.InvalidInput("Missing thread id")

    var turnId =
        hintTurnId?.trim()?.takeIf { it.isNotEmpty() }
            ?: _runningTurnIdByThread.value[tid]
    if (turnId == null) {
        val snap = resolveInFlightTurnSnapshotForInterrupt(tid)
        turnId = snap.interruptibleTurnId
        if (turnId == null) {
            if (snap.hasInterruptibleTurnWithoutId) {
                throw AgentServiceError.InvalidInput(
                    "The active run has not published an interruptible turn ID yet. Please try again in a moment.",
                )
            }
            throw AgentServiceError.InvalidInput("No active turn to interrupt")
        }
    }

    val resolvedTurnId = turnId
    try {
        sendInterruptRpc(resolvedTurnId, tid, snakeCase = false)
        return
    } catch (e: AgentServiceError.RpcFailure) {
        if (shouldRetryInterruptSnakeCase(e)) {
            try {
                sendInterruptRpc(resolvedTurnId, tid, snakeCase = true)
                return
            } catch (e2: AgentServiceError.RpcFailure) {
                if (shouldRetryInterruptRefreshTurn(e2)) {
                    tryRefreshAndInterrupt(tid, resolvedTurnId)
                    return
                }
                throw e2
            }
        }
        if (shouldRetryInterruptRefreshTurn(e)) {
            tryRefreshAndInterrupt(tid, resolvedTurnId)
            return
        }
        throw e
    }
}

private suspend fun AgentService.tryRefreshAndInterrupt(
    threadId: String,
    previousTurnId: String,
) {
    val snap = fetchThreadTurnInterruptSnapshotImpl(threadId)
    val refreshed =
        snap.interruptibleTurnId?.takeIf { it != previousTurnId }
            ?: throw AgentServiceError.InvalidInput("Could not resolve an interruptible turn id")
    try {
        sendInterruptRpc(refreshed, threadId, snakeCase = false)
    } catch (e: AgentServiceError.RpcFailure) {
        if (shouldRetryInterruptSnakeCase(e)) {
            sendInterruptRpc(refreshed, threadId, snakeCase = true)
        } else {
            throw e
        }
    }
    noteTurnStarted(threadId, refreshed)
}

private suspend fun AgentService.resolveInFlightTurnSnapshotForInterrupt(threadId: String): ThreadTurnInterruptSnapshot {
    val maxAttempts = 3
    var latest = fetchThreadTurnInterruptSnapshotImpl(threadId)
    repeat(maxAttempts - 1) {
        if (latest.interruptibleTurnId != null || !latest.hasInterruptibleTurnWithoutId) {
            return latest
        }
        delay(200)
        latest = fetchThreadTurnInterruptSnapshotImpl(threadId)
    }
    return latest
}

private suspend fun AgentService.sendInterruptRpc(
    turnId: String,
    threadId: String,
    snakeCase: Boolean,
) {
    val params =
        if (snakeCase) {
            mapOf(
                "turn_id" to JSONValue.Str(turnId),
                "thread_id" to JSONValue.Str(threadId),
            )
        } else {
            mapOf(
                "turnId" to JSONValue.Str(turnId),
                "threadId" to JSONValue.Str(threadId),
            )
        }
    sendRequestImpl("turn/interrupt", JSONValue.Obj(params))
}

internal suspend fun AgentService.fetchThreadTurnInterruptSnapshotImpl(threadId: String): ThreadTurnInterruptSnapshot {
    val camel =
        JSONValue.Obj(
            mapOf(
                "threadId" to JSONValue.Str(threadId),
                "includeTurns" to JSONValue.Bool(true),
            ),
        )
    val response =
        try {
            sendRequestImpl("thread/read", camel)
        } catch (e: AgentServiceError.RpcFailure) {
            if (shouldRetryThreadReadSnakeCase(e)) {
                sendRequestImpl(
                    "thread/read",
                    JSONValue.Obj(
                        mapOf(
                            "thread_id" to JSONValue.Str(threadId),
                            "include_turns" to JSONValue.Bool(true),
                        ),
                    ),
                )
            } else {
                throw e
            }
        }
    val threadEl = (response.result as? JSONValue.Obj)?.map?.get("thread") as? JSONValue.Obj
    return ThreadTurnSnapshot.fromThreadObject(threadEl?.map ?: emptyMap())
}

private fun shouldRetryThreadReadSnakeCase(e: AgentServiceError.RpcFailure): Boolean {
    val c = e.rpcError.code
    if (c != -32600 && c != -32602) return false
    val m = e.rpcError.message.lowercase()
    val hints =
        listOf("threadid", "includeturns", "thread_id", "include_turns", "unknown field", "missing field", "invalid")
    return hints.any { m.contains(it) }
}

private fun shouldRetryInterruptSnakeCase(e: AgentServiceError.RpcFailure): Boolean {
    val c = e.rpcError.code
    if (c != -32600 && c != -32602) return false
    val m = e.rpcError.message.lowercase()
    val hints = listOf("turnid", "threadid", "turn_id", "thread_id", "unknown field", "missing field", "invalid")
    return hints.any { m.contains(it) }
}

private fun shouldRetryInterruptRefreshTurn(e: AgentServiceError.RpcFailure): Boolean {
    val m = e.rpcError.message.lowercase()
    val hints =
        listOf(
            "turn not found",
            "no active turn",
            "not in progress",
            "not running",
            "already completed",
            "already finished",
            "invalid turn",
            "no such turn",
            "not active",
            "does not exist",
            "cannot interrupt",
        )
    return hints.any { m.contains(it) }
}

suspend fun AgentService.interruptTurnForRepository(
    threadId: String,
    turnId: String?,
) = withContext(Dispatchers.IO) {
    interruptTurnInternal(threadId, turnId)
}
