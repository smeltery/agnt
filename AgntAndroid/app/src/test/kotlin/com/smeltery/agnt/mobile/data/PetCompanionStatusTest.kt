package com.smeltery.agnt.mobile.data

import com.smeltery.agnt.mobile.core.model.CodexMessage
import com.smeltery.agnt.mobile.core.model.CodexMessageKind
import com.smeltery.agnt.mobile.core.model.CodexMessageRole
import com.smeltery.agnt.mobile.core.model.CodexThread
import com.smeltery.agnt.mobile.core.model.PetCompanionPhase
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
        failed: Set<String> = emptySet(),
        ready: Set<String> = emptySet(),
        completionBanner: String? = null,
        approval: Boolean = false,
        approvalThread: String? = null,
        threads: List<CodexThread> = emptyList(),
        messages: Map<String, List<CodexMessage>> = emptyMap(),
    ) = PetCompanionStatusInputs(
        isConnected = connected,
        activeThreadId = active,
        runningThreadIds = running,
        failedThreadIds = failed,
        readyThreadIds = ready,
        completionBannerTitle = completionBanner,
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
    fun failedUsesLatestAssistantDetailAfterRunning() {
        val snapshot =
            derivePetStatusSnapshot(
                inputs(
                    active = "t1",
                    failed = setOf("t1"),
                    messages =
                        mapOf(
                            "t1" to
                                listOf(
                                    message("t1", CodexMessageRole.assistant, CodexMessageKind.chat, "Build failed"),
                                ),
                        ),
                ),
            )
        assertEquals(PetCompanionPhase.Failed, snapshot.phase)
        assertEquals("Needs a look", snapshot.title)
        assertEquals("Build failed", snapshot.detail)
    }

    @Test
    fun runningTakesPriorityOverFailed() {
        val snapshot = derivePetStatusSnapshot(inputs(running = setOf("t1"), failed = setOf("t1")))
        assertEquals(PetCompanionPhase.Running, snapshot.phase)
    }

    @Test
    fun completionBannerUsesReviewPhaseBeforeReadyThreads() {
        val snapshot =
            derivePetStatusSnapshot(
                inputs(
                    ready = setOf("t1"),
                    completionBanner = "Implemented sync",
                ),
            )
        assertEquals(PetCompanionPhase.Review, snapshot.phase)
        assertEquals("Done", snapshot.title)
        assertEquals("Implemented sync", snapshot.detail)
    }

    @Test
    fun readyThreadUsesReviewPhaseAndThreadTitleFallback() {
        val snapshot =
            derivePetStatusSnapshot(
                inputs(
                    ready = setOf("t1"),
                    threads = listOf(CodexThread(id = "t1", title = "Review patch")),
                ),
            )
        assertEquals(PetCompanionPhase.Review, snapshot.phase)
        assertEquals("Done", snapshot.title)
        assertEquals("Review patch", snapshot.detail)
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
