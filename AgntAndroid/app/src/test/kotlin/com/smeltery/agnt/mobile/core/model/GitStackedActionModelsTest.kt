package com.smeltery.agnt.mobile.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class GitStackedActionModelsTest {
    @Test
    fun runStackedActionResult_parsesPullRequest() {
        val result =
            GitRunStackedActionResult.fromJson(
                mapOf(
                    "action" to JSONValue.Str("commit_push_pr"),
                    "pr" to
                        JSONValue.Obj(
                            mapOf(
                                "status" to JSONValue.Str("created"),
                                "number" to JSONValue.NumLong(42),
                                "url" to JSONValue.Str("https://github.com/org/repo/pull/42"),
                                "title" to JSONValue.Str("Stacked PR"),
                            ),
                        ),
                ),
            )
        assertEquals("commit_push_pr", result.action)
        assertEquals("created", result.pullRequest?.status)
        assertEquals(42, result.pullRequest?.number)
    }

    @Test
    fun pullRequestResult_skipsNotRequested() {
        assertNull(
            GitPullRequestActionResult.fromJson(
                mapOf("status" to JSONValue.Str("skipped_not_requested")),
            ),
        )
    }
}
