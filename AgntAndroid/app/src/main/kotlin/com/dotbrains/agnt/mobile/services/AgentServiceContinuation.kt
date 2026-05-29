package com.dotbrains.agnt.mobile.services

import com.dotbrains.agnt.mobile.R
import com.dotbrains.agnt.mobile.core.model.CodexThread

/**
 * Parity with [AgentService.createContinuationThread] in
 * [AgentService+ThreadsTurns.swift](../../../../../../../../CodexMobile/CodexMobile/Services/AgentService+ThreadsTurns.swift).
 */
internal suspend fun AgentService.createContinuationThreadInternal(
    archivedThreadId: String,
    priorThread: CodexThread?,
): CodexThread {
    val model = priorThread?.model?.trim()?.takeIf { it.isNotEmpty() }
    val cwd = priorThread?.gitWorkingDirectory
    val thread = startThreadInternal(model = model, cwd = cwd, serviceTier = null)
    val line =
        appContext.getString(R.string.thread_continuation_from_archived, archivedThreadId)
    messageTimelineStore.appendSystemLine(
        threadId = thread.id,
        turnId = null,
        text = line,
    )
    sessionPersistence.saveLastActiveThreadId(thread.id)
    return thread
}
