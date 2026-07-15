package com.dotbrains.agnt.mobile.services.agent.threads

import com.dotbrains.agnt.mobile.core.error.AgentServiceError
import com.dotbrains.agnt.mobile.core.model.CodexCollaborationModeKind
import com.dotbrains.agnt.mobile.core.model.CodexImageAttachment
import com.dotbrains.agnt.mobile.core.model.CodexMessageDeliveryState
import com.dotbrains.agnt.mobile.core.model.CodexThreadSyncState
import com.dotbrains.agnt.mobile.core.model.CodexTurnMention
import com.dotbrains.agnt.mobile.core.model.CodexTurnSkillMention
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.RPCMessage
import com.dotbrains.agnt.mobile.core.model.isExplicitServerThreadMissing
import com.dotbrains.agnt.mobile.data.extractTurnIdFromRpcResult
import com.dotbrains.agnt.mobile.services.agent.AgentService
import com.dotbrains.agnt.mobile.services.agent.connection.ensureThreadResumedInternal
import com.dotbrains.agnt.mobile.services.agent.runtime.TurnStartEffortWireMode
import com.dotbrains.agnt.mobile.services.agent.runtime.markServiceTierUnsupportedForCurrentBridge
import com.dotbrains.agnt.mobile.services.agent.runtime.publishThreads
import com.dotbrains.agnt.mobile.services.agent.runtime.selectedReasoningEffortForSelectedModel
import com.dotbrains.agnt.mobile.services.agent.runtime.sendRequestWithSandboxAndApprovalFallback
import com.dotbrains.agnt.mobile.services.agent.runtime.shouldRetryTurnStartEffortKeyAlias
import com.dotbrains.agnt.mobile.services.agent.runtime.shouldRetryTurnStartWithoutServiceTier
import com.dotbrains.agnt.mobile.services.agent.runtime.shouldWireServiceTier
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Instant

/**
 * Invio turno utente via `turn/start` (parity con [AgentService.sendTurnStart] in
 * [AgentService+ThreadsTurns.swift](../../../../../../../../CodexMobile/CodexMobile/Services/AgentService+ThreadsTurns.swift)).
 * J.2/J.6/J.7a: testo + immagini; sandboxPolicy/sandbox/minimal + approvalPolicy candidates + effort key alias come iOS.
 */
