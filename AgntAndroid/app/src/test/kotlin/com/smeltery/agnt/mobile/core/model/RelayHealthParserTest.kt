package com.smeltery.agnt.mobile.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RelayHealthParserTest {
    @Test
    fun parse_minimalHealth() {
        val snapshot = RelayHealthParser.parse("""{"ok":true}""")
        assertTrue(snapshot.ok)
        assertNull(snapshot.relay)
    }

    @Test
    fun parse_detailedHealthMetrics() {
        val snapshot =
            RelayHealthParser.parse(
                """
                {
                  "ok": true,
                  "relay": {
                    "sessionsWithOpenMac": 1,
                    "sessionsWithStaleMac": 0,
                    "sessionsWithClients": 2,
                    "heartbeatTerminations": 3
                  },
                  "push": { "enabled": false, "registeredDevices": 0 },
                  "runtime": {
                    "eventLoopDelayMs": { "max": 12.5 },
                    "heapUsedMb": 44.2
                  }
                }
                """.trimIndent(),
            )
        assertEquals(1, snapshot.relay?.sessionsWithOpenMac)
        assertEquals(false, snapshot.push?.enabled)
        assertEquals(12.5, snapshot.runtime?.eventLoopDelayMsMax)
    }
}
