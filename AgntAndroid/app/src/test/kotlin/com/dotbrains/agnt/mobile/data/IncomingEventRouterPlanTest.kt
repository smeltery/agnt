package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexPlanStepStatus
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.PendingApprovalDecision
import com.dotbrains.agnt.mobile.core.model.PendingApprovalRequest
import com.dotbrains.agnt.mobile.core.model.PendingStructuredInputRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals

class IncomingEventRouterPlanTest {
    @Test
    fun codexEventPlanUpdateEnvelope_addsStreamingPlanFromNestedMsg() =
        runBlocking {
            val timeline = MessageTimelineStore()
            val router = newRouter(messageTimeline = timeline)

            router.dispatchNotification(
                method = "codex/event",
                params =
                    JSONValue.Obj(
                        mapOf(
                            "msg" to
                                JSONValue.Obj(
                                    mapOf(
                                        "type" to JSONValue.Str("plan_update"),
                                        "threadId" to JSONValue.Str("thread-1"),
                                        "turnId" to JSONValue.Str("turn-1"),
                                        "explanation" to JSONValue.Str("Plan first"),
                                        "plan" to
                                            JSONValue.Arr(
                                                listOf(
                                                    JSONValue.Obj(
                                                        mapOf(
                                                            "step" to JSONValue.Str("Inspect"),
                                                            "status" to JSONValue.Str("in_progress"),
                                                        ),
                                                    ),
                                                ),
                                            ),
                                    ),
                                ),
                        ),
                    ),
            )

            val plan =
                timeline.messagesByThread.value["thread-1"]
                    .orEmpty()
                    .single()
            assertEquals(CodexMessageKind.plan, plan.kind)
            assertEquals(true, plan.isStreaming)
            assertEquals("Plan first", plan.planState?.explanation)
            assertEquals(
                CodexPlanStepStatus.inProgress,
                plan.planState
                    ?.steps
                    ?.single()
                    ?.status,
            )
        }

    @Test
    fun codexEventPlanDelta_method_routesToPlanHandlerWithExplicitPlan() =
        runBlocking {
            val timeline = MessageTimelineStore()
            val router = newRouter(messageTimeline = timeline)

            router.dispatchNotification(
                method = "codex/event/plan_delta",
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thread-2"),
                            "turnId" to JSONValue.Str("turn-2"),
                            "plan" to
                                JSONValue.Arr(
                                    listOf(
                                        JSONValue.Obj(
                                            mapOf(
                                                "step" to JSONValue.Str("Draft"),
                                                "status" to JSONValue.Str("pending"),
                                            ),
                                        ),
                                    ),
                                ),
                        ),
                    ),
            )

            val plan =
                timeline.messagesByThread.value["thread-2"]
                    .orEmpty()
                    .single()
            assertEquals(CodexMessageKind.plan, plan.kind)
            assertEquals(
                CodexPlanStepStatus.pending,
                plan.planState
                    ?.steps
                    ?.single()
                    ?.status,
            )
        }

    @Test
    fun codexEventPlanUpdate_acceptsSummaryAsExplanation() =
        runBlocking {
            val timeline = MessageTimelineStore()
            val router = newRouter(messageTimeline = timeline)

            router.dispatchNotification(
                method = "codex/event/plan_update",
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thread-3"),
                            "turnId" to JSONValue.Str("turn-3"),
                            "summary" to JSONValue.Str("Plan summary"),
                        ),
                    ),
            )

            val plan =
                timeline.messagesByThread.value["thread-3"]
                    .orEmpty()
                    .single()
            assertEquals(CodexMessageKind.plan, plan.kind)
            assertEquals("Plan summary", plan.planState?.explanation)
        }

    private fun newRouter(messageTimeline: MessageTimelineStore = MessageTimelineStore()): IncomingEventRouter =
        IncomingEventRouter(
            scope = kotlinx.coroutines.CoroutineScope(Dispatchers.Unconfined),
            threads = MutableStateFlow<List<CodexThread>>(emptyList()),
            activeThreadId = MutableStateFlow(null),
            messageTimeline = messageTimeline,
            onRequestThreadSync = {},
            onHydrateThread = {},
            onTurnLifecycle = { _, _ -> },
            onTurnFinished = {},
            isTurnStreamingActive = { _, _ -> false },
            shouldAutoApproveRequests = { false },
            onApprovalRequest = { _: PendingApprovalRequest, _: (PendingApprovalDecision) -> Unit -> },
            onStructuredInputRequest = { _: PendingStructuredInputRequest, _: (Map<String, List<String>>) -> Unit -> },
        )
}