internal suspend fun AgentService.startTurnInternal(
    threadId: String,
    userText: String,
    attachments: List<CodexImageAttachment> = emptyList(),
    skillMentions: List<CodexTurnSkillMention> = emptyList(),
    fileMentions: List<CodexTurnMention> = emptyList(),
    collaborationMode: CodexCollaborationModeKind? = null,
) {
    if (!sessionReady) throw AgentServiceError.Disconnected
    val tid = threadId.trim()
    val trimmed = userText.trim()
    val readyAttachments =
        attachments.filter { attachment ->
            !attachment.payloadDataURL.isNullOrBlank()
        }
    if (tid.isEmpty()) throw AgentServiceError.InvalidInput("Missing thread id")
    if (trimmed.isEmpty() && readyAttachments.isEmpty()) {
        throw AgentServiceError.InvalidInput("Message is empty")
    }

    var targetThreadId = tid
    var imageUrlKey = "url"

    suspend fun resumeTargetOrThrow() {
        val row = _threads.value.find { it.id == targetThreadId }
        try {
            ensureThreadResumedInternal(
                threadId = targetThreadId,
                force = false,
                preferredProjectPath = row?.gitWorkingDirectory,
                modelIdentifierOverride = row?.model,
            )
        } catch (e: Exception) {
            if (!shouldAllowProjectRebindWithoutResume(e)) throw e
        }
    }

    suspend fun continuationAfterExplicitMissing(archivedId: String) {
        val prior = _threads.value.find { it.id == archivedId }
        handleMissingThread(archivedId)
        val continuation =
            try {
                createContinuationThreadInternal(archivedId, prior)
            } catch (_: Throwable) {
                throw AgentServiceError.ThreadRemovedOnServer
            }
        targetThreadId = continuation.id
        try {
            ensureThreadResumedInternal(
                threadId = targetThreadId,
                force = false,
                preferredProjectPath = continuation.gitWorkingDirectory,
                modelIdentifierOverride = continuation.model,
            )
        } catch (e: AgentServiceError.RpcFailure) {
            if (e.rpcError.isExplicitServerThreadMissing()) {
                handleMissingThread(targetThreadId)
                throw AgentServiceError.ThreadRemovedOnServer
            }
            throw e
        }
    }

    try {
        resumeTargetOrThrow()
    } catch (e: AgentServiceError.RpcFailure) {
        if (!e.rpcError.isExplicitServerThreadMissing()) throw e
        continuationAfterExplicitMissing(targetThreadId)
    }

    val automaticTitleSeed = automaticThreadTitleSeedIfNeeded(trimmed, readyAttachments, targetThreadId)
    val pendingId = messageTimelineStore.appendPendingUserMessage(targetThreadId, trimmed, readyAttachments)

    suspend fun sendTurnStartWithImageFallback(threadId: String): RPCMessage {
        var effectiveCollaborationMode = collaborationMode?.takeIf { supportsTurnCollaborationMode }
        var includeStructuredSkillItems = supportsStructuredSkillInput && skillMentions.isNotEmpty()
        var includeStructuredMentionItems = supportsStructuredMentionInput && fileMentions.isNotEmpty()
        var includesServiceTier = shouldWireServiceTier(supportsServiceTier, _selectedServiceTier.value != null)
        var effortWireMode: TurnStartEffortWireMode? =
            selectedReasoningEffortForSelectedModel()?.let { TurnStartEffortWireMode.UseEffort }
        var didDowngradePlanModeForRuntime = false
        while (true) {
            val params =
                buildTurnStartRequestParams(
                    threadId = threadId,
                    userText = trimmed,
                    attachments = readyAttachments,
                    skillMentions = skillMentions,
                    fileMentions = fileMentions,
                    includeStructuredSkillItems = includeStructuredSkillItems,
                    includeStructuredMentionItems = includeStructuredMentionItems,
                    imageUrlKey = imageUrlKey,
                    collaborationMode = effectiveCollaborationMode,
                    includesServiceTier = includesServiceTier,
                    effortWireMode = effortWireMode,
                )
            try {
                val response = sendRequestWithSandboxAndApprovalFallback("turn/start", params)
                if (didDowngradePlanModeForRuntime) {
                    messageTimelineStore.appendSystemLine(
                        threadId = threadId,
                        turnId = null,
                        text = "Plan mode is not supported by this runtime. Sent as a normal turn instead.",
                    )
                }
                return response
            } catch (e: Throwable) {
                if (imageUrlKey == "url" &&
                    readyAttachments.isNotEmpty() &&
                    shouldRetryTurnStartWithImageURLField(e)
                ) {
                    imageUrlKey = "image_url"
                    continue
                }
                if (effectiveCollaborationMode != null &&
                    shouldRetryTurnStartWithoutCollaborationMode(e)
                ) {
                    supportsTurnCollaborationMode = false
                    effectiveCollaborationMode = null
                    didDowngradePlanModeForRuntime = true
                    continue
                }
                if (includeStructuredSkillItems && shouldRetryTurnStartWithoutSkillItems(e)) {
                    supportsStructuredSkillInput = false
                    includeStructuredSkillItems = false
                    continue
                }
                if (includeStructuredMentionItems && shouldRetryTurnStartWithoutMentionItems(e)) {
                    supportsStructuredMentionInput = false
                    includeStructuredMentionItems = false
                    continue
                }
                if (includesServiceTier && shouldRetryTurnStartWithoutServiceTier(e)) {
                    markServiceTierUnsupportedForCurrentBridge()
                    includesServiceTier = false
                    continue
                }
                if (effortWireMode == TurnStartEffortWireMode.UseEffort &&
                    shouldRetryTurnStartEffortKeyAlias(e, TurnStartEffortWireMode.UseEffort)
                ) {
                    effortWireMode = TurnStartEffortWireMode.UseReasoningEffort
                    continue
                }
                throw e
            }
        }
    }

    try {
        _activeThreadId.value = targetThreadId
        sessionPersistence.saveLastActiveThreadId(targetThreadId)
        noteProtectedRunningFallback(targetThreadId, true)
        val response = sendTurnStartWithImageFallback(targetThreadId)
        markTurnStartAccepted(targetThreadId, pendingId, response)
        scheduleAutomaticThreadTitleGenerationIfNeeded(automaticTitleSeed, targetThreadId, readyAttachments)
    } catch (e: Throwable) {
        noteTurnFinished(targetThreadId)
        if (e is AgentServiceError.RpcFailure && e.rpcError.isExplicitServerThreadMissing()) {
            continuationAfterExplicitMissing(targetThreadId)
            val newId = targetThreadId
            val retryAutomaticTitleSeed = automaticThreadTitleSeedIfNeeded(trimmed, readyAttachments, newId)
            val retryPendingId = messageTimelineStore.appendPendingUserMessage(newId, trimmed, readyAttachments)
            try {
                _activeThreadId.value = newId
                sessionPersistence.saveLastActiveThreadId(newId)
                noteProtectedRunningFallback(newId, true)
                val response = sendTurnStartWithImageFallback(newId)
                markTurnStartAccepted(newId, retryPendingId, response)
                scheduleAutomaticThreadTitleGenerationIfNeeded(retryAutomaticTitleSeed, newId, readyAttachments)
            } catch (e2: Throwable) {
                noteTurnFinished(newId)
                runCatching {
                    messageTimelineStore.markUserMessageOutcome(
                        threadId = newId,
                        messageId = retryPendingId,
                        deliveryState = CodexMessageDeliveryState.failed,
                        turnId = null,
                    )
                }
                if (e2 is AgentServiceError.RpcFailure && e2.rpcError.isExplicitServerThreadMissing()) {
                    handleMissingThread(newId)
                    throw AgentServiceError.ThreadRemovedOnServer
                }
                throw e2
            }
            return
        }
        runCatching {
            messageTimelineStore.markUserMessageOutcome(
                threadId = targetThreadId,
                messageId = pendingId,
                deliveryState = CodexMessageDeliveryState.failed,
                turnId = null,
            )
        }
        throw e
    }
}

