package com.smeltery.agnt.mobile.services

import com.smeltery.agnt.mobile.core.error.AgentServiceError
import com.smeltery.agnt.mobile.core.model.CodexReviewTarget
import com.smeltery.agnt.mobile.core.model.JSONValue
import com.smeltery.agnt.mobile.services.agent.review.buildReviewStartRequestParams
import com.smeltery.agnt.mobile.services.agent.review.normalizedReviewBaseBranch
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class AgentServiceReviewTest {
    @Test
    fun buildReviewStartRequestParams_uncommittedChanges_usesInlineTargetShape() {
        val params =
            buildReviewStartRequestParams(
                threadId = "thread-1",
                target = CodexReviewTarget.uncommittedChanges,
                baseBranch = null,
            )

        assertEquals("thread-1", params.map["threadId"]?.stringValue)
        assertEquals("inline", params.map["delivery"]?.stringValue)
        val target = params.map["target"] as JSONValue.Obj
        assertEquals("uncommittedChanges", target.map["type"]?.stringValue)
        assertEquals(setOf("type"), target.map.keys)
    }

    @Test
    fun buildReviewStartRequestParams_baseBranch_trimsAndValidates() {
        val params =
            buildReviewStartRequestParams(
                threadId = "thread-1",
                target = CodexReviewTarget.baseBranch,
                baseBranch = "  main  ",
            )

        val target = params.map["target"] as JSONValue.Obj
        assertEquals("baseBranch", target.map["type"]?.stringValue)
        assertEquals("main", target.map["branch"]?.stringValue)
        assertEquals("main", normalizedReviewBaseBranch("  main  "))

        assertFailsWith<AgentServiceError.InvalidInput> {
            buildReviewStartRequestParams(
                threadId = "thread-1",
                target = CodexReviewTarget.baseBranch,
                baseBranch = "   ",
            )
        }
        assertFailsWith<AgentServiceError.InvalidInput> {
            normalizedReviewBaseBranch(null)
        }
    }
}
