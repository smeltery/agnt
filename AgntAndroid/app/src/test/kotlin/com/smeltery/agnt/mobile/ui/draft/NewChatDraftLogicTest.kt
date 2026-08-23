package com.smeltery.agnt.mobile.ui.draft

import com.smeltery.agnt.mobile.core.model.GitChangedFile
import com.smeltery.agnt.mobile.core.model.GitRepoSyncResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NewChatDraftLogicTest {
    @Test
    fun gitActionsEnabled_onlyWhenProjectSelectedAndConnected() {
        assertFalse(NewChatDraftLogic.gitActionsEnabled(projectPath = null, isConnected = true))
        assertFalse(NewChatDraftLogic.gitActionsEnabled(projectPath = "/repo", isConnected = false))
        assertTrue(NewChatDraftLogic.gitActionsEnabled(projectPath = "/repo", isConnected = true))
    }

    @Test
    fun terminalHereHint_formatsCdCommand() {
        assertEquals("cd /repo", NewChatDraftLogic.terminalHereHint("/repo"))
        assertEquals(null, NewChatDraftLogic.terminalHereHint(null))
    }

    @Test
    fun gitStatusSummary_describesBranchChangesAndSyncState() {
        val status =
            GitRepoSyncResult(
                repoRoot = "/repo",
                currentBranch = "main",
                trackingBranch = "origin/main",
                isDirty = true,
                aheadCount = 1,
                behindCount = 2,
                localOnlyCommitCount = 0,
                state = "diverged",
                canPush = true,
                isPublishedToRemote = true,
                files =
                    listOf(
                        GitChangedFile(path = "a.kt", status = "modified"),
                        GitChangedFile(path = "b.kt", status = "added"),
                    ),
                repoDiffTotals = null,
            )

        assertEquals("main - 2 changed files - 1 ahead, 2 behind", NewChatDraftLogic.gitStatusSummary(status))
    }

    @Test
    fun gitStatusSummary_reportsNonRepository() {
        val status =
            GitRepoSyncResult(
                repoRoot = null,
                currentBranch = null,
                trackingBranch = null,
                isDirty = false,
                aheadCount = 0,
                behindCount = 0,
                localOnlyCommitCount = 0,
                state = "not_repo",
                canPush = false,
                isPublishedToRemote = false,
                files = emptyList(),
                repoDiffTotals = null,
                isRepo = false,
            )

        assertEquals("No Git repository found.", NewChatDraftLogic.gitStatusSummary(status))
    }
}
