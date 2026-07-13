package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.JSONValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal class IncomingCommandExecutionRouter(
    private val scope: CoroutineScope,
    private val messageTimeline: MessageTimelineStore,
    private val commandDetailsStore: CommandExecutionDetailsStore,
    private val envelopeEventObject: (Map<String, JSONValue>) -> Map<String, JSONValue>?,
    private val resolveThreadId: (Map<String, JSONValue>?) -> String?,
    private val recordTurnThread: (turnId: String?, threadId: String?) -> Unit,
    private val markTurnActiveFromLiveEvent: (threadId: String, turnId: String?) -> Unit,
) {
    fun handleState(
        method: String,
        params: Map<String, JSONValue>?,
    ) {
        val p = params ?: return
        val event = envelopeEventObject(p)
        val state =
            CommandExecutionEventParser.parse(
                params = p,
                eventObject = event,
                method = method,
            )
        commandDetailsStore.upsertFromState(
            itemId = state.itemId,
            fullCommand = state.fullCommand,
            cwd = state.cwd,
            exitCode = state.exitCode,
            durationMs = state.durationMs,
        )

        val normalized = method.trim().lowercase()
        val isBegin = normalized.endsWith("exec_command_begin") || normalized.contains("commandexecution/started")
        val isEnd = normalized.endsWith("exec_command_end") || normalized.contains("commandexecution/completed")
        if (!isBegin && !isEnd) return

        val turnId = IncomingNotificationParsers.extractTurnId(p)
        val threadId = resolveThreadId(p) ?: return
        if (isBegin) {
            markTurnActiveFromLiveEvent(threadId, turnId)
        } else {
            recordTurnThread(turnId, threadId)
        }
        val itemId = state.itemId ?: IncomingNotificationParsers.extractItemId(p)
        val shortCommand =
            itemId?.let { id ->
                commandDetailsStore.detailsByItemId.value[id]
                    ?.fullCommand
                    ?.trim()
                    ?.takeIf { it.isNotEmpty() }
            } ?: state.fullCommand

        scope.launch {
            when {
                isBegin ->
                    messageTimeline.ensureStreamingSystemItem(
                        threadId = threadId,
                        turnId = turnId,
                        itemId = itemId,
                        kind = CodexMessageKind.commandExecution,
                        initialText =
                            commandExecutionTimelineLine(
                                phase = "running",
                                fullCommand = shortCommand,
                            ),
                    )
                isEnd ->
                    messageTimeline.completeSystemItem(
                        threadId = threadId,
                        turnId = turnId,
                        itemId = itemId,
                        kind = CodexMessageKind.commandExecution,
                        text =
                            commandExecutionTimelineLine(
                                phase = state.phase,
                                fullCommand = shortCommand,
                            ),
                    )
                else -> Unit
            }
        }
    }

    fun handleDelta(
        method: String,
        params: Map<String, JSONValue>?,
    ) {
        val p = params ?: return
        val event = envelopeEventObject(p)
        val state =
            CommandExecutionEventParser.parse(
                params = p,
                eventObject = event,
                method = method,
            )
        commandDetailsStore.upsertFromState(
            itemId = state.itemId,
            fullCommand = state.fullCommand,
            cwd = state.cwd,
            exitCode = state.exitCode,
            durationMs = state.durationMs,
        )
        state.outputChunk?.let { commandDetailsStore.appendOutput(state.itemId, it) }

        val turnId = IncomingNotificationParsers.extractTurnId(p)
        val threadId = resolveThreadId(p) ?: return
        markTurnActiveFromLiveEvent(threadId, turnId)
        val itemId = state.itemId ?: IncomingNotificationParsers.extractItemId(p)
        scope.launch {
            if (itemId != null) {
                messageTimeline.ensureStreamingSystemItem(
                    threadId = threadId,
                    turnId = turnId,
                    itemId = itemId,
                    kind = CodexMessageKind.commandExecution,
                    initialText =
                        commandExecutionTimelineLine(
                            phase = "running",
                            fullCommand = state.fullCommand,
                        ),
                )
                return@launch
            }

            val delta = IncomingNotificationParsers.extractTextDelta(p) ?: state.outputChunk ?: return@launch
            if (delta.isEmpty()) return@launch
            if (!turnId.isNullOrEmpty()) {
                messageTimeline.appendStreamingSystemItemDelta(
                    threadId,
                    turnId,
                    null,
                    CodexMessageKind.commandExecution,
                    delta,
                )
            } else {
                messageTimeline.appendSystemLine(
                    threadId,
                    null,
                    delta,
                    CodexMessageKind.commandExecution,
                )
            }
        }
    }
}
