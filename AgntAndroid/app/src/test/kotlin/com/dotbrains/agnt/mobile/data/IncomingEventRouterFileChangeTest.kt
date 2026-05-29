package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.PendingApprovalDecision
import com.dotbrains.agnt.mobile.core.model.PendingApprovalRequest
import com.dotbrains.agnt.mobile.core.model.PendingStructuredInputRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertTrue

class IncomingEventRouterFileChangeTest {
    @Test
    fun fileChangeDelta_ignoresGlobLikeImageReferencesAndPreviewErrors() =
        runBlocking {
            val timeline = MessageTimelineStore()

            newRouter(timeline).dispatchNotification(
                method = "item/fileChange/outputDelta",
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thread-1"),
                            "turnId" to JSONValue.Str("turn-1"),
                            "delta" to JSONValue.Str("images/*.png"),
                        ),
                    ),
            )

            newRouter(timeline).dispatchNotification(
                method = "item/fileChange/outputDelta",
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thread-1"),
                            "turnId" to JSONValue.Str("turn-1"),
                            "delta" to JSONValue.Str("This image preview took too long to resize."),
                        ),
                    ),
            )

            assertTrue(
                timeline.messagesByThread.value["thread-1"]
                    .orEmpty()
                    .isEmpty(),
            )
        }

    private fun newRouter(messageTimeline: MessageTimelineStore): IncomingEventRouter =
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
