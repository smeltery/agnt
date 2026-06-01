package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.PetCompanionPhase
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

class PetCompanionStatusTest {
    private fun message(
        threadId: String,
        role: CodexMessageRole,
        kind: CodexMessageKind,
        text: String,
        streaming: Boolean = false,
    ) = CodexMessage(
        threadId = threadId,
        role = role,
        kind = kind,
        text = text,
        createdAt = Instant.EPOCH,
        isStreaming = streaming,
    )

    private fun inputs(
        connected: Boolean = true,
        active: String? = null,
        running: Set<String> = emptySet(),
        approval: Boolean = false,
        approvalThread: String? = null,
        threads: List<CodexThread> = emptyList(),
        messages: Map<String, List<CodexMessage>> = emptyMap(),
    ) = PetCompanionStatusInputs(
        isConnected = connected,
        activeThreadId = active,
        runningThreadIds = running,
        hasPendingApproval = approval,
        pendingApprovalThreadId = approvalThread,
        threads = threads,
        messagesByThread = messages,
    )

    @Test
    fun disconnectedIsIdle() {
        assertEquals(PetCompanionPhase.Idle, derivePetStatusSnapshot(inputs(connected = false)).phase)
    }

    @Test
    fun noWorkIsIdle() {
        assertEquals(PetCompanionPhase.Idle, derivePetStatusSnapshot(inputs()).phase)
    }

    @Test
    fun approvalTakesPriorityOverRunning() {
        val snapshot =
            derivePetStatusSnapshot(
                inputs(running = setOf("t1"), approval = true, approvalThread = "t1"),
            )
        assertEquals(PetCompanionPhase.Waiting, snapshot.phase)
        assertEquals("Approval needed", snapshot.title)
    }

    @Test
    fun runningUsesLatestActivityAsDetail() {
        val snapshot =
            derivePetStatusSnapshot(
                inputs(
                    active = "t1",
                    running = setOf("t1"),
                    messages =
                        mapOf(
                            "t1" to
                                listOf(
                                    message("t1", CodexMessageRole.user, CodexMessageKind.chat, "hello"),
                                    message("t1", CodexMessageRole.assistant, CodexMessageKind.commandExecution, "ls", streaming = true),
                                ),
                        ),
                ),
            )
        assertEquals(PetCompanionPhase.Running, snapshot.phase)
        assertEquals("Working", snapshot.title)
        assertEquals("Running command", snapshot.detail)
    }

    @Test
    fun multipleRunningThreadsCountInTitle() {
        val snapshot = derivePetStatusSnapshot(inputs(running = setOf("a", "b", "c")))
        assertEquals(PetCompanionPhase.Running, snapshot.phase)
        assertEquals("Working 3 chats", snapshot.title)
    }

    @Test
    fun longPromptsAreTruncated() {
        val long = "x".repeat(80)
        val sanitized = sanitizedPetPrompt(long)
        assertEquals(52, sanitized?.length) // 49 chars + "..."
    }

    @Test
    fun markdownNoiseStrippedFromPrompt() {
        assertEquals("bold heading", sanitizedPetPrompt("**bold** `heading`#"))
    }
}
