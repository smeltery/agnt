package com.dotbrains.agnt.mobile.data

import com.dotbrains.agnt.mobile.core.model.CodexMessage
import com.dotbrains.agnt.mobile.core.model.CodexMessageKind
import com.dotbrains.agnt.mobile.core.model.CodexMessageRole
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.PetCompanionPhase
import com.dotbrains.agnt.mobile.core.model.PetCompanionStatusSnapshot

/**
 * Captures only the pet-relevant slice of repository state so the overlay does not
 * subscribe to whole chat timelines (parity iOS `PetCompanionStatusSignature`).
 *
 * Android exposes a subset of iOS's per-thread status state: there is no
 * `failedThreadIDs` / `readyThreadIDs` / completion-banner stream yet, so the
 * derived snapshot supports idle / running / waiting phases and degrades the
 * failed/review phases until that state lands.
 */
data class PetCompanionStatusInputs(
    val isConnected: Boolean,
    val activeThreadId: String?,
    val runningThreadIds: Set<String>,
    val hasPendingApproval: Boolean,
    val pendingApprovalThreadId: String?,
    val threads: List<CodexThread>,
    val messagesByThread: Map<String, List<CodexMessage>>,
) {
    val hasRunningWork: Boolean
        get() = runningThreadIds.isNotEmpty()
}

/**
 * Resolves the pill phase + label from [PetCompanionStatusInputs]. Pure so JVM
 * unit tests can pin behavior without an Android runtime.
 */
fun derivePetStatusSnapshot(inputs: PetCompanionStatusInputs): PetCompanionStatusSnapshot {
    if (!inputs.isConnected) return PetCompanionStatusSnapshot.Idle

    if (inputs.hasPendingApproval) {
        val threadId = inputs.pendingApprovalThreadId
        return PetCompanionStatusSnapshot(
            phase = PetCompanionPhase.Waiting,
            title = "Approval needed",
            detail =
                threadId?.let {
                    petProgressPrompt(it, inputs, fallback = petThreadTitle(it, inputs), prefersActivity = true)
                } ?: "Waiting for you",
        )
    }

    preferredThreadId(inputs.runningThreadIds, inputs)?.let { threadId ->
        val count = inputs.runningThreadIds.size
        return PetCompanionStatusSnapshot(
            phase = PetCompanionPhase.Running,
            title = if (count > 1) "Working $count chats" else "Working",
            detail = petProgressPrompt(threadId, inputs, fallback = petThreadTitle(threadId, inputs), prefersActivity = true),
        )
    }

    return PetCompanionStatusSnapshot.Idle
}

private fun preferredThreadId(
    candidates: Set<String>,
    inputs: PetCompanionStatusInputs,
): String? {
    if (candidates.isEmpty()) return null
    inputs.activeThreadId?.let { if (candidates.contains(it)) return it }
    return inputs.threads.firstOrNull { candidates.contains(it.id) }?.id ?: candidates.sorted().firstOrNull()
}

private fun petThreadTitle(
    threadId: String,
    inputs: PetCompanionStatusInputs,
): String {
    val title =
        inputs.threads
            .firstOrNull { it.id == threadId }
            ?.displayTitle
            ?.trim()
    return title?.takeIf { it.isNotEmpty() } ?: "Chat"
}

internal fun petProgressPrompt(
    threadId: String,
    inputs: PetCompanionStatusInputs,
    fallback: String,
    prefersActivity: Boolean,
): String {
    val recent = (inputs.messagesByThread[threadId] ?: emptyList()).takeLast(12).asReversed()
    for (message in recent) {
        if (message.role == CodexMessageRole.user) continue
        if (prefersActivity && message.kind == CodexMessageKind.chat && !message.isStreaming) continue
        petPrompt(message)?.let { return it }
    }
    return fallback
}

private fun petPrompt(message: CodexMessage): String? =
    when (message.kind) {
        CodexMessageKind.commandExecution -> if (message.isStreaming) "Running command" else "Ran command"
        CodexMessageKind.fileChange -> if (message.isStreaming) "Editing files" else "Edited files"
        CodexMessageKind.subagentAction -> sanitizedPetPrompt(message.text) ?: "Working with an agent"
        CodexMessageKind.thinking -> sanitizedPetPrompt(message.text) ?: "Thinking"
        CodexMessageKind.plan -> sanitizedPetPrompt(message.text) ?: "Planning"
        CodexMessageKind.userInputPrompt -> "Waiting for you"
        CodexMessageKind.pendingApproval -> "Waiting for you"
        CodexMessageKind.chat -> sanitizedPetPrompt(message.text)
    }

internal fun sanitizedPetPrompt(rawText: String): String? {
    val trimmed =
        rawText
            .replace("\n", " ")
            .replace("`", "")
            .replace("*", "")
            .replace("#", "")
            .trim()
    if (trimmed.isEmpty()) return null
    if (trimmed.length <= 52) return trimmed
    return trimmed.take(49).trim() + "..."
}
