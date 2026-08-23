package com.smeltery.agnt.mobile.services.agent.threads

import com.smeltery.agnt.mobile.core.error.AgentServiceError
import com.smeltery.agnt.mobile.core.model.CodexThreadGoal
import com.smeltery.agnt.mobile.core.model.CodexThreadGoalBudgetUpdate
import com.smeltery.agnt.mobile.core.model.CodexThreadGoalStatus
import com.smeltery.agnt.mobile.core.model.JSONValue
import com.smeltery.agnt.mobile.services.agent.AgentService

internal suspend fun AgentService.setThreadGoalInternal(
    threadId: String,
    objective: String?,
    status: CodexThreadGoalStatus?,
    tokenBudget: CodexThreadGoalBudgetUpdate,
): CodexThreadGoal {
    val tid = threadId.trim()
    require(tid.isNotEmpty()) { "Thread id is required." }
    val params = linkedMapOf<String, JSONValue>("threadId" to JSONValue.Str(tid))
    objective?.trim()?.takeIf { it.isNotEmpty() }?.let { params["objective"] = JSONValue.Str(it) }
    status?.let { params["status"] = JSONValue.Str(it.wireValue) }
    when (tokenBudget) {
        CodexThreadGoalBudgetUpdate.Keep -> Unit
        CodexThreadGoalBudgetUpdate.Clear -> params["tokenBudget"] = JSONValue.Null
        is CodexThreadGoalBudgetUpdate.Set -> {
            require(tokenBudget.tokens > 0) { "Token budget must be positive." }
            params["tokenBudget"] = JSONValue.NumLong(tokenBudget.tokens)
        }
    }
    val response = sendRequestImpl("thread/goal/set", JSONValue.Obj(params))
    val goal =
        CodexThreadGoal.fromEnvelope(response.result?.objectValue, fallbackThreadId = tid)
            ?: throw IllegalStateException("Invalid thread goal response.")
    updateThreadGoalMirror(goal)
    return goal
}

internal suspend fun AgentService.readThreadGoalInternal(threadId: String): CodexThreadGoal? {
    val tid = threadId.trim()
    if (tid.isEmpty()) return null
    val response = sendRequestImpl("thread/goal/get", JSONValue.Obj(mapOf("threadId" to JSONValue.Str(tid))))
    val goal = CodexThreadGoal.fromEnvelope(response.result?.objectValue, fallbackThreadId = tid)
    if (goal != null) updateThreadGoalMirror(goal) else clearThreadGoalMirror(tid)
    return goal
}

internal suspend fun AgentService.clearThreadGoalInternal(threadId: String): Boolean {
    val tid = threadId.trim()
    if (tid.isEmpty()) return false
    val response = sendRequestImpl("thread/goal/clear", JSONValue.Obj(mapOf("threadId" to JSONValue.Str(tid))))
    clearThreadGoalMirror(tid)
    return response.result
        ?.objectValue
        ?.get("cleared")
        ?.boolValue ?: true
}

internal fun AgentService.updateThreadGoalMirror(goal: CodexThreadGoal) {
    _threadGoalsByThread.value = _threadGoalsByThread.value + (goal.threadId to goal)
}

internal fun AgentService.clearThreadGoalMirror(threadId: String) {
    val tid = threadId.trim()
    if (tid.isEmpty()) return
    _threadGoalsByThread.value = _threadGoalsByThread.value - tid
}

internal fun isThreadGoalsUnsupported(error: Throwable): Boolean {
    val rpc = (error as? AgentServiceError.RpcFailure)?.rpcError
    if (rpc?.code == -32601 || rpc?.code == -32004) return true
    val message = (rpc?.message ?: error.message).orEmpty().lowercase()
    return message.contains("method not found") ||
        message.contains("unknown method") ||
        message.contains("goals feature is disabled") ||
        message.contains("does not support goals") ||
        message.contains("thread goals require")
}