private suspend fun AgentService.markTurnStartAccepted(
    threadId: String,
    pendingMessageId: String,
    response: RPCMessage,
) {
    val turnId = extractTurnIdFromRpcResult(response.result)
    messageTimelineStore.markUserMessageOutcome(
        threadId = threadId,
        messageId = pendingMessageId,
        deliveryState =
            if (turnId != null) {
                CodexMessageDeliveryState.confirmed
            } else {
                CodexMessageDeliveryState.pending
            },
        turnId = turnId,
    )
    if (turnId != null) {
        noteTurnStarted(threadId, turnId)
    }
    bumpThreadActivityAfterTurn(threadId)
}

private fun AgentService.bumpThreadActivityAfterTurn(threadId: String) {
    val list = _threads.value
    if (list.none { it.id == threadId }) return
    publishThreads(
        sortThreadsForBridge(
            list.map {
                if (it.id == threadId) {
                    it.copy(
                        updatedAt = Instant.now(),
                        syncState = CodexThreadSyncState.live,
                    )
                } else {
                    it
                }
            },
        ),
    )
}

suspend fun AgentService.startTurnForRepository(
    threadId: String,
    userText: String,
    attachments: List<CodexImageAttachment> = emptyList(),
    skillMentions: List<CodexTurnSkillMention> = emptyList(),
    fileMentions: List<CodexTurnMention> = emptyList(),
    collaborationMode: CodexCollaborationModeKind? = null,
) = withContext(Dispatchers.IO) {
    startTurnInternal(threadId, userText, attachments, skillMentions, fileMentions, collaborationMode)
}

