package com.dotbrains.agnt.mobile.services.agent

import android.content.Context
import com.dotbrains.agnt.mobile.core.model.CodexAccessMode
import com.dotbrains.agnt.mobile.core.model.CodexCollaborationModeKind
import com.dotbrains.agnt.mobile.core.model.CodexImageAttachment
import com.dotbrains.agnt.mobile.core.model.CodexPairingQRPayload
import com.dotbrains.agnt.mobile.core.model.CodexReviewTarget
import com.dotbrains.agnt.mobile.core.model.CodexServiceTier
import com.dotbrains.agnt.mobile.core.model.CodexThread
import com.dotbrains.agnt.mobile.core.model.CodexThreadGoal
import com.dotbrains.agnt.mobile.core.model.CodexThreadGoalBudgetUpdate
import com.dotbrains.agnt.mobile.core.model.CodexThreadGoalStatus
import com.dotbrains.agnt.mobile.core.model.CodexTurnMention
import com.dotbrains.agnt.mobile.core.model.CodexTurnSkillMention
import com.dotbrains.agnt.mobile.core.model.JSONValue
import com.dotbrains.agnt.mobile.core.model.PendingApprovalDecision
import com.dotbrains.agnt.mobile.core.model.RPCMessage
import com.dotbrains.agnt.mobile.core.persistence.CodexMessagePersistence
import com.dotbrains.agnt.mobile.core.persistence.SessionPersistence
import com.dotbrains.agnt.mobile.core.security.SecureStore
import com.dotbrains.agnt.mobile.data.QueuedTurnDraft
import com.dotbrains.agnt.mobile.services.agent.connection.DesktopHandoffService
import com.dotbrains.agnt.mobile.services.agent.connection.connectImpl
import com.dotbrains.agnt.mobile.services.agent.connection.disconnectImpl
import com.dotbrains.agnt.mobile.services.agent.connection.setActiveThreadIdImpl
import com.dotbrains.agnt.mobile.services.agent.devices.cancelDeviceSwitchImpl
import com.dotbrains.agnt.mobile.services.agent.devices.forgetTrustedDeviceImpl
import com.dotbrains.agnt.mobile.services.agent.devices.initializeTrustedDeviceState
import com.dotbrains.agnt.mobile.services.agent.devices.refreshTrustedDevices
import com.dotbrains.agnt.mobile.services.agent.devices.resolvedMacScopedPersistenceDeviceId
import com.dotbrains.agnt.mobile.services.agent.devices.switchToScannedDeviceImpl
import com.dotbrains.agnt.mobile.services.agent.devices.switchToTrustedDeviceImpl
import com.dotbrains.agnt.mobile.services.agent.notifications.resolvePendingApprovalForRepository
import com.dotbrains.agnt.mobile.services.agent.notifications.resolvePendingStructuredInputForRepository
import com.dotbrains.agnt.mobile.services.agent.review.startReviewForRepository
import com.dotbrains.agnt.mobile.services.agent.runtime.refreshModelsForRepository
import com.dotbrains.agnt.mobile.services.agent.runtime.refreshRateLimitsForRepository
import com.dotbrains.agnt.mobile.services.agent.runtime.refreshThreadsInternal
import com.dotbrains.agnt.mobile.services.agent.runtime.refreshUsageStatusForRepository
import com.dotbrains.agnt.mobile.services.agent.runtime.setSelectedAccessModeForRepository
import com.dotbrains.agnt.mobile.services.agent.runtime.setSelectedModelIdForRepository
import com.dotbrains.agnt.mobile.services.agent.runtime.setSelectedReasoningEffortForRepository
import com.dotbrains.agnt.mobile.services.agent.runtime.setSelectedServiceTierForRepository
import com.dotbrains.agnt.mobile.services.agent.runtime.shouldAutoRefreshUsageStatusForRepository
import com.dotbrains.agnt.mobile.services.agent.threads.archiveThreadGroupForRepository
import com.dotbrains.agnt.mobile.services.agent.threads.associatedManagedWorktreePathForImpl
import com.dotbrains.agnt.mobile.services.agent.threads.clearThreadGoalInternal
import com.dotbrains.agnt.mobile.services.agent.threads.currentAuthoritativeProjectPathForImpl
import com.dotbrains.agnt.mobile.services.agent.threads.deleteLocalThreadGroupForRepository
import com.dotbrains.agnt.mobile.services.agent.threads.deleteThreadLocallyForRepository
import com.dotbrains.agnt.mobile.services.agent.threads.forkThreadForRepository
import com.dotbrains.agnt.mobile.services.agent.threads.interruptTurnForRepository
import com.dotbrains.agnt.mobile.services.agent.threads.loadOlderThreadHistoryInternal
import com.dotbrains.agnt.mobile.services.agent.threads.moveThreadToProjectPathImpl
import com.dotbrains.agnt.mobile.services.agent.threads.readThreadGoalInternal
import com.dotbrains.agnt.mobile.services.agent.threads.refreshContextWindowUsageForRepository
import com.dotbrains.agnt.mobile.services.agent.threads.renameThreadForRepository
import com.dotbrains.agnt.mobile.services.agent.threads.sendNotificationImpl
import com.dotbrains.agnt.mobile.services.agent.threads.sendRequestImpl
import com.dotbrains.agnt.mobile.services.agent.threads.setThreadGoalInternal
import com.dotbrains.agnt.mobile.services.agent.threads.startThreadForRepository
import com.dotbrains.agnt.mobile.services.agent.threads.startTurnForRepository
import com.dotbrains.agnt.mobile.services.agent.threads.syncThreadHistoryInternal
import com.dotbrains.agnt.mobile.services.agent.voice.transcribeBridgeVoiceWavImpl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

