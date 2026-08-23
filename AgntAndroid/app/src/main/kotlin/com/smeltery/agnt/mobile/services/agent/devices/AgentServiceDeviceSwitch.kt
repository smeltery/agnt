package com.smeltery.agnt.mobile.services.agent.devices

import com.smeltery.agnt.mobile.core.model.CodexAccessMode
import com.smeltery.agnt.mobile.core.model.CodexPairingQRPayload
import com.smeltery.agnt.mobile.core.model.CodexServiceTier
import com.smeltery.agnt.mobile.core.model.CodexTrustedSessionResolveError
import com.smeltery.agnt.mobile.core.persistence.RuntimeSelectionSnapshot
import com.smeltery.agnt.mobile.core.transport.ConnectionState
import com.smeltery.agnt.mobile.pairing.buildWebSocketConnectParams
import com.smeltery.agnt.mobile.services.agent.AgentService
import com.smeltery.agnt.mobile.services.agent.connection.connectImpl
import com.smeltery.agnt.mobile.services.agent.connection.disconnectImpl
import com.smeltery.agnt.mobile.services.agent.notifications.cancelAllRunOngoingNotifications
import com.smeltery.agnt.mobile.services.agent.threads.interruptTurnForRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.withLock

internal suspend fun AgentService.switchToTrustedDeviceImpl(deviceId: String) {
    val normalizedTarget = normalizedMacDeviceId(deviceId) ?: throw CodexTrustedSessionResolveError.NoTrustedMac
    if (normalizedTarget == normalizedCurrentTrustedMacDeviceId()) return
    deviceSwitchMutex.withLock {
        if (_switchingDeviceId.value != null) return
        isCancellingDeviceSwitch = false
        _switchingDeviceId.value = normalizedTarget
        _deviceSwitchNotice.value = null
        val previousCurrent = normalizedCurrentTrustedMacDeviceId()
        val effectiveTarget = normalizedTarget
        try {
            val reconnectParams =
                preferredReconnectParams(normalizedTarget)
                    ?: run {
                        val message = "Could not reconnect to the selected device."
                        _deviceSwitchNotice.value = message
                        throw CodexTrustedSessionResolveError.MacOffline(message)
                    }
            interruptRunningTurnsBeforeDeviceSwitchIfNeeded()
            saveMacScopedLocalState(previousCurrent)
            beginMacSwitchContext(effectiveTarget)
            previousCurrent?.let { setPreviousTrustedMacDeviceId(it) } ?: clearPreviousTrustedMacDeviceId()
            setCurrentTrustedMacDeviceId(effectiveTarget)
            disconnectImpl(preservePresentationState = false)
            prepareMacSwitchState(effectiveTarget, loadCachedMessages = false)
            val (url, token) = reconnectParams
            connectImpl(url, token, role = null)
            setCurrentTrustedMacDeviceId(effectiveTarget)
            _deviceSwitchNotice.value = null
            endMacSwitchContext()
        } catch (error: CancellationException) {
            finalizeCancelledDeviceSwitch(previousCurrent)
            throw error
        } catch (error: Exception) {
            if (isCancellingDeviceSwitch) {
                finalizeCancelledDeviceSwitch(previousCurrent)
                throw CancellationException()
            }
            if (_connectionState.value is ConnectionState.Connected || sessionReady) {
                setCurrentTrustedMacDeviceId(previousCurrent)
                clearPreviousTrustedMacDeviceId()
                _deviceSwitchNotice.value = error.message ?: "Could not switch devices."
                endMacSwitchContext()
                throw error
            }
            setCurrentTrustedMacDeviceId(effectiveTarget)
            macScopedContextOverrideDeviceId = effectiveTarget
            prepareMacSwitchState(effectiveTarget, loadCachedMessages = true)
            _deviceSwitchNotice.value = error.message ?: "Could not switch devices."
            endMacSwitchContext()
            throw error
        } finally {
            _switchingDeviceId.value = null
            refreshTrustedDevices()
        }
    }
}

internal suspend fun AgentService.switchToScannedDeviceImpl(payload: CodexPairingQRPayload) {
    deviceSwitchMutex.withLock {
        if (_switchingDeviceId.value != null) return
        isCancellingDeviceSwitch = false
        _switchingDeviceId.value = payload.macDeviceId
        _deviceSwitchNotice.value = null
        val previousCurrent = normalizedCurrentTrustedMacDeviceId()
        val previousSnapshot = captureRelaySessionSnapshot()
        try {
            interruptRunningTurnsBeforeDeviceSwitchIfNeeded()
            saveMacScopedLocalState(previousCurrent)
            beginMacSwitchContext(payload.macDeviceId)
            rememberRelayPairing(payload)
            prepareMacSwitchState(payload.macDeviceId, loadCachedMessages = false)
            val (url, token) =
                buildWebSocketConnectParams(
                    sessionPersistence.loadRelaySnapshot(),
                    sessionPersistence.loadLocalRelayHostOverride().orEmpty(),
                )
            connectImpl(url, token, role = null)
            previousCurrent?.let { setPreviousTrustedMacDeviceId(it) } ?: clearPreviousTrustedMacDeviceId()
            endMacSwitchContext()
        } catch (error: CancellationException) {
            finalizeCancelledDeviceSwitch(previousCurrent)
            throw error
        } catch (error: Exception) {
            if (isCancellingDeviceSwitch) {
                finalizeCancelledDeviceSwitch(previousCurrent)
                throw CancellationException()
            }
            setCurrentTrustedMacDeviceId(previousCurrent)
            restoreRelaySessionSnapshot(previousSnapshot)
            macScopedContextOverrideDeviceId = previousCurrent
            prepareMacSwitchState(previousCurrent, loadCachedMessages = true)
            endMacSwitchContext()
            throw error
        } finally {
            _switchingDeviceId.value = null
            refreshTrustedDevices()
        }
    }
}

