package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import com.dotbrains.agnt.mobile.core.model.CodexSubagentAction
import com.dotbrains.agnt.mobile.core.model.CodexSubagentRef
import com.dotbrains.agnt.mobile.core.model.CodexSubagentState
import org.junit.Test
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TurnTimelineActionParserTest {
    @Test
    fun parseSubagent_withoutStructuredAction_usesFirstNonBlankLine() {
        val message =
            CodexMessage(
                threadId = "thread-1",
                role = CodexMessageRole.system,
                kind = CodexMessageKind.subagentAction,
                text =
                    """
					
					Agent finished

					Reviewed 3 files
                    """.trimIndent(),
                createdAt = Instant.parse("2024-01-01T00:00:00Z"),
            )

        val preview = TurnTimelineRichContentParser.parseSubagent(message)

        assertEquals("Agent finished", preview.headline)
        assertEquals("Agent finished\n\nReviewed 3 files", preview.summaryText)
        assertEquals(null, preview.promptText)
        assertTrue(preview.agents.isEmpty())
    }

    @Test
    fun parseSubagent_usesStructuredMetadataAndFallbackText() {
        val message =
            CodexMessage(
                threadId = "thread-1",
                role = CodexMessageRole.system,
                kind = CodexMessageKind.subagentAction,
                text = "Subagent activity",
                createdAt = Instant.parse("2024-01-01T00:00:00Z"),
                subagentAction =
                    CodexSubagentAction(
                        tool = "send_input",
                        status = "   ",
                        prompt = "  Review the diff  ",
                        receiverThreadIds = listOf("sub-1"),
                        receiverAgents =
                            listOf(
                                CodexSubagentRef(
                                    threadId = "sub-1",
                                    nickname = " Worker ",
                                    role = " reviewer ",
                                    model = " gpt-5 ",
                                ),
                            ),
                        agentStates =
                            mapOf(
                                "sub-1" to
                                    CodexSubagentState(
                                        threadId = "sub-1",
                                        status = " running ",
                                        message = " Booting ",
                                    ),
                            ),
                    ),
            )

        val preview = TurnTimelineRichContentParser.parseSubagent(message)

        assertEquals("Updating agent", preview.headline)
        assertEquals("Updating agent", preview.summaryText)
        assertEquals("Review the diff", preview.promptText)
        assertEquals(1, preview.agents.size)
        assertEquals("Worker [reviewer]", preview.agents.single().label)
        assertEquals("gpt-5", preview.agents.single().model)
        assertEquals("running", preview.agents.single().status)
        assertEquals("Booting", preview.agents.single().message)
    }

    @Test
    fun parseCommandExecution_extractsPhaseCommandAndOutput() {
        val message =
            CodexMessage(
                threadId = "thread-1",
                role = CodexMessageRole.system,
                kind = CodexMessageKind.commandExecution,
                text =
                    """
					failed ./gradlew testDebugUnitTest
					Task :app:testDebugUnitTest FAILED
                    """.trimIndent(),
                createdAt = Instant.parse("2024-01-01T00:00:00Z"),
            )

        val preview = TurnTimelineRichContentParser.parseCommandExecution(message)

        assertEquals("failed", preview.phase)
        assertEquals("./gradlew testDebugUnitTest", preview.command)
        assertEquals("Task :app:testDebugUnitTest FAILED", preview.outputText)
        assertTrue(preview.isFailure)
    }

    @Test
    fun parseCommandExecution_extractsMetadataLines() {
        val message =
            CodexMessage(
                threadId = "thread-1",
                role = CodexMessageRole.system,
                kind = CodexMessageKind.commandExecution,
                text =
                    """
					completed bash -lc "cd /repo && ./gradlew test"
					cwd: /repo/android
					exitCode: 0
					duration: 2.5s
					BUILD SUCCESSFUL
                    """.trimIndent(),
                createdAt = Instant.parse("2024-01-01T00:00:00Z"),
            )

        val preview = TurnTimelineRichContentParser.parseCommandExecution(message)

        assertEquals("completed", preview.phase)
        assertEquals("""bash -lc "cd /repo && ./gradlew test"""", preview.command)
        assertEquals("/repo/android", preview.cwd)
        assertEquals(0, preview.exitCode)
        assertEquals(2500, preview.durationMs)
        assertEquals("BUILD SUCCESSFUL", preview.outputText)
    }

    @Test
    fun parseCommandExecution_inlinedPhaseChevron_sameAsSpaceSeparatedPhase() {
        val chevron =
            CodexMessage(
                threadId = "thread-1",
                role = CodexMessageRole.system,
                kind = CodexMessageKind.commandExecution,
                text = """completed> bash -lc "cd /repo && ./gradlew test"""",
                createdAt = Instant.parse("2024-01-01T00:00:00Z"),
            )
        val spaced =
            CodexMessage(
                threadId = "thread-1",
                role = CodexMessageRole.system,
                kind = CodexMessageKind.commandExecution,
                text = """completed bash -lc "cd /repo && ./gradlew test"""",
                createdAt = Instant.parse("2024-01-01T00:00:00Z"),
            )

        val a = TurnTimelineRichContentParser.parseCommandExecution(chevron)
        val b = TurnTimelineRichContentParser.parseCommandExecution(spaced)

        assertEquals(b.command, a.command)
        assertEquals("completed", a.phase)
        assertEquals("completed", b.phase)
    }

    @Test
    fun parseCommandExecution_usesStreamingStateWhenPhaseIsMissing() {
        val message =
            CodexMessage(
                threadId = "thread-1",
                role = CodexMessageRole.system,
                kind = CodexMessageKind.commandExecution,
                text = "npm start",
                createdAt = Instant.parse("2024-01-01T00:00:00Z"),
                isStreaming = true,
            )

        val preview = TurnTimelineRichContentParser.parseCommandExecution(message)

        assertEquals("running", preview.phase)
        assertEquals("npm start", preview.command)
        assertEquals(null, preview.outputText)
        assertTrue(preview.isRunning)
    }
}
