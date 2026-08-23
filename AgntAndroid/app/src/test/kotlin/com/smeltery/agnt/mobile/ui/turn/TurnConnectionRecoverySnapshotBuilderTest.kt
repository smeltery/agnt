package com.smeltery.agnt.mobile.ui.turn

import com.smeltery.agnt.mobile.core.transport.ConnectionState
import com.smeltery.agnt.mobile.ui.home.RootReconnectAttempt
import com.smeltery.agnt.mobile.ui.home.RootReconnectRecoveryAction
import com.smeltery.agnt.mobile.ui.home.RootReconnectUiState
import com.smeltery.agnt.mobile.ui.turn.recovery.TurnConnectionRecoverySnapshotBuilder
import com.smeltery.agnt.mobile.ui.turn.recovery.TurnConnectionRecoveryStatus
import com.smeltery.agnt.mobile.ui.turn.recovery.TurnConnectionRecoveryTrailing
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TurnConnectionRecoverySnapshotBuilderTest {
    @Test
    fun makeSnapshot_hidesWhenConnectedOrNoCandidate() {
        assertNull(
            TurnConnectionRecoverySnapshotBuilder.makeSnapshot(
                hasReconnectCandidate = false,
                connectionState = ConnectionState.Offline,
                reconnectUiState = RootReconnectUiState(),
            ),
        )
        assertNull(
            TurnConnectionRecoverySnapshotBuilder.makeSnapshot(
                hasReconnectCandidate = true,
                connectionState = ConnectionState.Connected,
                reconnectUiState = RootReconnectUiState(lastErrorMessage = "Lost"),
            ),
        )
    }

    @Test
    fun makeSnapshot_showsProgressWhileReconnecting() {
        val snapshot =
            TurnConnectionRecoverySnapshotBuilder.makeSnapshot(
                hasReconnectCandidate = true,
                connectionState = ConnectionState.Connecting,
                reconnectUiState = RootReconnectUiState(),
            )

        assertEquals(TurnConnectionRecoveryStatus.Reconnecting, snapshot?.status)
        assertEquals(TurnConnectionRecoveryTrailing.Progress, snapshot?.trailing)
    }

    @Test
    fun makeSnapshot_prefersWakeAndScanActions() {
        val wake =
            TurnConnectionRecoverySnapshotBuilder.makeSnapshot(
                hasReconnectCandidate = true,
                connectionState = ConnectionState.Error("Lost"),
                reconnectUiState =
                    RootReconnectUiState(
                        lastErrorMessage = "Wake first.",
                        wakeDisplayAvailable = true,
                    ),
            )
        assertEquals(TurnConnectionRecoveryTrailing.Action("Wake"), wake?.trailing)
        assertEquals("Wake first.", wake?.summary)

        val scan =
            TurnConnectionRecoverySnapshotBuilder.makeSnapshot(
                hasReconnectCandidate = true,
                connectionState = ConnectionState.Error("Pairing lost"),
                reconnectUiState =
                    RootReconnectUiState(
                        recoveryAction = RootReconnectRecoveryAction.ScanNewQr,
                    ),
            )
        assertEquals(TurnConnectionRecoveryTrailing.Action("Scan QR"), scan?.trailing)
    }

    @Test
    fun makeSnapshot_wakeAttemptUsesProgress() {
        val snapshot =
            TurnConnectionRecoverySnapshotBuilder.makeSnapshot(
                hasReconnectCandidate = true,
                connectionState = ConnectionState.Offline,
                reconnectUiState =
                    RootReconnectUiState(
                        attempt = RootReconnectAttempt.WakeDisplay,
                        wakeDisplayAvailable = true,
                    ),
            )

        assertTrue(snapshot?.trailing is TurnConnectionRecoveryTrailing.Progress)
        assertEquals(TurnConnectionRecoveryStatus.Reconnecting, snapshot?.status)
    }
}
