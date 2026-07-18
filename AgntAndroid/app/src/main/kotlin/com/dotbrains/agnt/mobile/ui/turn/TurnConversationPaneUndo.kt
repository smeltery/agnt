package com.dotbrains.agnt.mobile.ui.turn

import com.dotbrains.agnt.mobile.core.model.AIChangeSet
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.TurnUsageSheetLogic
import com.dotbrains.agnt.mobile.core.persistence.AIChangeSetPersistence
import com.dotbrains.agnt.mobile.data.CodexRepository
import com.dotbrains.agnt.mobile.services.agent.review.AiChangeSetRevertService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.time.Instant

internal fun handleTurnAssistantUndo(
    changeSet: AIChangeSet,
    activeThread: CodexThread?,
    repository: CodexRepository,
    aiChangeSetPersistence: AIChangeSetPersistence,
    scope: CoroutineScope,
    applyingUndoChangeSetIds: Set<String>,
    undoMissingCwdMessage: String,
    undoFailedMessage: String,
    setApplyingUndoChangeSetIds: (Set<String>) -> Unit,
    setInlineUndoError: (String?) -> Unit,
    refreshThreadChangeSets: () -> Unit,
) {
    val workingDirectory = changeSet.repoRoot ?: activeThread?.cwd
    if (workingDirectory.isNullOrBlank()) {
        setInlineUndoError(undoMissingCwdMessage)
        return
    }
    scope.launch {
        setApplyingUndoChangeSetIds(applyingUndoChangeSetIds + changeSet.id)
        setInlineUndoError(null)
        runCatching {
            AiChangeSetRevertService(repository).apply(
                changeSet = changeSet,
                workingDirectory = workingDirectory,
            )
        }.onSuccess { applyResult ->
            if (applyResult.success) {
                aiChangeSetPersistence.save(
                    TurnUsageSheetLogic.markChangeSetReverted(
                        changeSets = aiChangeSetPersistence.load(),
                        changeSetId = changeSet.id,
                        now = Instant.now(),
                    ),
                )
            } else {
                val message =
                    applyResult.unsupportedReasons.firstOrNull()
                        ?: applyResult.conflicts.firstOrNull()?.message
                        ?: undoFailedMessage
                recordTurnAssistantUndoError(
                    message = message,
                    changeSetId = changeSet.id,
                    aiChangeSetPersistence = aiChangeSetPersistence,
                    setInlineUndoError = setInlineUndoError,
                )
            }
        }.onFailure { error ->
            val message =
                error.message?.ifBlank { null }
                    ?: undoFailedMessage
            recordTurnAssistantUndoError(
                message = message,
                changeSetId = changeSet.id,
                aiChangeSetPersistence = aiChangeSetPersistence,
                setInlineUndoError = setInlineUndoError,
            )
        }
        refreshThreadChangeSets()
        setApplyingUndoChangeSetIds(applyingUndoChangeSetIds - changeSet.id)
    }
}

private fun recordTurnAssistantUndoError(
    message: String,
    changeSetId: String,
    aiChangeSetPersistence: AIChangeSetPersistence,
    setInlineUndoError: (String?) -> Unit,
) {
    setInlineUndoError(message)
    aiChangeSetPersistence.save(
        TurnUsageSheetLogic.recordChangeSetRevertError(
            changeSets = aiChangeSetPersistence.load(),
            changeSetId = changeSetId,
            message = message,
            now = Instant.now(),
        ),
    )
}
