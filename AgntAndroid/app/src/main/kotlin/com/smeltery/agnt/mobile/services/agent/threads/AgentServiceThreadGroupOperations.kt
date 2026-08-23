package com.smeltery.agnt.mobile.services.agent.threads

import com.smeltery.agnt.mobile.core.model.CodexThreadSyncState
import com.smeltery.agnt.mobile.services.agent.AgentService
import com.smeltery.agnt.mobile.services.agent.runtime.publishThreads
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Mirrors [AgentService+Sync.swift](../../../../../../../../CodexMobile/CodexMobile/Services/AgentService+Sync.swift)
 * archiveThreadGroup / deleteLocalThreadGroup.
 */
internal suspend fun AgentService.archiveThreadGroupForRepository(threadIds: List<String>): List<String> =
    withContext(Dispatchers.IO) {
        archiveThreadGroupInternal(threadIds)
    }

internal suspend fun AgentService.deleteLocalThreadGroupForRepository(threadIds: List<String>): List<String> =
    withContext(Dispatchers.IO) {
        deleteLocalThreadGroupInternal(threadIds)
    }

internal suspend fun AgentService.archiveThreadGroupInternal(threadIds: List<String>): List<String> {
    val rootThreadIds = collectRootThreadIds(threadIds)
    for (rootId in rootThreadIds) {
        archiveThreadInternal(rootId)
    }
    return rootThreadIds
}

internal suspend fun AgentService.deleteLocalThreadGroupInternal(threadIds: List<String>): List<String> {
    val rootThreadIds = collectRootThreadIds(threadIds)
    val subtreeThreadIds = rootThreadIds.flatMap { collectSubtreeThreadIds(it) }
    val allIds = (subtreeThreadIds + rootThreadIds).distinct()
    for (tid in allIds) {
        deleteThreadLocallyInternal(tid)
    }
    return rootThreadIds
}

private fun AgentService.collectRootThreadIds(threadIds: List<String>): List<String> {
    val allThreads = _threads.value
    val inputSet = threadIds.toSet()
    return inputSet.filter { tid ->
        val thread = allThreads.find { it.id == tid } ?: return@filter true
        thread.parentThreadId == null || thread.parentThreadId !in inputSet
    }
}

private fun AgentService.collectSubtreeThreadIds(parentId: String): List<String> {
    val allThreads = _threads.value
    val queue = ArrayDeque<String>()
    queue.add(parentId)
    val visited = mutableSetOf<String>()
    val descendants = mutableListOf<String>()
    while (queue.isNotEmpty()) {
        val current = queue.removeFirst()
        for (thread in allThreads) {
            if (thread.parentThreadId == current && visited.add(thread.id)) {
                descendants.add(thread.id)
                queue.add(thread.id)
            }
        }
    }
    return descendants
}

private suspend fun AgentService.archiveThreadInternal(threadId: String) {
    val subtreeIds = collectSubtreeThreadIds(threadId)
    val allIds = listOf(threadId) + subtreeIds
    for (tid in allIds) {
        setThreadArchivedLocally(tid, isArchived = true)
    }
    sendThreadArchiveRpc(threadId, unarchive = false)
}

private suspend fun AgentService.sendThreadArchiveRpc(
    threadId: String,
    unarchive: Boolean,
) {
    if (!sessionReady) return
    runCatching {
        sendRequestImpl(
            "thread/archive",
            com.smeltery.agnt.mobile.core.model.JSONValue.Obj(
                mapOf(
                    "thread_id" to
                        com.smeltery.agnt.mobile.core.model.JSONValue
                            .Str(threadId),
                ),
            ),
        )
    }
}

private suspend fun AgentService.setThreadArchivedLocally(
    threadId: String,
    isArchived: Boolean,
) {
    noteTurnFinished(threadId)
    resumedThreadIds.remove(threadId)
    hydratedThreadIds.remove(threadId)
    loadingHistory.remove(threadId)
    _protectedRunningFallbackThreadIds.value = _protectedRunningFallbackThreadIds.value - threadId
    _runningTurnIdByThread.value = _runningTurnIdByThread.value - threadId
    messageTimelineStore.removeThreadMessages(threadId)
    sessionPersistence.removeThreadRename(threadId)
    associatedManagedWorktreePathByThreadId.remove(threadId)
    sessionPersistence.removeAssociatedManagedWorktreePath(threadId)
    if (isArchived) {
        sessionPersistence.addLocallyArchivedThreadId(threadId)
    } else {
        sessionPersistence.removeLocallyArchivedThreadId(threadId)
    }

    val currentThreads = _threads.value.toMutableList()
    val idx = currentThreads.indexOfFirst { it.id == threadId }
    if (idx >= 0) {
        currentThreads[idx] =
            currentThreads[idx].copy(
                syncState = if (isArchived) CodexThreadSyncState.archivedLocal else CodexThreadSyncState.live,
            )
    }

    if (_activeThreadId.value == threadId) {
        _activeThreadId.value = null
        sessionPersistence.saveLastActiveThreadId(null)
    }

    publishThreads(currentThreads)
}
