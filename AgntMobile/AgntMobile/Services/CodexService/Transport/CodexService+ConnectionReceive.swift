// FILE: CodexService+ConnectionReceive.swift
// Purpose: Receive-side disconnect handling for CodexService transport.
// Layer: Service

import Foundation
import Network

extension CodexService {
    func handleReceiveError(
        _ error: Error,
        relayCloseCode: NWProtocolWebSocket.CloseCode? = nil
    ) {
        if Task.isCancelled {
            return
        }

        cancelCurrentSocketConnection()

        let disposition = receiveErrorDisposition(for: error, relayCloseCode: relayCloseCode)
        isConnected = false
        isInitialized = false
        shouldAutoReconnectOnForeground = disposition.shouldAutoReconnectOnForeground
        if disposition.shouldClearSavedRelaySession {
            clearSavedRelaySession()
        } else {
            // Reset volatile secure state so reconnect UI does not keep showing the last encrypted session.
            resetSecureTransportState()
        }
        // Leave trusted reconnect failure accounting to the outer connect attempt so
        // one transport drop cannot burn the retry budget twice.
        if disposition.shouldClearSavedRelaySession || !shouldAutoReconnectOnForeground {
            trustedReconnectFailureCount = 0
        }
        connectionRecoveryState = disposition.connectionRecoveryState
        lastErrorMessage = disposition.lastErrorMessage
        finalizeAllStreamingState()
        endBackgroundRunGraceTask(reason: "receive-error")
        clearConnectionSyncState()
        // Thread resumes are transport-scoped; a fresh socket must be allowed to
        // issue `thread/resume` again for desktop-origin threads after recovery.
        resumedThreadIDs.removeAll()
        failAllPendingRequests(with: error)
    }
}
