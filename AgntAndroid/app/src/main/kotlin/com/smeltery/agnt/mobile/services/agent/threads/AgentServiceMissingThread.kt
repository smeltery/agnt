package com.smeltery.agnt.mobile.services.agent.threads

import com.smeltery.agnt.mobile.services.agent.AgentService
import com.smeltery.agnt.mobile.services.agent.runtime.publishThreads
import com.smeltery.agnt.mobile.services.agent.runtime.refreshThreadsInternal

/**
 * When `thread/read` or `turn/start` reports the thread no longer exists on the bridge,
 * prune local state so the UI does not stay on a ghost conversation (parity iOS `handleMissingThread`).
 */
internal suspend fun AgentService.handleMissingThread(threadId: String) {
    val tid = threadId.trim()
    if (tid.isEmpty()) return
    noteTurnFinished(tid)
    clearThreadOutcome(tid)
    resumedThreadIds.remove(tid)
    _protectedRunningFallbackThreadIds.value = _protectedRunningFallbackThreadIds.value - tid
    _runningTurnIdByThread.value = _runningTurnIdByThread.value - tid
    messageTimelineStore.removeThreadMessages(tid)
    sessionPersistence.removeThreadRename(tid)
    hydratedThreadIds.remove(tid)
    loadingHistory.remove(tid)
    _threadHistoryPaginationByThread.value = _threadHistoryPaginationByThread.value - tid
    _loadingOlderHistoryThreadIds.value = _loadingOlderHistoryThreadIds.value - tid
    _olderHistoryErrorByThread.value = _olderHistoryErrorByThread.value - tid
    if (_activeThreadId.value == tid) {
        _activeThreadId.value = null
        sessionPersistence.saveLastActiveThreadId(null)
    }
    publishThreads(_threads.value.filter { it.id != tid })
    runCatching { refreshThreadsInternal() }
}
