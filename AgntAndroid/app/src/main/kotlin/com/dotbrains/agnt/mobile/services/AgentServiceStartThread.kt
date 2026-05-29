package com.dotbrains.agnt.mobile.services

import com.dotbrains.agnt.mobile.core.error.AgentServiceError
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.RPCMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Mirrors [AgentService.startThreadImpl] in
 * [AgentService+ThreadsTurns.swift](../../../../../../../../CodexMobile/CodexMobile/Services/AgentService+ThreadsTurns.swift).
 */
internal suspend fun AgentService.startThreadInternal(
    model: String? = null,
    cwd: String? = null,
    serviceTier: String? = null,
): CodexThread {
    if (!sessionReady) throw AgentServiceError.Disconnected
    val normalizedCwd = CodexThread.normalizeProjectPath(cwd?.trim()?.takeIf { it.isNotEmpty() })
    val resolvedModel =
        model?.trim()?.takeIf { it.isNotEmpty() }
            ?: selectedModelOption()?.model?.trim()?.takeIf { it.isNotEmpty() }
    val resolvedServiceTier =
        serviceTier?.trim()?.takeIf { it.isNotEmpty() }
            ?: _selectedServiceTier.value?.name
    var includesServiceTier = shouldWireServiceTier(supportsServiceTier, resolvedServiceTier != null)
    var threadStartRpc: RPCMessage? = null
    while (true) {
        val params =
            buildMap {
                resolvedModel?.let { put("model", JSONValue.Str(it)) }
                normalizedCwd?.let { put("cwd", JSONValue.Str(it)) }
                if (includesServiceTier) {
                    resolvedServiceTier?.let { put("serviceTier", JSONValue.Str(it)) }
                }
            }
        val payload =
            if (params.isEmpty()) JSONValue.Obj(emptyMap()) else JSONValue.Obj(params)
        try {
            threadStartRpc = sendRequestWithSandboxAndApprovalFallback("thread/start", payload)
            break
        } catch (e: Throwable) {
            if (includesServiceTier && shouldRetryTurnStartWithoutServiceTier(e)) {
                markServiceTierUnsupportedForCurrentBridge()
                includesServiceTier = false
                continue
            }
            throw e
        }
    }
    val result =
        threadStartRpc?.result ?: throw AgentServiceError.InvalidResponse("thread/start missing result")
    val resultObj = result as? JSONValue.Obj ?: throw AgentServiceError.InvalidResponse("thread/start result not object")
    val threadEl =
        resultObj.map["thread"] as? JSONValue.Obj
            ?: throw AgentServiceError.InvalidResponse("thread/start response missing thread")
    val decoded =
        runCatching {
            CodexThread.fromJsonObject(jsonObjectFromRpc(threadEl))
        }.getOrElse {
            throw AgentServiceError.InvalidResponse("thread/start thread decode failed")
        }
    val patched = applyRequestedProjectPathForNewThread(decoded, normalizedCwd)
    normalizedCwd?.let { cwd ->
        beginAuthoritativeProjectPathTransition(patched.id, cwd)
        rememberAssociatedManagedWorktreePathIfWorktree(cwd, patched.id)
    }
    return runNewThreadOpenFlow(
        thread = patched,
        normalizedCwd = normalizedCwd,
        sink =
            AgentServiceNewThreadOpenSink(
                service = this,
            ),
    )
}

internal interface NewThreadOpenFlowSink {
    suspend fun publishStartedThread(thread: CodexThread)

    suspend fun forceResumeStartedThread(
        thread: CodexThread,
        normalizedCwd: String?,
    ): CodexThread?

    suspend fun syncStartedThreadHistory(threadId: String)

    fun activateStartedThread(threadId: String)
}

internal suspend fun runNewThreadOpenFlow(
    thread: CodexThread,
    normalizedCwd: String?,
    sink: NewThreadOpenFlowSink,
): CodexThread {
    sink.publishStartedThread(thread)
    val resumed =
        try {
            sink.forceResumeStartedThread(
                thread = thread,
                normalizedCwd = normalizedCwd,
            ) ?: thread
        } catch (e: Exception) {
            if (!shouldAllowProjectRebindWithoutResume(e)) throw e
            thread
        }
    runCatching { sink.syncStartedThreadHistory(thread.id) }
    sink.activateStartedThread(thread.id)
    return resumed
}

private class AgentServiceNewThreadOpenSink(
    private val service: AgentService,
) : NewThreadOpenFlowSink {
    override suspend fun publishStartedThread(thread: CodexThread) {
        service.publishThreads(upsertThreadRow(service._threads.value, thread))
    }

    override suspend fun forceResumeStartedThread(
        thread: CodexThread,
        normalizedCwd: String?,
    ): CodexThread? =
        service.ensureThreadResumedInternal(
            threadId = thread.id,
            force = true,
            preferredProjectPath = normalizedCwd,
            modelIdentifierOverride = thread.model,
        )

    override suspend fun syncStartedThreadHistory(threadId: String) {
        service.syncThreadHistoryInternal(threadId, force = true)
    }

    override fun activateStartedThread(threadId: String) {
        service._activeThreadId.value = threadId
        service.sessionPersistence.saveLastActiveThreadId(threadId)
    }
}

internal fun applyRequestedProjectPathForNewThread(
    thread: CodexThread,
    requested: String?,
): CodexThread {
    val preferred = CodexThread.normalizeProjectPath(requested) ?: return thread
    if (thread.normalizedProjectPath == preferred) return thread
    return thread.copy(cwd = preferred)
}

suspend fun AgentService.startThreadForRepository(
    model: String?,
    cwd: String?,
    serviceTier: String?,
): CodexThread =
    withContext(Dispatchers.IO) {
        startThreadInternal(model, cwd, serviceTier)
    }
