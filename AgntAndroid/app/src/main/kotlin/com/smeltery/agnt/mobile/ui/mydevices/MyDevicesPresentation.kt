package com.smeltery.agnt.mobile.ui.mydevices

import com.smeltery.agnt.mobile.core.model.CodexTrustedMacRecord
import com.smeltery.agnt.mobile.core.transport.ConnectionState
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Pure presentation for the "My Devices" multi-device switcher. Ported from upstream
 * `MyDevicesPresentation`; provider-agnostic (no Codex/freemium coupling). [SidebarComputerNicknameStore]
 * lives alongside [MyDeviceMenuVisibilityStore] and is reused here.
 */
data class MyDeviceRowModel(
    val deviceId: String,
    val primaryName: String,
    val secondaryName: String?,
    val status: String,
    val detail: String?,
    val isCurrent: Boolean,
    val isConnected: Boolean,
    val isSwitching: Boolean,
    val isVisibleInMenu: Boolean,
) {
    val id: String get() = deviceId

    val menuSubtitle: String
        get() =
            listOfNotNull(status, detail?.takeIf { it.isNotBlank() })
                .joinToString(" · ")

    val compactDisplayName: String
        get() = MyDevicesPresentation.compactDisplayName(primaryName)
}

data class TrustedDevicePresentationContext(
    val records: List<CodexTrustedMacRecord>,
    val currentTrustedMacDeviceId: String?,
    val previousTrustedMacDeviceId: String?,
    val relayMacDeviceId: String?,
    val isConnected: Boolean,
    val switchingDeviceId: String?,
)

object MyDevicesPresentation {
    fun compactDisplayName(rawName: String): String {
        val trimmed = rawName.trim()
        if (trimmed.isEmpty()) return "Device"
        if (trimmed.lowercase().endsWith(".local")) {
            return trimmed.dropLast(6)
        }
        return trimmed
    }

    fun sortedRecords(context: TrustedDevicePresentationContext): List<CodexTrustedMacRecord> = context.records.sortedWith { lhs, rhs -> compareRecords(lhs, rhs, context) }

    fun rowModels(context: TrustedDevicePresentationContext): List<MyDeviceRowModel> = sortedRecords(context).map { record -> rowModel(record, context) }

    fun switcherRows(context: TrustedDevicePresentationContext): List<MyDeviceRowModel> =
        rowModels(context).filter { row ->
            row.isVisibleInMenu || row.isCurrent || row.isSwitching
        }

    fun activeSwitcherRow(context: TrustedDevicePresentationContext): MyDeviceRowModel? {
        val rows = rowModels(context)
        return rows.firstOrNull { it.isCurrent }
            ?: rows.firstOrNull { it.isConnected }
            ?: rows.firstOrNull { it.isSwitching }
    }

    fun rowModel(
        trustedMac: CodexTrustedMacRecord,
        context: TrustedDevicePresentationContext,
    ): MyDeviceRowModel {
        val identity = displayIdentity(trustedMac)
        return MyDeviceRowModel(
            deviceId = trustedMac.macDeviceId,
            primaryName = identity.first,
            secondaryName = identity.second,
            status = statusLabel(trustedMac, context),
            detail = detailLabel(trustedMac, context.switchingDeviceId),
            isCurrent = trustedMac.macDeviceId == context.currentTrustedMacDeviceId,
            isConnected = trustedMac.macDeviceId == context.relayMacDeviceId && context.isConnected,
            isSwitching = trustedMac.macDeviceId == context.switchingDeviceId,
            isVisibleInMenu = MyDeviceMenuVisibilityStore.isVisible(trustedMac.macDeviceId),
        )
    }

    fun shouldShowDeviceSwitcher(context: TrustedDevicePresentationContext): Boolean = switcherRows(context).size > 1

    private fun displayIdentity(trustedMac: CodexTrustedMacRecord): Pair<String, String?> {
        val nickname = SidebarComputerNicknameStore.nickname(trustedMac.macDeviceId).trim()
        val systemName = trustedMac.displayName?.trim().orEmpty()
        return when {
            nickname.isNotEmpty() && systemName.isNotEmpty() -> nickname to systemName
            nickname.isNotEmpty() -> nickname to null
            systemName.isNotEmpty() -> systemName to null
            else -> "Device" to null
        }
    }

    private fun statusLabel(
        trustedMac: CodexTrustedMacRecord,
        context: TrustedDevicePresentationContext,
    ): String =
        when {
            trustedMac.macDeviceId == context.switchingDeviceId -> "Switching"
            trustedMac.macDeviceId == context.relayMacDeviceId && context.isConnected -> "Connected"
            trustedMac.macDeviceId == context.currentTrustedMacDeviceId -> "Selected"
            trustedMac.macDeviceId == context.previousTrustedMacDeviceId -> "Previous"
            else -> "Saved"
        }

    private fun detailLabel(
        trustedMac: CodexTrustedMacRecord,
        switchingDeviceId: String?,
    ): String? {
        if (trustedMac.macDeviceId == switchingDeviceId) {
            return "Reloading chats"
        }
        val reference = trustedMac.lastUsedAt ?: trustedMac.lastPairedAt
        return relativeLastUsedLabel(reference)
    }

    fun relativeLastUsedLabel(
        reference: Instant,
        now: Instant = Instant.now(),
    ): String {
        val minutes = ChronoUnit.MINUTES.between(reference, now).coerceAtLeast(0)
        return when {
            minutes < 1 -> "just now"
            minutes < 60 -> "${minutes}m ago"
            minutes < 60 * 24 -> "${minutes / 60}h ago"
            minutes < 60 * 24 * 7 -> "${minutes / (60 * 24)}d ago"
            else -> "${minutes / (60 * 24 * 7)}w ago"
        }
    }

    private fun compareRecords(
        lhs: CodexTrustedMacRecord,
        rhs: CodexTrustedMacRecord,
        context: TrustedDevicePresentationContext,
    ): Int {
        fun rank(record: CodexTrustedMacRecord): Int =
            when (record.macDeviceId) {
                context.currentTrustedMacDeviceId -> 0
                context.relayMacDeviceId -> 1
                context.previousTrustedMacDeviceId -> 2
                else ->
                    when {
                        hasResolvedTrustedSession(record) -> 3
                        else -> 4
                    }
            }
        val lhsRank = rank(lhs)
        val rhsRank = rank(rhs)
        if (lhsRank != rhsRank) return lhsRank - rhsRank
        return trustedMacActivityDate(rhs).compareTo(trustedMacActivityDate(lhs))
    }

    private fun hasResolvedTrustedSession(trustedMac: CodexTrustedMacRecord): Boolean {
        if (trustedMac.lastResolvedAt != null) return true
        return trustedMac.lastResolvedSessionId?.trim()?.isNotEmpty() == true
    }

    private fun trustedMacActivityDate(trustedMac: CodexTrustedMacRecord): Instant = trustedMac.lastResolvedAt ?: trustedMac.lastUsedAt ?: trustedMac.lastPairedAt
}

fun TrustedDevicePresentationContext.isConnectedToRelay(): Boolean = isConnected

fun ConnectionState.isConnectedNow(): Boolean = this is ConnectionState.Connected
