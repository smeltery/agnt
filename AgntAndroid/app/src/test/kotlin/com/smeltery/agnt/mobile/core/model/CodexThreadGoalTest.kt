package com.smeltery.agnt.mobile.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class CodexThreadGoalTest {
    @Test
    fun decodesGoalEnvelope() {
        val goal =
            CodexThreadGoal.fromEnvelope(
                mapOf(
                    "goal" to
                        JSONValue.Obj(
                            mapOf(
                                "threadId" to JSONValue.Str("thread-1"),
                                "objective" to JSONValue.Str("Ship Android goals"),
                                "status" to JSONValue.Str("budget-limited"),
                                "tokenBudget" to JSONValue.NumLong(200_000),
                                "tokenUsage" to JSONValue.NumLong(125_500),
                            ),
                        ),
                ),
            )

        assertEquals("thread-1", goal?.threadId)
        assertEquals("Ship Android goals", goal?.objective)
        assertEquals(CodexThreadGoalStatus.BudgetLimited, goal?.status)
        assertEquals(200_000, goal?.tokenBudget)
        assertEquals(74_500, goal?.let(CodexThreadGoal::remainingBudget))
    }

    @Test
    fun decodesRootGoalObjectWithFallbackThreadId() {
        val goal =
            CodexThreadGoal.fromEnvelope(
                mapOf(
                    "objective" to JSONValue.Str("Continue until done"),
                    "status" to JSONValue.Str("DONE"),
                    "remaining_tokens" to JSONValue.Str("12,345"),
                ),
                fallbackThreadId = "fallback-thread",
            )

        assertEquals("fallback-thread", goal?.threadId)
        assertEquals(CodexThreadGoalStatus.Completed, goal?.status)
        assertEquals(12_345, goal?.remainingTokens)
    }

    @Test
    fun rejectsIncompleteGoal() {
        assertNull(
            CodexThreadGoal.fromEnvelope(
                mapOf(
                    "goal" to
                        JSONValue.Obj(
                            mapOf(
                                "threadId" to JSONValue.Str("thread-1"),
                                "objective" to JSONValue.Str("Missing status"),
                            ),
                        ),
                ),
            ),
        )
    }
}
