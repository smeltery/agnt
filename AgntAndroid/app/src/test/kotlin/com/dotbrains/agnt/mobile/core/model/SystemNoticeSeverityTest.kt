package com.dotbrains.agnt.mobile.core.model

import kotlin.test.Test
import kotlin.test.assertEquals

class SystemNoticeSeverityTest {
    @Test
    fun fromBridgeValueRecognizesKnownSeverities() {
        assertEquals(SystemNoticeSeverity.Info, SystemNoticeSeverity.fromBridgeValue("info"))
        assertEquals(SystemNoticeSeverity.Warn, SystemNoticeSeverity.fromBridgeValue("warn"))
        assertEquals(SystemNoticeSeverity.Warn, SystemNoticeSeverity.fromBridgeValue("warning"))
        assertEquals(SystemNoticeSeverity.Error, SystemNoticeSeverity.fromBridgeValue("error"))
        assertEquals(SystemNoticeSeverity.Error, SystemNoticeSeverity.fromBridgeValue("danger"))
    }

    @Test
    fun fromBridgeValueIsCaseAndWhitespaceInsensitive() {
        assertEquals(SystemNoticeSeverity.Warn, SystemNoticeSeverity.fromBridgeValue("  WARNING  "))
        assertEquals(SystemNoticeSeverity.Error, SystemNoticeSeverity.fromBridgeValue("Danger"))
    }

    @Test
    fun fromBridgeValueFallsBackToInfo() {
        // Empty / null / unrecognized — parity with agnt-web normalizeSeverity.
        assertEquals(SystemNoticeSeverity.Info, SystemNoticeSeverity.fromBridgeValue(null))
        assertEquals(SystemNoticeSeverity.Info, SystemNoticeSeverity.fromBridgeValue(""))
        assertEquals(SystemNoticeSeverity.Info, SystemNoticeSeverity.fromBridgeValue("   "))
        assertEquals(SystemNoticeSeverity.Info, SystemNoticeSeverity.fromBridgeValue("future-severity"))
    }

    @Test
    fun defaultDurationMatchesSeverity() {
        assertEquals(5_000L, SystemNoticeSeverity.Info.defaultDurationMs)
        assertEquals(8_000L, SystemNoticeSeverity.Warn.defaultDurationMs)
        assertEquals(12_000L, SystemNoticeSeverity.Error.defaultDurationMs)
    }
}
