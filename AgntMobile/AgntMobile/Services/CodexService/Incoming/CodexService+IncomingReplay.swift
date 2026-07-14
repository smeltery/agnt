// FILE: CodexService+IncomingReplay.swift
// Purpose: Buffered replay discontinuity handling.
// Layer: Service
// Exports: CodexService replay event helpers

import Foundation

extension CodexService {
    func isBufferedReplayGapEvent(method: String, paramsObject: IncomingParamsObject?) -> Bool {
        method == "agnt/bufferedReplay/gap"
            || paramsObject?["agntBufferedReplayGap"]?.boolValue == true
    }

    func isBufferedReplayResetEvent(method: String, paramsObject: IncomingParamsObject?) -> Bool {
        method == "agnt/bufferedReplay/reset"
            || paramsObject?["agntBufferedReplayReset"]?.boolValue == true
    }

    func handleBufferedReplayReset(_ paramsObject: IncomingParamsObject?) {
        guard let resetSequence = paramsObject?["resetBridgeOutboundSeqTo"]?.intValue else {
            return
        }
        setBridgeOutboundReplayCursor(to: resetSequence)
        if let replayEpoch = paramsObject?["bridgeReplayEpoch"]?.stringValue {
            setBridgeReplayEpoch(to: replayEpoch)
        }
        markReplayDiscontinuityForCanonicalRefresh()
    }

    func handleBufferedReplayGap(_ paramsObject: IncomingParamsObject?) {
        guard let discardedThrough = paramsObject?["lastDiscardedBridgeOutboundSeq"]?.intValue,
              discardedThrough > lastAppliedBridgeOutboundSeq else {
            return
        }
        advanceBridgeOutboundReplayCursor(to: discardedThrough)
        markReplayDiscontinuityForCanonicalRefresh()
    }

    func markReplayDiscontinuityForCanonicalRefresh() {
        clearHydrationCaches()
        pendingCanonicalHistoryRefreshAfterReplayDiscontinuity = true
        flushPendingReplayDiscontinuityHistoryRefresh()
    }

    func flushPendingReplayDiscontinuityHistoryRefresh() {
        guard pendingCanonicalHistoryRefreshAfterReplayDiscontinuity,
              isConnected,
              isInitialized,
              activeThreadId != nil else {
            return
        }
        pendingCanonicalHistoryRefreshAfterReplayDiscontinuity = false
        requestImmediateActiveThreadSync()
    }

    func normalizedResolvedRequestThreadID(_ rawValue: String?) -> String? {
        guard let rawValue else {
            return nil
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
