package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.PendingApprovalDecision
import com.dotbrains.agnt.mobile.core.model.PendingApprovalRequest
import com.dotbrains.agnt.mobile.core.model.PendingStructuredInputRequest
import com.dotbrains.agnt.mobile.core.model.RPCMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class IncomingEventRouterServerRequestTest {
    @Test
    fun dispatchServerRequest_enqueuesCommandApprovalAndReturnsDecisionObject() =
        runBlocking {
            val pending =
                CompletableDeferred<Pair<PendingApprovalRequest, (PendingApprovalDecision) -> Unit>>()
            val response = CompletableDeferred<RPCMessage>()
            newRouter(
                onApprovalRequest = { request, respond -> pending.complete(request to respond) },
            ).dispatchServerRequest(
                method = "item/commandExecution/requestApproval",
                requestId = JSONValue.Str("approval-1"),
                params =
                    JSONValue.Obj(
                        mapOf(
                            "command" to JSONValue.Str("git status"),
                            "reason" to JSONValue.Str("Inspect workspace"),
                        ),
                    ),
                respond = { response.complete(it) },
            )

            val (request, respond) = withTimeout(ROUTER_TEST_TIMEOUT_MS) { pending.await() }
            assertEquals("item/commandExecution/requestApproval", request.method)
            assertEquals("git status", request.command)
            assertEquals("Inspect workspace", request.reason)
            respond(PendingApprovalDecision.Decline)

            val message = withTimeout(ROUTER_TEST_TIMEOUT_MS) { response.await() }
            assertEquals(JSONValue.Str("approval-1"), message.id)
            assertEquals(JSONValue.Obj(mapOf("decision" to JSONValue.Str("decline"))), message.result)
            assertNull(message.error)
            assertNull(message.jsonrpc)
        }

    @Test
    fun dispatchServerRequest_appendsPendingApprovalTimelineMarkerWhenThreadScoped() =
        runBlocking {
            val timeline = MessageTimelineStore()
            val pending =
                CompletableDeferred<Pair<PendingApprovalRequest, (PendingApprovalDecision) -> Unit>>()
            val response = CompletableDeferred<RPCMessage>()
            newRouter(
                messageTimeline = timeline,
                onApprovalRequest = { request, respond -> pending.complete(request to respond) },
            ).dispatchServerRequest(
                method = "item/commandExecution/requestApproval",
                requestId = JSONValue.Str("approval-timeline"),
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thr-99"),
                            "turnId" to JSONValue.Str("turn-aa"),
                            "itemId" to JSONValue.Str("item-ii"),
                            "command" to JSONValue.Str("git diff"),
                            "reason" to JSONValue.Str("Review changes"),
                        ),
                    ),
                respond = { response.complete(it) },
            )

            val (request, respond) = withTimeout(ROUTER_TEST_TIMEOUT_MS) { pending.await() }
            assertEquals("thr-99", request.threadId)
            assertEquals("turn-aa", request.turnId)
            assertEquals("item-ii", request.itemId)

            val row = timeline.messagesByThread.value["thr-99"]?.singleOrNull()
            assertNotNull(row)
            assertEquals(CodexMessageKind.pendingApproval, row.kind)
            assertEquals(request.id, row.id)
            assertEquals("turn-aa", row.turnId)
            assertEquals("item-ii", row.itemId)
            assertEquals(
                "Review changes\n\nCommand: git diff",
                row.text,
            )

            respond(PendingApprovalDecision.Accept)
            withTimeout(ROUTER_TEST_TIMEOUT_MS) { response.await() }
            Unit
        }

    @Test
    fun dispatchServerRequest_fileChangeApprovalRoutesThroughDecisionPayload() =
        runBlocking {
            val timeline = MessageTimelineStore()
            val pending =
                CompletableDeferred<Pair<PendingApprovalRequest, (PendingApprovalDecision) -> Unit>>()
            val response = CompletableDeferred<RPCMessage>()
            newRouter(
                messageTimeline = timeline,
                onApprovalRequest = { request, respond -> pending.complete(request to respond) },
            ).dispatchServerRequest(
                method = "item/fileChange/requestApproval",
                requestId = JSONValue.Str("filechange-1"),
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thr-fc"),
                            "turnId" to JSONValue.Str("turn-fc"),
                            "itemId" to JSONValue.Str("item-fc"),
                            "reason" to JSONValue.Str("Write README.md"),
                        ),
                    ),
                respond = { response.complete(it) },
            )

            val (request, respond) = withTimeout(ROUTER_TEST_TIMEOUT_MS) { pending.await() }
            assertEquals("item/fileChange/requestApproval", request.method)
            assertEquals("thr-fc", request.threadId)
            assertEquals("turn-fc", request.turnId)
            assertEquals("item-fc", request.itemId)
            assertEquals("Write README.md", request.reason)
            assertNull(request.command)

            // Timeline marker carries the file-change fallback headline shape.
            val row = timeline.messagesByThread.value["thr-fc"]?.singleOrNull()
            assertNotNull(row)
            assertEquals(CodexMessageKind.pendingApproval, row.kind)
            assertEquals("Write README.md", row.text)

            respond(PendingApprovalDecision.Accept)
            val message = withTimeout(ROUTER_TEST_TIMEOUT_MS) { response.await() }
            assertEquals(JSONValue.Str("filechange-1"), message.id)
            assertEquals(JSONValue.Obj(mapOf("decision" to JSONValue.Str("accept"))), message.result)
            assertNull(message.error)
            assertNull(message.jsonrpc)
        }

    @Test
    fun dispatchServerRequest_commandApprovalAcceptForSessionUsesDecisionPayload() =
        runBlocking {
            val pending =
                CompletableDeferred<Pair<PendingApprovalRequest, (PendingApprovalDecision) -> Unit>>()
            val response = CompletableDeferred<RPCMessage>()
            newRouter(
                onApprovalRequest = { request, respond -> pending.complete(request to respond) },
            ).dispatchServerRequest(
                method = "item/command_execution/request_approval",
                requestId = JSONValue.Str("approval-session"),
                params = JSONValue.Obj(mapOf("command" to JSONValue.Str("npm test"))),
                respond = { response.complete(it) },
            )

            val (_, respond) = withTimeout(ROUTER_TEST_TIMEOUT_MS) { pending.await() }
            respond(PendingApprovalDecision.AcceptForSession)

            val message = withTimeout(ROUTER_TEST_TIMEOUT_MS) { response.await() }
            assertEquals(JSONValue.Str("approval-session"), message.id)
            assertEquals(
                JSONValue.Obj(mapOf("decision" to JSONValue.Str("acceptForSession"))),
                message.result,
            )
            assertNull(message.error)
        }

    @Test
    fun dispatchServerRequest_autoApprovesWhenFullAccessIsEnabled() =
        runBlocking {
            val response =
                routerResponseFor(
                    method = "desktop/custom/requestApproval",
                    requestId = JSONValue.NumLong(42),
                    shouldAutoApproveRequests = true,
                )

            assertEquals(JSONValue.NumLong(42), response.id)
            assertEquals(JSONValue.Obj(mapOf("decision" to JSONValue.Str("accept"))), response.result)
            assertNull(response.error)
            assertNull(response.jsonrpc)
        }

    @Test
    fun dispatchServerRequest_answersStructuredUserInputAfterUserResponse() =
        runBlocking {
            val pending =
                CompletableDeferred<
                    Pair<PendingStructuredInputRequest, (answersByQuestionId: Map<String, List<String>>) -> Unit>,
                >()
            val response = CompletableDeferred<RPCMessage>()
            newRouter(
                onStructuredInputRequest = { request, respond -> pending.complete(request to respond) },
            ).dispatchServerRequest(
                method = "item/tool/requestUserInput",
                requestId = JSONValue.Str("input-1"),
                params =
                    JSONValue.Obj(
                        mapOf(
                            "questions" to
                                JSONValue.Arr(
                                    listOf(
                                        JSONValue.Obj(
                                            mapOf(
                                                "id" to JSONValue.Str("mode"),
                                                "header" to JSONValue.Str("Mode"),
                                                "question" to JSONValue.Str("Pick a mode"),
                                                "options" to
                                                    JSONValue.Arr(
                                                        listOf(
                                                            JSONValue.Obj(
                                                                mapOf(
                                                                    "label" to JSONValue.Str("Plan"),
                                                                    "description" to JSONValue.Str("Plan first"),
                                                                ),
                                                            ),
                                                        ),
                                                    ),
                                            ),
                                        ),
                                    ),
                                ),
                        ),
                    ),
                respond = { response.complete(it) },
            )

            val (request, respond) = withTimeout(ROUTER_TEST_TIMEOUT_MS) { pending.await() }
            assertEquals("mode", request.questions.single().id)
            assertEquals("Pick a mode", request.questions.single().question)
            assertEquals(
                "Plan",
                request.questions
                    .single()
                    .options
                    .single()
                    .label,
            )
            respond(mapOf("mode" to listOf("Plan")))

            val message = withTimeout(ROUTER_TEST_TIMEOUT_MS) { response.await() }
            assertEquals(JSONValue.Str("input-1"), message.id)
            assertEquals(
                JSONValue.Obj(
                    mapOf(
                        "answers" to
                            JSONValue.Obj(
                                mapOf(
                                    "mode" to
                                        JSONValue.Obj(
                                            mapOf(
                                                "answers" to JSONValue.Arr(listOf(JSONValue.Str("Plan"))),
                                            ),
                                        ),
                                ),
                            ),
                    ),
                ),
                message.result,
            )
            assertNull(message.error)
            assertNull(message.jsonrpc)
        }

    @Test
    fun dispatchServerRequest_acceptsSnakeCaseStructuredUserInputMethod() =
        runBlocking {
            val pending =
                CompletableDeferred<
                    Pair<PendingStructuredInputRequest, (answersByQuestionId: Map<String, List<String>>) -> Unit>,
                >()
            val response = CompletableDeferred<RPCMessage>()
            newRouter(
                onStructuredInputRequest = { request, respond -> pending.complete(request to respond) },
            ).dispatchServerRequest(
                method = "request_user_input",
                requestId = JSONValue.Str("input-snake"),
                params =
                    JSONValue.Obj(
                        mapOf(
                            "questions" to
                                JSONValue.Arr(
                                    listOf(
                                        JSONValue.Obj(
                                            mapOf(
                                                "id" to JSONValue.Str("decision"),
                                                "question" to JSONValue.Str("Approve plan?"),
                                            ),
                                        ),
                                    ),
                                ),
                        ),
                    ),
                respond = { response.complete(it) },
            )

            val (request, respond) = withTimeout(ROUTER_TEST_TIMEOUT_MS) { pending.await() }
            assertEquals("decision", request.questions.single().id)
            respond(mapOf("decision" to listOf("yes")))

            val message = withTimeout(ROUTER_TEST_TIMEOUT_MS) { response.await() }
            assertEquals(JSONValue.Str("input-snake"), message.id)
            assertNull(message.error)
        }

    @Test
    fun dispatchServerRequest_appendsStructuredInputTimelineMarkerWhenThreadScoped() =
        runBlocking {
            val timeline = MessageTimelineStore()
            val pending =
                CompletableDeferred<
                    Pair<PendingStructuredInputRequest, (answersByQuestionId: Map<String, List<String>>) -> Unit>,
                >()
            val response = CompletableDeferred<RPCMessage>()
            newRouter(
                messageTimeline = timeline,
                onStructuredInputRequest = { request, respond -> pending.complete(request to respond) },
            ).dispatchServerRequest(
                method = "item/tool/requestUserInput",
                requestId = JSONValue.Str("input-timeline"),
                params =
                    JSONValue.Obj(
                        mapOf(
                            "threadId" to JSONValue.Str("thr-structured"),
                            "turnId" to JSONValue.Str("turn-si"),
                            "questions" to
                                JSONValue.Arr(
                                    listOf(
                                        JSONValue.Obj(
                                            mapOf(
                                                "id" to JSONValue.Str("mode"),
                                                "header" to JSONValue.Str("Mode"),
                                                "question" to JSONValue.Str("Choose speed"),
                                                "options" to JSONValue.Arr(emptyList()),
                                            ),
                                        ),
                                    ),
                                ),
                        ),
                    ),
                respond = { response.complete(it) },
            )

            val (request, respond) = withTimeout(ROUTER_TEST_TIMEOUT_MS) { pending.await() }
            val row = timeline.messagesByThread.value["thr-structured"]?.singleOrNull()
            assertNotNull(row)
            assertEquals(CodexMessageKind.userInputPrompt, row.kind)
            assertEquals(request.id, row.id)
            assertEquals("Choose speed", row.text)

            respond(mapOf("mode" to listOf("fast")))
            withTimeout(ROUTER_TEST_TIMEOUT_MS) { response.await() }
            Unit
        }

    @Test
    fun dispatchServerRequest_rejectsUnsupportedServerRequest() =
        runBlocking {
            val response =
                routerResponseFor(
                    method = "item/tool/unsupported",
                    requestId = JSONValue.Str("unsupported-1"),
                )

            assertEquals(JSONValue.Str("unsupported-1"), response.id)
            assertEquals(-32601, response.error?.code)
            assertNull(response.jsonrpc)
        }
}
