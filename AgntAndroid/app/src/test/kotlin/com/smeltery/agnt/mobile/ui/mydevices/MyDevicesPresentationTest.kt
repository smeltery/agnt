package com.smeltery.agnt.mobile.ui.mydevices

import com.smeltery.agnt.mobile.core.model.CodexTrustedMacRecord
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MyDevicesPresentationTest {
    private val macA =
        CodexTrustedMacRecord(
            macDeviceId = "mac-a",
            macIdentityPublicKey = "key-a",
            lastPairedAt = Instant.parse("2026-05-01T10:00:00Z"),
            displayName = "Studio.local",
            lastUsedAt = Instant.parse("2026-05-20T10:00:00Z"),
        )
    private val macB =
        CodexTrustedMacRecord(
            macDeviceId = "mac-b",
            macIdentityPublicKey = "key-b",
            lastPairedAt = Instant.parse("2026-05-02T10:00:00Z"),
            displayName = "Laptop",
            lastUsedAt = Instant.parse("2026-05-21T10:00:00Z"),
        )

    @Test
    fun compactDisplayName_stripsLocalSuffix() {
        assertEquals("Studio", MyDevicesPresentation.compactDisplayName("Studio.local"))
    }

    @Test
    fun rowModels_sortCurrentBeforeOthers() {
        val context =
            TrustedDevicePresentationContext(
                records = listOf(macB, macA),
                currentTrustedMacDeviceId = "mac-a",
                previousTrustedMacDeviceId = null,
                relayMacDeviceId = "mac-b",
                isConnected = true,
                switchingDeviceId = null,
            )
        val rows = MyDevicesPresentation.rowModels(context)
        assertEquals("mac-a", rows.first().deviceId)
        assertEquals("Selected", rows.first { it.deviceId == "mac-a" }.status)
        assertEquals("Connected", rows.first { it.deviceId == "mac-b" }.status)
    }

    @Test
    fun shouldShowDeviceSwitcher_falseForSingleVisibleDevice() {
        val context =
            TrustedDevicePresentationContext(
                records = listOf(macA),
                currentTrustedMacDeviceId = "mac-a",
                previousTrustedMacDeviceId = null,
                relayMacDeviceId = "mac-a",
                isConnected = true,
                switchingDeviceId = null,
            )
        assertFalse(MyDevicesPresentation.shouldShowDeviceSwitcher(context))
    }

    @Test
    fun shouldShowDeviceSwitcher_trueForMultipleVisibleDevices() {
        MyDeviceMenuVisibilityStore.setVisible(true, "mac-a")
        MyDeviceMenuVisibilityStore.setVisible(true, "mac-b")
        val context =
            TrustedDevicePresentationContext(
                records = listOf(macA, macB),
                currentTrustedMacDeviceId = "mac-a",
                previousTrustedMacDeviceId = null,
                relayMacDeviceId = "mac-a",
                isConnected = true,
                switchingDeviceId = null,
            )
        assertTrue(MyDevicesPresentation.shouldShowDeviceSwitcher(context))
    }

    @Test
    fun switcherRows_includeVisibleCurrentAndSwitchingDevicesOnly() {
        MyDeviceMenuVisibilityStore.setVisible(false, "mac-a")
        MyDeviceMenuVisibilityStore.setVisible(false, "mac-b")
        MyDeviceMenuVisibilityStore.setVisible(false, "mac-c")
        val macC =
            CodexTrustedMacRecord(
                macDeviceId = "mac-c",
                macIdentityPublicKey = "key-c",
                lastPairedAt = Instant.parse("2026-05-03T10:00:00Z"),
                displayName = "Mini",
            )
        val context =
            TrustedDevicePresentationContext(
                records = listOf(macA, macB, macC),
                currentTrustedMacDeviceId = "mac-a",
                previousTrustedMacDeviceId = null,
                relayMacDeviceId = "mac-a",
                isConnected = true,
                switchingDeviceId = "mac-b",
            )

        assertEquals(listOf("mac-a", "mac-b"), MyDevicesPresentation.switcherRows(context).map { it.deviceId })
    }

    @Test
    fun activeSwitcherRow_prefersCurrentDevice() {
        val context =
            TrustedDevicePresentationContext(
                records = listOf(macA, macB),
                currentTrustedMacDeviceId = "mac-a",
                previousTrustedMacDeviceId = null,
                relayMacDeviceId = "mac-b",
                isConnected = true,
                switchingDeviceId = null,
            )

        assertEquals("mac-a", MyDevicesPresentation.activeSwitcherRow(context)?.deviceId)
    }

    @Test
    fun switchingDevice_showsSwitchingStatusAndDetail() {
        val context =
            TrustedDevicePresentationContext(
                records = listOf(macA, macB),
                currentTrustedMacDeviceId = "mac-a",
                previousTrustedMacDeviceId = null,
                relayMacDeviceId = "mac-a",
                isConnected = false,
                switchingDeviceId = "mac-b",
            )
        val row = MyDevicesPresentation.rowModels(context).first { it.deviceId == "mac-b" }
        assertEquals("Switching", row.status)
        assertEquals("Reloading chats", row.detail)
    }

    @Test
    fun menuSubtitle_usesReadableSeparator() {
        val row =
            MyDeviceRowModel(
                deviceId = "mac-a",
                primaryName = "Studio",
                secondaryName = null,
                status = "Saved",
                detail = "3w ago",
                isCurrent = false,
                isConnected = false,
                isSwitching = false,
                isVisibleInMenu = true,
            )

        assertEquals("Saved · 3w ago", row.menuSubtitle)
    }
}