internal suspend fun AgentService.steerTurnInternal(
    threadId: String,
    expectedTurnId: String,
    userText: String,
    attachments: List<CodexImageAttachment> = emptyList(),
    skillMentions: List<CodexTurnSkillMention> = emptyList(),
    fileMentions: List<CodexTurnMention> = emptyList(),
) {
    if (!sessionReady) throw AgentServiceError.Disconnected
    val tid = threadId.trim()
    val turnId = expectedTurnId.trim()
    val trimmed = userText.trim()
    val readyAttachments =
        attachments.filter { attachment ->
            !attachment.payloadDataURL.isNullOrBlank()
        }
    if (tid.isEmpty()) throw AgentServiceError.InvalidInput("Missing thread id")
    if (turnId.isEmpty()) throw AgentServiceError.InvalidInput("Missing active turn id")
    if (trimmed.isEmpty() && readyAttachments.isEmpty()) {
        throw AgentServiceError.InvalidInput("Message is empty")
    }

    val pendingId = messageTimelineStore.appendPendingUserMessage(tid, trimmed, readyAttachments)
    var imageUrlKey = "url"
    var includeStructuredSkillItems = supportsStructuredSkillInput && skillMentions.isNotEmpty()
    var includeStructuredMentionItems = supportsStructuredMentionInput && fileMentions.isNotEmpty()
    try {
        while (true) {
            val params =
                JSONValue.Obj(
                    mapOf(
                        "threadId" to JSONValue.Str(tid),
                        "expectedTurnId" to JSONValue.Str(turnId),
                        "input" to
                            JSONValue.Arr(
                                makeTurnInputPayload(
                                    userText = trimmed,
                                    attachments = readyAttachments,
                                    imageUrlKey = imageUrlKey,
                                    skillMentions = skillMentions,
                                    fileMentions = fileMentions,
                                    includeStructuredSkillItems = includeStructuredSkillItems,
                                    includeStructuredMentionItems = includeStructuredMentionItems,
                                ),
                            ),
                    ),
                )
            try {
                sendRequestImpl("turn/steer", params)
                messageTimelineStore.markUserMessageOutcome(
                    threadId = tid,
                    messageId = pendingId,
                    deliveryState = CodexMessageDeliveryState.confirmed,
                    turnId = turnId,
                )
                bumpThreadActivityAfterTurn(tid)
                return
            } catch (e: Throwable) {
                if (imageUrlKey == "url" &&
                    readyAttachments.isNotEmpty() &&
                    shouldRetryTurnStartWithImageURLField(e)
                ) {
                    imageUrlKey = "image_url"
                    continue
                }
                if (includeStructuredSkillItems && shouldRetryTurnStartWithoutSkillItems(e)) {
                    supportsStructuredSkillInput = false
                    includeStructuredSkillItems = false
                    continue
                }
                if (includeStructuredMentionItems && shouldRetryTurnStartWithoutMentionItems(e)) {
                    supportsStructuredMentionInput = false
                    includeStructuredMentionItems = false
                    continue
                }
                throw e
            }
        }
    } catch (e: Throwable) {
        runCatching {
            messageTimelineStore.markUserMessageOutcome(
                threadId = tid,
                messageId = pendingId,
                deliveryState = CodexMessageDeliveryState.failed,
                turnId = turnId,
            )
        }
        throw e
    }
}

suspend fun AgentService.steerTurnForRepository(
    threadId: String,
    expectedTurnId: String,
    userText: String,
    attachments: List<CodexImageAttachment> = emptyList(),
    skillMentions: List<CodexTurnSkillMention> = emptyList(),
    fileMentions: List<CodexTurnMention> = emptyList(),
) = withContext(Dispatchers.IO) {
    steerTurnInternal(threadId, expectedTurnId, userText, attachments, skillMentions, fileMentions)
}
