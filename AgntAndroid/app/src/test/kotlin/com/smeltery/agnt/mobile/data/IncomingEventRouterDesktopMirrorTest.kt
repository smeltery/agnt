package com.smeltery.agnt.mobile.data

import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.core.model.JSONValue
import com.smeltery.agnt.mobile.core.model.PendingApprovalDecision
import com.smeltery.agnt.mobile.core.model.PendingApprovalRequest
import com.smeltery.agnt.mobile.core.model.PendingStructuredInputRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Codex desktop-mirror path: a final `codex/event/agent_message` arriving without a
 * turn id must clear the per-thread running fallback by finalizing the turn, since
 * the mirror never emits a `turn/completed`. An `agent_message` that carries a turn id
 * is finalized by the normal `turn/completed` lifecycle instead, so it must not
 * double-finalize here.
 */
class IncomingEventRouterDesktopMirrorTest {
    @Test
    fun desktopFinalAgentMessageWithoutTurnId_clearsRunningFallback() =
        runBlocking {
            val completed = mutableListOf<String>()
            val router = newRouter(onTurnCompleted = { threadId -> completed += threadId })

            router.dispatchNotification(
                method = "codex/event/user_message",
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thread-1"),
                            "message" to JSONValue.Str("Prompt from PC"),
                        ),
                    ),
            )
            router.dispatchNotification(
                method = "codex/event/agent_message",
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thread-1"),
                            "message" to JSONValue.Str("Final answer"),
                        ),
                    ),
            )

            assertEquals(listOf("thread-1"), completed)
        }

    @Test
    fun desktopAgentMessageWithTurnId_doesNotFinalizeTurn() =
        runBlocking {
            val completed = mutableListOf<String>()
            val router = newRouter(onTurnCompleted = { threadId -> completed += threadId })

            router.dispatchNotification(
                method = "codex/event/agent_message",
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thread-1"),
                            "turnId" to JSONValue.Str("turn-1"),
                            "itemId" to JSONValue.Str("assistant-1"),
                            "message" to JSONValue.Str("Final answer"),
                        ),
                    ),
            )

            assertEquals(emptyList(), completed)
        }

    private fun newRouter(
        messageTimeline: MessageTimelineStore = MessageTimelineStore(),
        onTurnCompleted: (threadId: String) -> Unit = {},
    ): IncomingEventRouter =
        IncomingEventRouter(
            scope = kotlinx.coroutines.CoroutineScope(Dispatchers.Unconfined),
            threads = MutableStateFlow<List<CodexThread>>(emptyList()),
            activeThreadId = MutableStateFlow(null),
            messageTimeline = messageTimeline,
            onRequestThreadSync = {},
            onHydrateThread = {},
            onTurnLifecycle = { _, _ -> },
            onTurnFinished = {},
            onTurnCompleted = onTurnCompleted,
            isTurnStreamingActive = { _, _ -> false },
            shouldAutoApproveRequests = { false },
            onApprovalRequest = { _: PendingApprovalRequest, _: (PendingApprovalDecision) -> Unit -> },
            onStructuredInputRequest = { _: PendingStructuredInputRequest, _: (Map<String, List<String>>) -> Unit -> },
        )
}
