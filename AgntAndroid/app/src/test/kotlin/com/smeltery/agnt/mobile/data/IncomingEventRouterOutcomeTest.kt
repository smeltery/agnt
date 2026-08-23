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

class IncomingEventRouterOutcomeTest {
    @Test
    fun turnCompletedPublishesCompletionOutcome() =
        runBlocking {
            val completed = mutableListOf<String>()
            val failed = mutableListOf<String>()
            val router =
                newRouter(
                    onTurnCompleted = { completed += it },
                    onTurnFailed = { failed += it },
                )

            router.dispatchNotification(
                method = "turn/completed",
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thread-ready"),
                            "turnId" to JSONValue.Str("turn-1"),
                        ),
                    ),
            )

            assertEquals(listOf("thread-ready"), completed)
            assertEquals(emptyList(), failed)
        }

    @Test
    fun turnFailedPublishesFailureOutcome() =
        runBlocking {
            val completed = mutableListOf<String>()
            val failed = mutableListOf<String>()
            val router =
                newRouter(
                    onTurnCompleted = { completed += it },
                    onTurnFailed = { failed += it },
                )

            router.dispatchNotification(
                method = "turn/failed",
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thread-failed"),
                            "turnId" to JSONValue.Str("turn-2"),
                            "message" to JSONValue.Str("Tool failed"),
                        ),
                    ),
            )

            assertEquals(emptyList(), completed)
            assertEquals(listOf("thread-failed"), failed)
        }

    @Test
    fun errorNotificationPublishesFailureOutcome() =
        runBlocking {
            val failed = mutableListOf<String>()
            val router = newRouter(onTurnFailed = { failed += it })

            router.dispatchNotification(
                method = "error",
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thread-error"),
                            "turnId" to JSONValue.Str("turn-3"),
                            "message" to JSONValue.Str("Runtime error"),
                        ),
                    ),
            )

            assertEquals(listOf("thread-error"), failed)
        }

    private fun newRouter(
        onTurnCompleted: (threadId: String) -> Unit = {},
        onTurnFailed: (threadId: String) -> Unit = {},
    ): IncomingEventRouter =
        IncomingEventRouter(
            scope = kotlinx.coroutines.CoroutineScope(Dispatchers.Unconfined),
            threads = MutableStateFlow<List<CodexThread>>(emptyList()),
            activeThreadId = MutableStateFlow(null),
            messageTimeline = MessageTimelineStore(),
            onRequestThreadSync = {},
            onHydrateThread = {},
            onTurnLifecycle = { _, _ -> },
            onTurnFinished = {},
            onTurnCompleted = onTurnCompleted,
            onTurnFailed = onTurnFailed,
            isTurnStreamingActive = { _, _ -> false },
            shouldAutoApproveRequests = { false },
            onApprovalRequest = { _: PendingApprovalRequest, _: (PendingApprovalDecision) -> Unit -> },
            onStructuredInputRequest = { _: PendingStructuredInputRequest, _: (Map<String, List<String>>) -> Unit -> },
        )
}
