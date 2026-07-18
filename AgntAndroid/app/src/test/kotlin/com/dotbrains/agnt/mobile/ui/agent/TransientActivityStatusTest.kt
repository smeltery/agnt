package com.dotbrains.agnt.mobile.ui.agent

import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import kotlin.test.Test
import kotlin.test.assertEquals

class TransientActivityStatusTest {
    @Test
    fun transientActivityStatus_hidesWhileAssistantTextStreams() {
        val streaming =
            CodexMessage(
                id = "as",
                threadId = "t1",
                role = CodexMessageRole.assistant,
                kind = CodexMessageKind.chat,
                text = "streaming",
                createdAt = t0,
                turnId = "turn-1",
                isStreaming = true,
            )

        val status =
            listOf(streaming).deriveTransientActivityStatus(
                isThreadRunning = true,
                activeTurnId = "turn-1",
            )

        assertEquals(null, status)
    }

    @Test
    fun transientActivityStatus_derivesToolStates() {
        val checks =
            cmd("compile").copy(
                text = "running > ./gradlew test",
                turnId = "turn-1",
            )
        val diff =
            cmd("diff").copy(
                text = "running > git diff",
                turnId = "turn-1",
            )
        val edit =
            file("edit").copy(
                text = "android/app/src/main/kotlin/MainShell.kt +1 -1",
                turnId = "turn-1",
            )

        assertEquals(
            "running checks...",
            listOf(checks).deriveTransientActivityStatus(true, "turn-1"),
        )
        assertEquals(
            "checking changes...",
            listOf(diff).deriveTransientActivityStatus(true, "turn-1"),
        )
        assertEquals(
            "editing MainShell.kt...",
            listOf(edit).deriveTransientActivityStatus(true, "turn-1"),
        )
    }
}
