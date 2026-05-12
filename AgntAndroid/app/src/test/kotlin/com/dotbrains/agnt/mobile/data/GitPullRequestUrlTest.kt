package com.dotbrains.agnt.mobile.data

import kotlin.test.Test
import kotlin.test.assertEquals

class GitPullRequestUrlTest {
    @Test
    fun agntBuildPullRequestUrl_buildsPlainCompareWhenTitleAndBodyBlank() {
        assertEquals(
            "https://github.com/remodex/remodex/compare/main...feature?expand=1",
            agntBuildPullRequestUrl(
                ownerRepo = "remodex/remodex",
                branch = "feature",
                base = "main",
                title = "   ",
                body = "",
            ),
        )
    }

    @Test
    fun agntBuildPullRequestUrl_encodesQueryParamsWhenPrefillPresent() {
        assertEquals(
            "https://github.com/remodex/remodex/compare/main...feature?quick_pull=1&title=Fix%20login&body=Line%201%0ALine%202",
            agntBuildPullRequestUrl(
                ownerRepo = "remodex/remodex",
                branch = "feature",
                base = "main",
                title = "Fix login",
                body = "Line 1\nLine 2",
            ),
        )
    }
}

