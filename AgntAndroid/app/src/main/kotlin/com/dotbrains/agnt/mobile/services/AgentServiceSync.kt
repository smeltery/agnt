package com.dotbrains.agnt.mobile.services

import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.CodexThreadSyncState
import com.dotbrains.agnt.mobile.data.ThreadListSync

/**
 * Mirrors [AgentService+Sync.swift](../../../../../../../../CodexMobile/CodexMobile/Services/AgentService+Sync.swift).
 */
internal suspend fun AgentService.refreshThreadsInternal() {
    if (!sessionReady) return
    val locallyDeleted = sessionPersistence.loadLocallyDeletedThreadIds()
    val locallyArchived = sessionPersistence.loadLocallyArchivedThreadIds()
    val fetched =
        runCatching { ThreadListSync.fetchMerged(this) }
            .getOrElse { return }
            .filter { it.id !in locallyDeleted }
            .map { thread ->
                if (thread.id in locallyArchived && thread.syncState == CodexThreadSyncState.live) {
                    thread.copy(syncState = CodexThreadSyncState.archivedLocal)
                } else {
                    thread
                }
            }
    val serverThreads = fetched.map { incoming -> applyAuthoritativeProjectPathToServerThread(incoming) }
    val merged =
        mergeThreadListWithPersistedRenames(
            fetched = serverThreads,
            previous = _threads.value,
            persistedRename = { tid -> persistedThreadRename(tid) },
        )
    publishThreads(merged)
}

internal fun AgentService.publishThreads(threads: List<CodexThread>) {
    _threads.value = threads
    sessionPersistence.saveCachedThreads(threads)
}
