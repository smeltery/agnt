package com.dotbrains.agnt.mobile.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ActiveProviderTest {
    @Test
    fun fromBridgeIdRecognizesKnownProviders() {
        assertEquals(ActiveProvider.Codex, ActiveProvider.fromBridgeId("codex"))
        assertEquals(ActiveProvider.Claude, ActiveProvider.fromBridgeId("claude"))
        assertEquals(ActiveProvider.Opencode, ActiveProvider.fromBridgeId("opencode"))
        assertEquals(ActiveProvider.Cursor, ActiveProvider.fromBridgeId("cursor"))
    }

    @Test
    fun fromBridgeIdIsCaseInsensitive() {
        assertEquals(ActiveProvider.Codex, ActiveProvider.fromBridgeId("Codex"))
        assertEquals(ActiveProvider.Claude, ActiveProvider.fromBridgeId("CLAUDE"))
    }

    @Test
    fun fromBridgeIdTrimsWhitespace() {
        assertEquals(ActiveProvider.Codex, ActiveProvider.fromBridgeId("  codex  "))
    }

    @Test
    fun fromBridgeIdFallsBackToUnknown() {
        // Empty or null -> Unknown so older bridges (no providerId on initialize)
        // don't accidentally light up gates.
        assertEquals(ActiveProvider.Unknown, ActiveProvider.fromBridgeId(null))
        assertEquals(ActiveProvider.Unknown, ActiveProvider.fromBridgeId(""))
        assertEquals(ActiveProvider.Unknown, ActiveProvider.fromBridgeId("   "))
        // Unrecognized provider id -> Unknown (don't crash, don't gate).
        assertEquals(ActiveProvider.Unknown, ActiveProvider.fromBridgeId("future-provider"))
    }

    @Test
    fun isCodexOnlyTrueForCodex() {
        assertTrue(ActiveProvider.Codex.isCodex)
        for (provider in ActiveProvider.entries) {
            if (provider != ActiveProvider.Codex) {
                assertEquals(false, provider.isCodex, "$provider should not be reported as Codex")
            }
        }
    }
}