internal suspend fun AgentService.cancelDeviceSwitchImpl() {
    if (_switchingDeviceId.value == null) return
    isCancellingDeviceSwitch = true
    cancelTrustedSessionResolve()
    if (_connectionState.value is ConnectionState.Connecting ||
        _connectionState.value is ConnectionState.Connected ||
        sessionReady
    ) {
        disconnectImpl(preservePresentationState = false)
    }
}

private suspend fun AgentService.finalizeCancelledDeviceSwitch(previousCurrent: String?) {
    cancelTrustedSessionResolve()
    disconnectImpl(preservePresentationState = false)
    setCurrentTrustedMacDeviceId(null)
    previousCurrent?.let { setPreviousTrustedMacDeviceId(it) }
    clearSavedRelaySession()
    clearInMemoryMacScopedState()
    endMacSwitchContext()
    _deviceSwitchNotice.value = "Switch cancelled. Choose a device to reconnect."
}

private fun AgentService.beginMacSwitchContext(macDeviceId: String?) {
    suspendAutomaticMacScopedPersistence = true
    macScopedContextOverrideDeviceId = normalizedMacDeviceId(macDeviceId)
}

private suspend fun AgentService.prepareMacSwitchState(
    macDeviceId: String?,
    loadCachedMessages: Boolean,
) {
    clearInMemoryMacScopedState()
    if (loadCachedMessages) {
        loadMacScopedLocalState(macDeviceId)
    }
    loadMacScopedDefaultsState(macDeviceId)
}

private fun AgentService.endMacSwitchContext() {
    macScopedContextOverrideDeviceId = null
    suspendAutomaticMacScopedPersistence = false
}

/**
 * Persists the per-device thread/runtime snapshot for [macDeviceId] before tearing down the active
 * session. Message-timeline persistence is deliberately left to the un-scoped
 * [com.smeltery.agnt.mobile.core.persistence.CodexMessagePersistence]; see ROADMAP P3.0 for the
 * deferred mac-scoped message store.
 */
internal fun AgentService.saveMacScopedLocalState(macDeviceId: String?) {
    if (suspendAutomaticMacScopedPersistence) return
    val store = macScopedSessionStore
    val device = resolvedMacScopedPersistenceDeviceId() ?: macDeviceId ?: return
    store.saveCachedThreads(device, _threads.value)
    store.saveLastActiveThreadId(device, _activeThreadId.value)
    store.saveThreadRenames(device, persistedThreadRenameById.toMap())
    store.saveAssociatedManagedWorktreePaths(device, associatedManagedWorktreePathByThreadId.toMap())
    store.saveRuntimeSelection(
        device,
        RuntimeSelectionSnapshot(
            selectedModelId = _selectedModelId.value,
            selectedReasoningEffort = _selectedReasoningEffort.value,
            selectedAccessMode = _selectedAccessMode.value.name,
            selectedServiceTier = _selectedServiceTier.value?.name,
        ),
    )
}

internal fun AgentService.loadMacScopedLocalState(macDeviceId: String?) {
    val store = macScopedSessionStore
    val device = normalizedMacDeviceId(macDeviceId) ?: return
    isApplyingMacScopedState = true
    try {
        _threads.value = store.loadCachedThreads(device)
        _activeThreadId.value = store.loadLastActiveThreadId(device)
        persistedThreadRenameById.clear()
        persistedThreadRenameById.putAll(store.loadThreadRenames(device))
        associatedManagedWorktreePathByThreadId.clear()
        associatedManagedWorktreePathByThreadId.putAll(store.loadAssociatedManagedWorktreePaths(device))
    } finally {
        isApplyingMacScopedState = false
    }
}

internal fun AgentService.loadMacScopedDefaultsState(macDeviceId: String?) {
    val store = macScopedSessionStore
    val device = normalizedMacDeviceId(macDeviceId) ?: return
    isApplyingMacScopedState = true
    try {
        val runtime = store.loadRuntimeSelection(device)
        _selectedModelId.value = runtime.selectedModelId
        _selectedReasoningEffort.value = runtime.selectedReasoningEffort
        runtime.selectedAccessMode?.let { raw ->
            runCatching { CodexAccessMode.valueOf(raw) }.getOrNull()?.let { _selectedAccessMode.value = it }
        }
        runtime.selectedServiceTier?.let { raw ->
            runCatching { CodexServiceTier.valueOf(raw) }.getOrNull()?.let { _selectedServiceTier.value = it }
        }
        _threads.value = store.loadCachedThreads(device)
        _activeThreadId.value = store.loadLastActiveThreadId(device)
    } finally {
        isApplyingMacScopedState = false
    }
}

internal suspend fun AgentService.clearInMemoryMacScopedState() {
    isApplyingMacScopedState = true
    try {
        _threads.value = emptyList()
        _activeThreadId.value = null
        persistedThreadRenameById.clear()
        associatedManagedWorktreePathByThreadId.clear()
        cancelAllRunOngoingNotifications()
        _runningTurnIdByThread.value = emptyMap()
        _protectedRunningFallbackThreadIds.value = emptySet()
        turnDraftQueueStore.clear()
    } finally {
        isApplyingMacScopedState = false
    }
}

private suspend fun AgentService.interruptRunningTurnsBeforeDeviceSwitchIfNeeded() {
    if (_connectionState.value !is ConnectionState.Connected && !sessionReady) return
    val running = _runningTurnIdByThread.value
    val protected = _protectedRunningFallbackThreadIds.value
    if (running.isEmpty() && protected.isEmpty()) return
    running.forEach { (threadId, turnId) ->
        runCatching { interruptTurnForRepository(threadId, turnId) }
    }
}
