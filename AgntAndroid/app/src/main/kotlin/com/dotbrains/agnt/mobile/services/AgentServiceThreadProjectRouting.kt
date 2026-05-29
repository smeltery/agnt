package com.dotbrains.agnt.mobile.services

import com.dotbrains.agnt.mobile.core.error.AgentServiceError
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.projectIconSystemNameFor
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Same-thread project path rebind and authoritative cwd guards. Parity:
 * [AgentService+ThreadProjectRouting.swift](../../../../../CodexMobile/CodexMobile/Services/AgentService+ThreadProjectRouting.swift).
 */
internal fun applyAuthoritativeProjectPathMerge(
    thread: CodexThread,
    authoritativeByThreadId: MutableMap<String, String>,
    treatAsServerState: Boolean,
): CodexThread {
    val tid = thread.id.trim()
    if (tid.isEmpty()) return thread
    val authRaw = authoritativeByThreadId[tid] ?: return thread
    val auth = CodexThread.normalizeProjectPath(authRaw) ?: return thread
    val threadPath = thread.normalizedProjectPath
    if (threadPath == auth) {
        if (treatAsServerState) {
            authoritativeByThreadId.remove(tid)
        }
        return thread
    }
    return thread.copy(cwd = auth)
}

internal fun confirmAuthoritativeProjectPathIfNeeded(
    threadId: String,
    observedProjectPath: String?,
    authoritativeByThreadId: MutableMap<String, String>,
) {
    val tid = threadId.trim()
    if (tid.isEmpty()) return
    if (authoritativeByThreadId[tid] == null) return
    val expected = CodexThread.normalizeProjectPath(authoritativeByThreadId[tid]) ?: return
    val observed = CodexThread.normalizeProjectPath(observedProjectPath) ?: return
    if (observed == expected) {
        authoritativeByThreadId.remove(tid)
    }
}

internal fun shouldAllowProjectRebindWithoutResume(error: Throwable): Boolean {
    val message: String? =
        when (error) {
            is AgentServiceError.RpcFailure -> error.rpcError.message.lowercase()
            is AgentServiceError -> error.toString().lowercase()
            else -> (error.message ?: error.toString()).lowercase()
        }
    if (message == null) return false
    return message.contains("no rollout found") ||
        message.contains("no rollout file found") ||
        (message.contains("rollout") && message.contains("is empty"))
}

internal fun AgentService.applyAuthoritativeProjectPathToServerThread(thread: CodexThread) =
    applyAuthoritativeProjectPathMerge(thread, authoritativeProjectPathByThreadId, treatAsServerState = true)

internal fun AgentService.beginAuthoritativeProjectPathTransition(
    threadId: String,
    projectPath: String,
) {
    val tid = threadId.trim()
    if (tid.isEmpty()) return
    val p = CodexThread.normalizeProjectPath(projectPath) ?: return
    authoritativeProjectPathByThreadId[tid] = p
}

internal fun AgentService.currentAuthoritativeProjectPathForImpl(threadId: String): String? {
    val tid = threadId.trim()
    if (tid.isEmpty()) return null
    return CodexThread.normalizeProjectPath(authoritativeProjectPathByThreadId[tid])
}

internal fun AgentService.associatedManagedWorktreePathForImpl(threadId: String): String? {
    val tid = threadId.trim()
    if (tid.isEmpty()) return null
    return CodexThread.normalizeProjectPath(associatedManagedWorktreePathByThreadId[tid])
}

internal fun AgentService.rememberAssociatedManagedWorktreePathIfWorktree(
    projectPath: String,
    forThreadId: String,
) {
    val tid = forThreadId.trim()
    if (tid.isEmpty()) return
    val norm = CodexThread.normalizeProjectPath(projectPath) ?: return
    if (projectIconSystemNameFor(norm) == "arrow.triangle.branch") {
        associatedManagedWorktreePathByThreadId[tid] = norm
        sessionPersistence.saveAssociatedManagedWorktreePath(tid, norm)
    }
}

