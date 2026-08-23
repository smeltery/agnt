package com.smeltery.agnt.mobile.data

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class GitCommitMessageResolverTest {
    @Test
    fun agntResolveCommitMessage_returnsRawWhenProvided() =
        runTest {
            assertEquals(
                "Hello",
                agntResolveCommitMessage("  Hello  ") { error("should not be called") },
            )
        }

    @Test
    fun agntResolveCommitMessage_usesGeneratedDraftWhenRawBlank() =
        runTest {
            assertEquals(
                "Update git flow\n\n- Draft",
                agntResolveCommitMessage("   ") { "Update git flow\n\n- Draft" },
            )
        }

    @Test
    fun agntResolveCommitMessage_returnsNullWhenGeneratedDraftBlank() =
        runTest {
            assertNull(agntResolveCommitMessage("") { "   " })
        }
}
