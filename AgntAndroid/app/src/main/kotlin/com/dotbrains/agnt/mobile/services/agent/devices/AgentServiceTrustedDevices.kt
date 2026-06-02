package com.dotbrains.agnt.mobile.services.agent.devices

import com.dotbrains.agnt.mobile.core.model.AGNT_SECURE_PROTOCOL_VERSION
import com.dotbrains.agnt.mobile.core.model.CodexPairingQRPayload
import com.dotbrains.agnt.mobile.core.model.CodexTrustedMacRecord
import com.dotbrains.agnt.mobile.core.model.CodexTrustedMacRegistry
import com.dotbrains.agnt.mobile.core.model.CodexTrustedSessionResolveError
import com.dotbrains.agnt.mobile.core.model.CodexTrustedSessionResolveResponse
import com.dotbrains.agnt.mobile.core.persistence.RelaySessionSnapshot
import com.dotbrains.agnt.mobile.core.security.CodexSecureKeys
import com.dotbrains.agnt.mobile.pairing.buildWebSocketConnectParams
import com.dotbrains.agnt.mobile.services.agent.AgentService
import com.dotbrains.agnt.mobile.services.agent.connection.AgntTrustedSessionResolveClient
import com.dotbrains.agnt.mobile.ui.mydevices.MyDeviceMenuVisibilityStore
import com.dotbrains.agnt.mobile.ui.mydevices.SidebarComputerNicknameStore
import java.time.Instant

internal fun AgentService.trustedSessionResolveClient(): AgntTrustedSessionResolveClient {
    val existing = trustedSessionResolveClientLazy
    if (existing != null) return existing
    return AgntTrustedSessionResolveClient(httpCallClient, secureStore, json).also {
        trustedSessionResolveClientLazy = it
    }
}

fun AgentService.initializeTrustedDeviceState() {
    refreshTrustedDevices()
    val snapshot = sessionPersistence.loadRelaySnapshot()
    _currentTrustedMacDeviceId.value =
        snapshot.lastTrustedMacDeviceId?.trim()?.takeIf { it.isNotEmpty() }
            ?: snapshot.relayMacDeviceId?.trim()?.takeIf { it.isNotEmpty() }
    _relayMacDeviceId.value = snapshot.relayMacDeviceId?.trim()?.takeIf { it.isNotEmpty() }
}

fun AgentService.refreshTrustedDevices() {
    _trustedDevices.value = presentationTrustedMacRecords()
}

fun AgentService.presentationTrustedMacRecords(registry: CodexTrustedMacRegistry = loadTrustedRegistry()): List<CodexTrustedMacRecord> = registry.records.values.toList()

internal fun AgentService.loadTrustedRegistry(): CodexTrustedMacRegistry = secureStore.readCodable(CodexSecureKeys.trustedMacRegistry) ?: CodexTrustedMacRegistry.empty

internal fun CodexTrustedMacRegistry.removingTrustedDevice(deviceId: String?): CodexTrustedMacRegistry {
    val normalized = deviceId?.trim()?.takeIf { it.isNotEmpty() } ?: return this
    return CodexTrustedMacRegistry(records - normalized)
}

internal fun AgentService.forgetTrustedDeviceImpl(deviceId: String) {
    val normalized = normalizedMacDeviceId(deviceId) ?: return
    val nextRegistry = loadTrustedRegistry().removingTrustedDevice(normalized)
    secureStore.writeCodable(CodexSecureKeys.trustedMacRegistry, nextRegistry)
    MyDeviceMenuVisibilityStore.removePreference(normalized)
    SidebarComputerNicknameStore.setNickname("", normalized)
    macScopedSessionStore.clearDevice(normalized)
    if (_previousTrustedMacDeviceId.value == normalized) clearPreviousTrustedMacDeviceId()
    refreshTrustedDevices()
}

internal fun AgentService.trustedMacRecord(deviceId: String?): CodexTrustedMacRecord? {
    val normalized = normalizedMacDeviceId(deviceId) ?: return null
    return loadTrustedRegistry().records[normalized]
}

internal fun AgentService.normalizedCurrentTrustedMacDeviceId(): String? =
    normalizedMacDeviceId(macScopedContextOverrideDeviceId)
        ?: _currentTrustedMacDeviceId.value?.trim()?.takeIf { it.isNotEmpty() }
        ?: sessionPersistence
            .loadRelaySnapshot()
            .lastTrustedMacDeviceId
            ?.trim()
            ?.takeIf { it.isNotEmpty() }

