// FILE: CodexService+SecureReplayState.swift
// Purpose: Persists secure bridge replay cursor state.
// Layer: Service
// Exports: CodexService replay cursor helpers
// Depends on: Foundation

import Foundation

extension CodexService {
    func advanceBridgeOutboundReplayCursor(to bridgeOutboundSeq: Int) {
        guard bridgeOutboundSeq > lastAppliedBridgeOutboundSeq else {
            return
        }
        setBridgeOutboundReplayCursor(to: bridgeOutboundSeq)
    }

    func setBridgeOutboundReplayCursor(to bridgeOutboundSeq: Int) {
        let normalizedSequence = max(0, bridgeOutboundSeq)
        lastAppliedBridgeOutboundSeq = normalizedSequence
        if var session = secureSession {
            session.lastInboundBridgeOutboundSeq = normalizedSequence
            secureSession = session
        }
        SecureStore.writeString(
            String(normalizedSequence),
            for: CodexSecureKeys.relayLastAppliedBridgeOutboundSeq
        )
    }

    func setBridgeReplayEpoch(to replayEpoch: String?) {
        let normalizedEpoch = replayEpoch?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let normalizedEpoch, !normalizedEpoch.isEmpty else {
            lastAppliedBridgeReplayEpoch = nil
            SecureStore.deleteValue(for: CodexSecureKeys.relayBridgeReplayEpoch)
            return
        }
        lastAppliedBridgeReplayEpoch = normalizedEpoch
        SecureStore.writeString(normalizedEpoch, for: CodexSecureKeys.relayBridgeReplayEpoch)
    }
}