private fun AgentService.restoreAssociatedManagedWorktreePath(
    path: String?,
    forThreadId: String,
) {
    val tid = forThreadId.trim()
    if (tid.isEmpty()) return
    if (path == null) {
        associatedManagedWorktreePathByThreadId.remove(tid)
        sessionPersistence.removeAssociatedManagedWorktreePath(tid)
    } else {
        val n = CodexThread.normalizeProjectPath(path)
        if (n == null) {
            associatedManagedWorktreePathByThreadId.remove(tid)
            sessionPersistence.removeAssociatedManagedWorktreePath(tid)
        } else {
            associatedManagedWorktreePathByThreadId[tid] = n
            sessionPersistence.saveAssociatedManagedWorktreePath(tid, n)
        }
    }
}

internal fun AgentService.requestImmediateThreadListSync() {
    scope.launch(Dispatchers.IO) {
        if (sessionReady) {
            runCatching { refreshThreadsInternal() }
        }
    }
}

internal suspend fun AgentService.moveThreadToProjectPathImpl(
    threadId: String,
    projectPath: String,
): CodexThread {
    if (!sessionReady) throw AgentServiceError.Disconnected
    val normalizedThreadId = threadId.trim()
    if (normalizedThreadId.isEmpty()) {
        throw AgentServiceError.InvalidInput("Thread id is required.")
    }
    val normalizedProjectPath = CodexThread.normalizeProjectPath(projectPath)
        ?: throw AgentServiceError.InvalidInput("A valid project path is required.")
    var current = _threads.value.find { it.id == normalizedThreadId }
        ?: throw AgentServiceError.InvalidInput("Thread not found.")
    val previousThread = current
    val previousAuth =
        authoritativeProjectPathByThreadId[normalizedThreadId]
            ?.let { CodexThread.normalizeProjectPath(it) }
    val previousManaged =
        associatedManagedWorktreePathByThreadId[normalizedThreadId]
            ?.let { CodexThread.normalizeProjectPath(it) }
    val wasResumed = resumedThreadIds.contains(normalizedThreadId)

    beginAuthoritativeProjectPathTransition(normalizedThreadId, normalizedProjectPath)
    rememberAssociatedManagedWorktreePathIfWorktree(normalizedProjectPath, normalizedThreadId)
    val now = Instant.now()
    current = current.copy(cwd = normalizedProjectPath, updatedAt = now)
    publishThreads(upsertThreadRow(_threads.value, current))
    _activeThreadId.value = normalizedThreadId
    sessionPersistence.saveLastActiveThreadId(normalizedThreadId)
    resumedThreadIds.remove(normalizedThreadId)

    try {
        val resumed = ensureThreadResumedInternal(normalizedThreadId, force = true, preferredProjectPath = normalizedProjectPath)
        val observed = resumed?.normalizedProjectPath
        confirmAuthoritativeProjectPathIfNeeded(
            normalizedThreadId,
            observed,
            authoritativeProjectPathByThreadId,
        )
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        if (shouldAllowProjectRebindWithoutResume(e)) {
            requestImmediateThreadListSync()
            return _threads.value.find { it.id == normalizedThreadId } ?: current
        }
        publishThreads(upsertThreadRow(_threads.value, previousThread))
        if (previousAuth != null) {
            authoritativeProjectPathByThreadId[normalizedThreadId] = previousAuth
        } else {
            authoritativeProjectPathByThreadId.remove(normalizedThreadId)
        }
        restoreAssociatedManagedWorktreePath(previousManaged, normalizedThreadId)
        if (wasResumed) {
            resumedThreadIds.add(normalizedThreadId)
        } else {
            resumedThreadIds.remove(normalizedThreadId)
        }
        requestImmediateThreadListSync()
        throw e
    }

    requestImmediateThreadListSync()
    return _threads.value.find { it.id == normalizedThreadId } ?: current
}