internal fun AgentService.normalizedRelayMacDeviceId(): String? =
    _relayMacDeviceId.value?.trim()?.takeIf { it.isNotEmpty() }
        ?: sessionPersistence
            .loadRelaySnapshot()
            .relayMacDeviceId
            ?.trim()
            ?.takeIf { it.isNotEmpty() }

internal fun AgentService.setCurrentTrustedMacDeviceId(deviceId: String?) {
    val normalized = normalizedMacDeviceId(deviceId)
    _currentTrustedMacDeviceId.value = normalized
    val snapshot = sessionPersistence.loadRelaySnapshot()
    sessionPersistence.saveRelaySnapshot(snapshot.copy(lastTrustedMacDeviceId = normalized))
}

internal fun AgentService.setPreviousTrustedMacDeviceId(deviceId: String?) {
    _previousTrustedMacDeviceId.value = normalizedMacDeviceId(deviceId)
}

internal fun AgentService.clearPreviousTrustedMacDeviceId() {
    _previousTrustedMacDeviceId.value = null
}

internal fun AgentService.normalizedMacDeviceId(deviceId: String?): String? = deviceId?.trim()?.takeIf { it.isNotEmpty() }

internal fun AgentService.resolvedMacScopedPersistenceDeviceId(): String? = normalizedMacDeviceId(macScopedContextOverrideDeviceId) ?: normalizedCurrentTrustedMacDeviceId()

internal fun AgentService.applyResolvedTrustedSession(
    resolved: CodexTrustedSessionResolveResponse,
    relayURL: String,
) {
    val registry = loadTrustedRegistry()
    val previous = registry.records[resolved.macDeviceId]
    val updated =
        CodexTrustedMacRecord(
            macDeviceId = resolved.macDeviceId,
            macIdentityPublicKey = resolved.macIdentityPublicKey,
            lastPairedAt = previous?.lastPairedAt ?: Instant.now(),
            relayURL = relayURL,
            displayName = resolved.displayName ?: previous?.displayName,
            lastResolvedSessionId = resolved.sessionId,
            lastResolvedAt = Instant.now(),
            lastUsedAt = Instant.now(),
        )
    secureStore.writeCodable(
        CodexSecureKeys.trustedMacRegistry,
        CodexTrustedMacRegistry(registry.records + (resolved.macDeviceId to updated)),
    )
    sessionPersistence.saveRelaySnapshot(
        sessionPersistence.loadRelaySnapshot().copy(
            relaySessionId = resolved.sessionId,
            relayUrl = relayURL,
            relayMacDeviceId = resolved.macDeviceId,
            relayMacIdentityPublicKey = resolved.macIdentityPublicKey,
            lastTrustedMacDeviceId = resolved.macDeviceId,
        ),
    )
    _relayMacDeviceId.value = resolved.macDeviceId
    refreshTrustedDevices()
}

internal fun AgentService.clearSavedRelaySession() {
    sessionPersistence.clearRelaySession()
    _relayMacDeviceId.value = null
}

internal suspend fun AgentService.resolveTrustedMacSession(deviceId: String? = null): CodexTrustedSessionResolveResponse {
    val targetId = normalizedMacDeviceId(deviceId) ?: normalizedCurrentTrustedMacDeviceId()
    val trustedMac =
        trustedMacRecord(targetId) ?: trustedMacRecord(normalizedCurrentTrustedMacDeviceId())
            ?: throw CodexTrustedSessionResolveError.NoTrustedMac
    val resolved = trustedSessionResolveClient().resolveTrustedMacSession(trustedMac)
    applyResolvedTrustedSession(resolved, trustedMac.relayURL.orEmpty())
    return resolved
}

internal fun AgentService.cancelTrustedSessionResolve() {
    trustedSessionResolveClient().cancel()
}

