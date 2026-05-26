package com.dotbrains.agnt.mobile.ui.shell

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class GitStackedActionWireTest {
    @Test
    fun toStackedWireAction_mapsCommitPushPr() {
        assertEquals("commit_push_pr", GitActionNextStep.commitPushAndPullRequest.toStackedWireAction())
    }

    @Test
    fun involvesNativePullRequest_includesCreatePr() {
        assertTrue(GitActionNextStep.createPullRequest.involvesNativePullRequest())
        assertFalse(GitActionNextStep.commit.involvesNativePullRequest())
    }
}
