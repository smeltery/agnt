package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.CodexThreadGoal
import com.dotbrains.agnt.mobile.core.model.CodexThreadGoalStatus
import com.dotbrains.agnt.mobile.core.model.ContextWindowUsage
import com.dotbrains.agnt.mobile.core.model.JSONValue
import kotlinx.coroutines.flow.MutableStateFlow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class IncomingEventRouterNotificationTest {
    @Test
    fun dispatchNotification_routesRateLimitUpdates() {
        var updatedParams: Map<String, JSONValue>? = null
        val payload =
            mapOf(
                "rateLimits" to
                    JSONValue.Obj(
                        mapOf(
                            "primary" to
                                JSONValue.Obj(
                                    mapOf("usedPercent" to JSONValue.NumLong(34L)),
                                ),
                        ),
                    ),
            )

        newRouter(
            onRateLimitsUpdated = { params -> updatedParams = params },
        ).dispatchNotification(
            method = "account/rateLimits/updated",
            params = JSONValue.Obj(payload),
        )

        assertEquals(payload, updatedParams)
    }

    @Test
    fun dispatchNotification_systemNoticeForwardsFullEnvelope() {
        // Wire shape mirrors the bridge's opencode translator
        // (agnt-bridge/src/providers/opencode/translate.js#handleToastShow).
        var captured: Array<Any?>? = null
        newRouter(
            onSystemNotice = { severity, title, message, provider, threadId, durationMs ->
                captured = arrayOf(severity, title, message, provider, threadId, durationMs)
            },
        ).dispatchNotification(
            method = "system/notice",
            params =
                JSONValue.Obj(
                    mapOf(
                        "severity" to JSONValue.Str("warning"),
                        "title" to JSONValue.Str("MCP auth"),
                        "message" to JSONValue.Str("Re-auth required"),
                        "provider" to JSONValue.Str("opencode"),
                        "threadId" to JSONValue.Str("thr-fc"),
                        "durationMs" to JSONValue.NumLong(2_500L),
                    ),
                ),
        )

        val fields = captured
        assertNotNull(fields)
        assertEquals("warning", fields[0])
        assertEquals("MCP auth", fields[1])
        assertEquals("Re-auth required", fields[2])
        assertEquals("opencode", fields[3])
        assertEquals("thr-fc", fields[4])
        assertEquals(2_500L, fields[5])
    }

    @Test
    fun dispatchNotification_systemNoticeDropsPayloadWithNoTitleOrMessage() {
        // Bridge already guards this (handleToastShow returns early), but the
        // dispatcher must not invoke the callback either so the UI store can
        // assume non-empty input.
        var invoked = false
        newRouter(
            onSystemNotice = { _, _, _, _, _, _ -> invoked = true },
        ).dispatchNotification(
            method = "system/notice",
            params = JSONValue.Obj(mapOf("severity" to JSONValue.Str("info"))),
        )
        assertEquals(false, invoked)
    }

    @Test
    fun dispatchNotification_threadTokenUsageUpdated_emitsDecodedUsage() {
        var captured: Pair<String, ContextWindowUsage>? = null
        newRouter(
            onThreadContextUsageLive = { tid, u -> captured = tid to u },
        ).dispatchNotification(
            method = "thread/tokenUsage/updated",
            params =
                JSONValue.Obj(
                    mapOf(
                        "threadId" to JSONValue.Str("thr-live"),
                        "usage" to
                            JSONValue.Obj(
                                mapOf(
                                    "tokensUsed" to JSONValue.NumLong(17),
                                    "tokenLimit" to JSONValue.NumLong(258),
                                ),
                            ),
                    ),
                ),
        )
        assertEquals("thr-live", captured?.first)
        assertEquals(17, captured?.second?.tokensUsed)
        assertEquals(258, captured?.second?.tokenLimit)
    }

    @Test
    fun dispatchNotification_threadGoalUpdated_emitsDecodedGoal() {
        var captured: CodexThreadGoal? = null
        newRouter(
            onThreadGoalUpdated = { captured = it },
        ).dispatchNotification(
            method = "thread/goal/updated",
            params =
                JSONValue.Obj(
                    mapOf(
                        "goal" to
                            JSONValue.Obj(
                                mapOf(
                                    "threadId" to JSONValue.Str("thr-goal"),
                                    "objective" to JSONValue.Str("Keep going"),
                                    "status" to JSONValue.Str("active"),
                                ),
                            ),
                    ),
                ),
        )

        assertEquals("thr-goal", captured?.threadId)
        assertEquals("Keep going", captured?.objective)
        assertEquals(CodexThreadGoalStatus.Active, captured?.status)
    }

    @Test
    fun dispatchNotification_threadGoalCleared_emitsThreadId() {
        var captured: String? = null
        newRouter(
            onThreadGoalCleared = { captured = it },
        ).dispatchNotification(
            method = "thread/goal/cleared",
            params = JSONValue.Obj(mapOf("threadId" to JSONValue.Str("thr-goal"))),
        )

        assertEquals("thr-goal", captured)
    }

    @Test
    fun dispatchNotification_codexEventEnvelope_token_count_emitsUsage() {
        var captured: Pair<String, ContextWindowUsage>? = null
        newRouter(
            onThreadContextUsageLive = { tid, u -> captured = tid to u },
        ).dispatchNotification(
            method = "codex/event",
            params =
                JSONValue.Obj(
                    mapOf(
                        "msg" to
                            JSONValue.Obj(
                                mapOf(
                                    "type" to JSONValue.Str("token_count"),
                                    "threadId" to JSONValue.Str("thr-env"),
                                    "info" to
                                        JSONValue.Obj(
                                            mapOf(
                                                "total_tokens" to JSONValue.NumLong(42),
                                                "model_context_window" to JSONValue.NumLong(400),
                                            ),
                                        ),
                                ),
                            ),
                    ),
                ),
        )
        assertEquals("thr-env", captured?.first)
        assertEquals(42, captured?.second?.tokensUsed)
        assertEquals(400, captured?.second?.tokenLimit)
    }

    @Test
    fun dispatchNotification_codex_event_named_token_count_emitsUsage() {
        var captured: Pair<String, ContextWindowUsage>? = null
        newRouter(
            onThreadContextUsageLive = { tid, u -> captured = tid to u },
            resolveAmbiguousUsageThreadId = { "solo-thread" },
        ).dispatchNotification(
            method = "codex/event/token_count",
            params =
                JSONValue.Obj(
                    mapOf(
                        "msg" to
                            JSONValue.Obj(
                                mapOf(
                                    "info" to
                                        JSONValue.Obj(
                                            mapOf(
                                                "total_tokens" to JSONValue.NumLong(7),
                                                "model_context_window" to JSONValue.NumLong(70),
                                            ),
                                        ),
                                ),
                            ),
                    ),
                ),
        )
        assertEquals("solo-thread", captured?.first)
        assertEquals(7, captured?.second?.tokensUsed)
    }

    @Test
    fun dispatchNotification_threadTokenUsageUpdated_missingThreadId_doesNotEmit() {
        var callCount = 0
        newRouter(
            onThreadContextUsageLive = { _, _ -> callCount++ },
        ).dispatchNotification(
            method = "thread/tokenUsage/updated",
            params =
                JSONValue.Obj(
                    mapOf(
                        "usage" to
                            JSONValue.Obj(
                                mapOf(
                                    "tokensUsed" to JSONValue.NumLong(1),
                                    "tokenLimit" to JSONValue.NumLong(2),
                                ),
                            ),
                    ),
                ),
        )
        assertEquals(0, callCount)
    }

    @Test
    fun dispatchNotification_threadTokenUsageUpdated_nonObjectUsage_doesNotEmit() {
        var callCount = 0
        newRouter(
            onThreadContextUsageLive = { _, _ -> callCount++ },
        ).dispatchNotification(
            method = "thread/tokenUsage/updated",
            params =
                JSONValue.Obj(
                    mapOf(
                        "threadId" to JSONValue.Str("thr-x"),
                        "usage" to JSONValue.Str("nope"),
                    ),
                ),
        )
        assertEquals(0, callCount)
    }

    @Test
    fun dispatchNotification_threadNameUpdated_updatesTitleWhenNoLocalRename() {
        val threads = MutableStateFlow(listOf(CodexThread(id = "thread-1", title = "Conversation")))
        newRouter(threads = threads).dispatchNotification(
            method = "thread/name/updated",
            params =
                JSONValue.Obj(
                    mapOf(
                        "threadId" to JSONValue.Str("thread-1"),
                        "name" to JSONValue.Str("Server Rename"),
                    ),
                ),
        )

        assertEquals("Server Rename", threads.value.single().displayTitle)
    }

    @Test
    fun dispatchNotification_threadNameUpdated_doesNotOverwritePersistedLocalRename() {
        val threads = MutableStateFlow(listOf(CodexThread(id = "thread-1", title = "Phone Rename", name = "Phone Rename")))
        newRouter(
            threads = threads,
            persistedThreadRename = { tid -> if (tid == "thread-1") "Phone Rename" else null },
        ).dispatchNotification(
            method = "thread/name/updated",
            params =
                JSONValue.Obj(
                    mapOf(
                        "threadId" to JSONValue.Str("thread-1"),
                        "name" to JSONValue.Str("Server Rename"),
                    ),
                ),
        )

        assertEquals("Phone Rename", threads.value.single().displayTitle)
    }

    @Test
    fun dispatchNotification_threadNameUpdated_emptyNameClearsTitleWithoutLocalRename() {
        val threads = MutableStateFlow(listOf(CodexThread(id = "thread-1", title = "Server Rename", name = "Server Rename")))
        newRouter(threads = threads).dispatchNotification(
            method = "thread/name/updated",
            params =
                JSONValue.Obj(
                    mapOf(
                        "threadId" to JSONValue.Str("thread-1"),
                        "name" to JSONValue.Str("   "),
                    ),
                ),
        )

        assertEquals(CodexThread.DEFAULT_DISPLAY_TITLE, threads.value.single().displayTitle)
        assertNull(threads.value.single().name)
        assertNull(threads.value.single().title)
    }
}