class AgentService(
    context: Context,
    httpClient: OkHttpClient,
    httpCallClient: OkHttpClient = httpClient,
    secureStore: SecureStore,
    sessionPersistence: SessionPersistence,
    messagePersistence: CodexMessagePersistence,
) : AgentServiceState(
        context = context,
        httpClient = httpClient,
        httpCallClient = httpCallClient,
        secureStore = secureStore,
        sessionPersistence = sessionPersistence,
        messagePersistence = messagePersistence,
    ) {
    private val incomingCoordinator = AgentServiceIncomingCoordinator(this)
    internal val incomingRouter
        get() = incomingCoordinator.incomingRouter

    init {
        scope.launch {
            runCatching { messagePersistence.migrateLegacyMonolithToPerThreadIfNeeded() }
        }
        initializeTrustedDeviceState()
    }

    internal fun noteProtectedRunningFallback(
        threadId: String,
        active: Boolean,
    ) = incomingCoordinator.noteProtectedRunningFallback(threadId, active)

    internal fun noteTurnStarted(
        threadId: String,
        turnId: String,
    ) = incomingCoordinator.noteTurnStarted(threadId, turnId)

    internal fun noteTurnFinished(threadId: String) = incomingCoordinator.noteTurnFinished(threadId)

    internal fun noteTurnCompleted(threadId: String) = incomingCoordinator.noteTurnCompleted(threadId)

    internal fun noteTurnFailed(threadId: String) = incomingCoordinator.noteTurnFailed(threadId)

    internal fun clearThreadOutcome(threadId: String) = incomingCoordinator.clearThreadOutcome(threadId)

    override suspend fun connect(
        serverUrl: String,
        token: String,
        role: String?,
    ) = connectImpl(serverUrl, token, role)

    override suspend fun disconnect() = disconnectImpl()

    override suspend fun setActiveThreadId(threadId: String?) = setActiveThreadIdImpl(threadId)

    override suspend fun refreshModels() = refreshModelsForRepository()

    override suspend fun setSelectedModelId(modelId: String?) = setSelectedModelIdForRepository(modelId)

    override suspend fun setSelectedReasoningEffort(reasoningEffort: String?) = setSelectedReasoningEffortForRepository(reasoningEffort)

    override suspend fun setSelectedAccessMode(accessMode: CodexAccessMode) = setSelectedAccessModeForRepository(accessMode)

    override suspend fun setSelectedServiceTier(serviceTier: CodexServiceTier?) = setSelectedServiceTierForRepository(serviceTier)

    override suspend fun resolvePendingApproval(
        requestId: String,
        decision: PendingApprovalDecision,
    ) = resolvePendingApprovalForRepository(requestId, decision)

    override suspend fun resolvePendingStructuredInput(
        requestId: String,
        answersByQuestionId: Map<String, List<String>>,
    ) = resolvePendingStructuredInputForRepository(requestId, answersByQuestionId)

    override fun dismissBridgeUpdatePrompt() {
        _bridgeUpdatePrompt.value = null
    }

    override suspend fun updateBridgePackageAndRestart() {
        DesktopHandoffService(this).updateBridgePackageAndRestart()
    }

    override suspend fun loadComposerDraft(threadId: String): String =
        withContext(Dispatchers.IO) {
            val tid = threadId.trim().takeIf { it.isNotEmpty() } ?: return@withContext ""
            macScopedSessionStore.loadComposerDrafts(resolvedMacScopedPersistenceDeviceId())[tid].orEmpty()
        }

    override suspend fun saveComposerDraft(
        threadId: String,
        draft: String,
    ) = withContext(Dispatchers.IO) {
        macScopedSessionStore.saveComposerDraft(
            macDeviceId = resolvedMacScopedPersistenceDeviceId(),
            threadId = threadId,
            draft = draft,
        )
    }

    override suspend fun clearComposerDraft(threadId: String) =
        withContext(Dispatchers.IO) {
            macScopedSessionStore.clearComposerDraft(
                macDeviceId = resolvedMacScopedPersistenceDeviceId(),
                threadId = threadId,
            )
        }

    override suspend fun refreshThreads() =
        withContext(Dispatchers.IO) {
            refreshThreadsInternal()
        }

    override suspend fun syncThreadHistory(
        threadId: String,
        force: Boolean,
    ) = withContext(Dispatchers.IO) {
        syncThreadHistoryInternal(threadId, force)
    }

    override suspend fun loadOlderThreadHistory(threadId: String) =
        withContext(Dispatchers.IO) {
            loadOlderThreadHistoryInternal(threadId)
        }

    override suspend fun refreshRateLimits() = refreshRateLimitsForRepository()

    override suspend fun refreshContextWindowUsage(threadId: String) = refreshContextWindowUsageForRepository(threadId)

    override suspend fun refreshUsageStatus(threadId: String?) = refreshUsageStatusForRepository(threadId)

    override fun shouldAutoRefreshUsageStatus(threadId: String?): Boolean = shouldAutoRefreshUsageStatusForRepository(threadId)

    override suspend fun sendRequest(
        method: String,
        params: JSONValue?,
    ): RPCMessage = sendRequestImpl(method, params)

    override suspend fun refreshThreadGoal(threadId: String): CodexThreadGoal? = readThreadGoalInternal(threadId)

    override suspend fun setThreadGoal(
        threadId: String,
        objective: String?,
        status: CodexThreadGoalStatus?,
        tokenBudget: CodexThreadGoalBudgetUpdate,
    ): CodexThreadGoal =
        setThreadGoalInternal(
            threadId = threadId,
            objective = objective,
            status = status,
            tokenBudget = tokenBudget,
        )

    override suspend fun clearThreadGoal(threadId: String): Boolean = clearThreadGoalInternal(threadId)

    override suspend fun renameThread(
        threadId: String,
        name: String,
    ) = renameThreadForRepository(threadId, name)

    override suspend fun deleteThreadLocally(threadId: String) = deleteThreadLocallyForRepository(threadId)

    override suspend fun archiveThreadGroup(threadIds: List<String>) = archiveThreadGroupForRepository(threadIds)

    override suspend fun deleteLocalThreadGroup(threadIds: List<String>) = deleteLocalThreadGroupForRepository(threadIds)

    override suspend fun transcribeBridgeVoiceWav(
        wavBytes: ByteArray,
        durationSeconds: Double,
    ): String = transcribeBridgeVoiceWavImpl(wavBytes, durationSeconds)

    override suspend fun startThread(
        model: String?,
        cwd: String?,
        serviceTier: String?,
    ): CodexThread =
        startThreadForRepository(
            model = model,
            cwd = cwd,
            serviceTier = serviceTier,
        )

    override fun requestBranchPickerForThread(threadId: String) {
        val tid = CodexThread.normalizeIdentifier(threadId) ?: return
        _pendingBranchPickerThreadId.value = tid
    }

    override fun consumeBranchPickerRequest(threadId: String) {
        val tid = CodexThread.normalizeIdentifier(threadId) ?: return
        if (_pendingBranchPickerThreadId.value == tid) {
            _pendingBranchPickerThreadId.value = null
        }
    }

    override suspend fun forkThread(
        sourceThreadId: String,
        targetProjectPath: String?,
    ): CodexThread = forkThreadForRepository(sourceThreadId, targetProjectPath)

    override suspend fun enqueueTurnDraft(
        threadId: String,
        text: String,
        attachments: List<CodexImageAttachment>,
        skillMentions: List<CodexTurnSkillMention>,
        fileMentions: List<CodexTurnMention>,
        collaborationMode: CodexCollaborationModeKind?,
        prepend: Boolean,
    ) = withContext(Dispatchers.IO) {
        turnDraftQueueStore.enqueue(
            threadId = threadId,
            text = text,
            attachments = attachments,
            skillMentions = skillMentions,
            fileMentions = fileMentions,
            collaborationMode = collaborationMode,
            prepend = prepend,
        )
    }

    override suspend fun pollTurnDraft(threadId: String): QueuedTurnDraft? =
        withContext(Dispatchers.IO) {
            turnDraftQueueStore.poll(threadId)
        }

    override suspend fun removeQueuedTurnDraft(
        threadId: String,
        draftId: String,
    ): QueuedTurnDraft? =
        withContext(Dispatchers.IO) {
            turnDraftQueueStore.remove(threadId, draftId)
        }

    override suspend fun startTurn(
        threadId: String,
        text: String,
        attachments: List<CodexImageAttachment>,
        skillMentions: List<CodexTurnSkillMention>,
        fileMentions: List<CodexTurnMention>,
        collaborationMode: CodexCollaborationModeKind?,
    ) = startTurnForRepository(threadId, text, attachments, skillMentions, fileMentions, collaborationMode)

    override suspend fun startReview(
        threadId: String,
        target: CodexReviewTarget,
        baseBranch: String?,
    ) = startReviewForRepository(threadId, target, baseBranch)

    override suspend fun interruptTurn(
        threadId: String,
        turnId: String?,
    ) = interruptTurnForRepository(threadId, turnId)

    override suspend fun sendNotification(
        method: String,
        params: JSONValue?,
    ) = sendNotificationImpl(method, params)

    override suspend fun moveThreadToProjectPath(
        threadId: String,
        projectPath: String,
    ) = withContext(Dispatchers.IO) {
        moveThreadToProjectPathImpl(threadId, projectPath)
    }

    override fun currentAuthoritativeProjectPathFor(threadId: String) = currentAuthoritativeProjectPathForImpl(threadId)

    override fun associatedManagedWorktreePathFor(threadId: String) = associatedManagedWorktreePathForImpl(threadId)

    override suspend fun switchToTrustedDevice(deviceId: String) = switchToTrustedDeviceImpl(deviceId)

    override suspend fun switchToScannedDevice(payload: CodexPairingQRPayload) = switchToScannedDeviceImpl(payload)

    override suspend fun cancelDeviceSwitch() = cancelDeviceSwitchImpl()

    override fun setDeviceMenuVisible(
        deviceId: String,
        visible: Boolean,
    ) {
        com.dotbrains.agnt.mobile.ui.mydevices.MyDeviceMenuVisibilityStore
            .setVisible(visible, deviceId)
        refreshTrustedDevices()
    }

    override fun forgetTrustedDevice(deviceId: String) {
        forgetTrustedDeviceImpl(deviceId)
    }
}