internal suspend fun AgentService.preferredReconnectParams(targetMacDeviceId: String?): Pair<String, String>? {
    val normalizedTarget = normalizedMacDeviceId(targetMacDeviceId) ?: return null
    val trustedMac = trustedMacRecord(normalizedTarget) ?: return null
    return runCatching {
        resolveTrustedMacSession(normalizedTarget)
        buildWebSocketConnectParams(
            sessionPersistence.loadRelaySnapshot(),
            sessionPersistence.loadLocalRelayHostOverride().orEmpty(),
        )
    }.getOrNull()
        ?: trustedMac.lastResolvedSessionId?.let { sessionId ->
            val fallbackSnapshot = trustedMacFallbackRelaySnapshot(trustedMac, sessionId) ?: return@let null
            sessionPersistence.saveRelaySnapshot(fallbackSnapshot)
            _relayMacDeviceId.value = trustedMac.macDeviceId
            trustedMacFallbackReconnectParams(
                trustedMac = trustedMac,
                sessionId = sessionId,
                relayHostOverride = sessionPersistence.loadLocalRelayHostOverride().orEmpty(),
            )
        }
        ?: run {
            val snap = sessionPersistence.loadRelaySnapshot()
            if (snap.relayMacDeviceId == normalizedTarget && !snap.relayUrl.isNullOrBlank() && !snap.relaySessionId.isNullOrBlank()) {
                runCatching {
                    buildWebSocketConnectParams(
                        snap,
                        sessionPersistence.loadLocalRelayHostOverride().orEmpty(),
                    )
                }.getOrNull()
            } else {
                null
            }
        }
}

internal fun trustedMacFallbackReconnectParams(
    trustedMac: CodexTrustedMacRecord,
    sessionId: String,
    relayHostOverride: String = "",
): Pair<String, String>? {
    val snapshot = trustedMacFallbackRelaySnapshot(trustedMac, sessionId) ?: return null
    return buildWebSocketConnectParams(snapshot, relayHostOverride)
}

internal fun trustedMacFallbackRelaySnapshot(
    trustedMac: CodexTrustedMacRecord,
    sessionId: String,
): RelaySessionSnapshot? {
    val relay = trustedMac.relayURL?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val sid = sessionId.trim().takeIf { it.isNotEmpty() } ?: return null
    return RelaySessionSnapshot(
        relaySessionId = sid,
        relayUrl = relay,
        relayMacDeviceId = trustedMac.macDeviceId,
        relayMacIdentityPublicKey = trustedMac.macIdentityPublicKey,
        relayProtocolVersion = AGNT_SECURE_PROTOCOL_VERSION.toString(),
        relayLastAppliedBridgeOutboundSeq = "0",
        lastTrustedMacDeviceId = trustedMac.macDeviceId,
    )
}

internal fun AgentService.captureRelaySessionSnapshot(): RelaySessionSnapshot = sessionPersistence.loadRelaySnapshot()

internal fun AgentService.restoreRelaySessionSnapshot(snapshot: RelaySessionSnapshot) {
    sessionPersistence.saveRelaySnapshot(snapshot)
    _relayMacDeviceId.value = snapshot.relayMacDeviceId?.trim()?.takeIf { it.isNotEmpty() }
}

/**
 * Persists the QR pairing payload and records the paired computer in the trusted-Mac registry so it
 * appears in the "My Devices" surface. Our [CodexPairingQRPayload] has no `displayName` field
 * (upstream's does), so the record's display name is preserved from any prior pairing rather than
 * overwritten from the QR code.
 */
internal fun AgentService.rememberRelayPairing(payload: CodexPairingQRPayload) {
    sessionPersistence.applyPairingPayload(payload, secureStore)
    val registry = loadTrustedRegistry()
    val previous = registry.records[payload.macDeviceId]
    val record =
        CodexTrustedMacRecord(
            macDeviceId = payload.macDeviceId,
            macIdentityPublicKey = payload.macIdentityPublicKey,
            lastPairedAt = previous?.lastPairedAt ?: Instant.now(),
            relayURL = payload.relay,
            displayName = previous?.displayName,
            lastResolvedSessionId = previous?.lastResolvedSessionId,
            lastResolvedAt = previous?.lastResolvedAt,
            lastUsedAt = previous?.lastUsedAt,
        )
    secureStore.writeCodable(
        CodexSecureKeys.trustedMacRegistry,
        CodexTrustedMacRegistry(registry.records + (payload.macDeviceId to record)),
    )
    _relayMacDeviceId.value = payload.macDeviceId
    setCurrentTrustedMacDeviceId(payload.macDeviceId)
    refreshTrustedDevices()
}
