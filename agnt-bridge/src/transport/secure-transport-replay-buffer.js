const {
  SECURE_SENDER_MAC,
  encryptEnvelopePayload,
  safeParseJSON,
} = require("./secure-transport-crypto");

function createSecureTransportReplayBuffer({
  bridgeReplayEpoch,
  getActiveSession,
  getLastRelayedBridgeOutboundSeq,
  getSessionId,
  maxOutboundBytes,
  maxOutboundMessages,
  protocolVersion,
  setLastRelayedBridgeOutboundSeq,
}) {
  let nextBridgeOutboundSeq = 1;
  let outboundBufferBytes = 0;
  const outboundBuffer = [];

  function queueOutboundApplicationMessage(payloadText, sendWireMessage) {
    const bufferEntry = {
      bridgeOutboundSeq: nextBridgeOutboundSeq,
      payloadText,
      sizeBytes: Buffer.byteLength(payloadText, "utf8"),
    };
    nextBridgeOutboundSeq += 1;
    outboundBuffer.push(bufferEntry);
    outboundBufferBytes += bufferEntry.sizeBytes;
    trimOutboundBuffer();

    const activeSession = getActiveSession();
    const liveSessionSender = activeSession?.sendWireMessage;
    const effectiveSendWireMessage = typeof liveSessionSender === "function"
      ? liveSessionSender
      : sendWireMessage;
    if (activeSession?.isResumed && typeof effectiveSendWireMessage === "function") {
      sendBufferedEntry(bufferEntry, effectiveSendWireMessage);
    }
  }

  function nextSeq() {
    return nextBridgeOutboundSeq;
  }

  function handleResumeState({
    activeSession,
    lastAppliedBridgeOutboundSeq,
    phoneReplayEpoch,
  }) {
    if (!activeSession) {
      return;
    }

    let effectiveReplayCursor = lastAppliedBridgeOutboundSeq;
    activeSession.isResumed = true;
    if (phoneReplayEpoch !== bridgeReplayEpoch || lastAppliedBridgeOutboundSeq >= nextBridgeOutboundSeq) {
      effectiveReplayCursor = Math.max(0, activeSession.firstOutboundSeq - 1);
      sendBufferedReplayResetMarker(
        activeSession.sendWireMessage,
        effectiveReplayCursor,
        bridgeReplayEpoch
      );
    }

    setLastRelayedBridgeOutboundSeq(effectiveReplayCursor);
    let missingEntries = replayableOutboundEntries(effectiveReplayCursor, {
      includeCurrentSessionEntries: true,
    });
    const replayGap = bufferedReplayGapAfter(effectiveReplayCursor);
    if (replayGap) {
      sendBufferedReplayGapMarker(activeSession.sendWireMessage, replayGap);
      sendBufferedReplayCompleteMarker(activeSession.sendWireMessage);
      missingEntries = missingEntries.filter((entry) => (
        entry.bridgeOutboundSeq > replayGap.lastDiscardedBridgeOutboundSeq
      ));
    }
    let replayedHistoricalBacklog = false;
    for (const entry of missingEntries) {
      const outboundEntry = replayTaggedEntryIfHistorical(entry);
      if (!sendBufferedEntry(outboundEntry, activeSession.sendWireMessage)) {
        return;
      }
      if (outboundEntry !== entry) {
        replayedHistoricalBacklog = true;
      }
    }
    if (replayedHistoricalBacklog) {
      sendBufferedReplayCompleteMarker(activeSession.sendWireMessage);
    }
  }

  function replayBufferedOutboundMessages() {
    const activeSession = getActiveSession();
    if (!activeSession?.isResumed || typeof activeSession.sendWireMessage !== "function") {
      return;
    }

    let replayEntries = replayableOutboundEntries(getLastRelayedBridgeOutboundSeq());
    const replayGap = bufferedReplayGapAfter(getLastRelayedBridgeOutboundSeq());
    if (replayGap) {
      sendBufferedReplayGapMarker(activeSession.sendWireMessage, replayGap);
      sendBufferedReplayCompleteMarker(activeSession.sendWireMessage);
      replayEntries = replayEntries.filter((entry) => (
        entry.bridgeOutboundSeq > replayGap.lastDiscardedBridgeOutboundSeq
      ));
    }

    let replayedHistoricalBacklog = false;
    for (const entry of replayEntries) {
      const outboundEntry = replayTaggedEntryIfHistorical(entry);
      if (!sendBufferedEntry(outboundEntry, activeSession.sendWireMessage)) {
        return;
      }
      if (outboundEntry !== entry) {
        replayedHistoricalBacklog = true;
      }
    }
    if (replayedHistoricalBacklog) {
      sendBufferedReplayCompleteMarker(activeSession.sendWireMessage);
    }
  }

  // Starts each fresh QR bootstrap with a clean catch-up window for the single trusted phone.
  function resetOutboundReplayState() {
    outboundBuffer.length = 0;
    outboundBufferBytes = 0;
    setLastRelayedBridgeOutboundSeq(0);
    nextBridgeOutboundSeq = 1;
  }

  function trimOutboundBuffer() {
    let removeCount = 0;
    let removedBytes = 0;
    while (
      (outboundBuffer.length - removeCount) > maxOutboundMessages
      || (outboundBufferBytes - removedBytes) > maxOutboundBytes
    ) {
      const entry = outboundBuffer[removeCount];
      if (!entry) {
        break;
      }
      removedBytes += entry.sizeBytes;
      removeCount += 1;
    }
    if (removeCount > 0) {
      outboundBuffer.splice(0, removeCount);
      outboundBufferBytes = Math.max(0, outboundBufferBytes - removedBytes);
    }
  }

  function sendBufferedEntry(entry, sendWireMessage) {
    const activeSession = getActiveSession();
    if (!activeSession?.isResumed || typeof sendWireMessage !== "function") {
      return false;
    }

    const envelope = encryptEnvelopePayload(
      {
        bridgeOutboundSeq: entry.bridgeOutboundSeq,
        payloadText: entry.payloadText,
      },
      activeSession.macToPhoneKey,
      SECURE_SENDER_MAC,
      activeSession.nextOutboundCounter,
      getSessionId(),
      activeSession.keyEpoch,
      protocolVersion
    );
    activeSession.nextOutboundCounter += 1;
    return sendWireMessage(JSON.stringify(envelope)) !== false;
  }

  function replayableOutboundEntries(
    lastAppliedBridgeOutboundSeq,
    { includeCurrentSessionEntries = false } = {}
  ) {
    const activeSession = getActiveSession();
    return outboundBuffer.filter((entry) => {
      if (entry.bridgeOutboundSeq > lastAppliedBridgeOutboundSeq) {
        return true;
      }

      // Stale cursors from a previous Mac/session must not suppress responses
      // produced after this secure channel became active, including initialize.
      return includeCurrentSessionEntries
        && activeSession
        && entry.bridgeOutboundSeq >= activeSession.firstOutboundSeq;
    });
  }

  function bufferedReplayGapAfter(lastAppliedBridgeOutboundSeq) {
    const activeSession = getActiveSession();
    const firstUnappliedEntry = outboundBuffer.find((entry) => (
      entry.bridgeOutboundSeq > lastAppliedBridgeOutboundSeq
    ));
    if (
      !firstUnappliedEntry
      || firstUnappliedEntry.bridgeOutboundSeq <= lastAppliedBridgeOutboundSeq + 1
    ) {
      return null;
    }

    const lastAvailableBridgeOutboundSeq = outboundBuffer[outboundBuffer.length - 1]?.bridgeOutboundSeq
      || firstUnappliedEntry.bridgeOutboundSeq;
    const historicalBoundary = (activeSession?.firstOutboundSeq || firstUnappliedEntry.bridgeOutboundSeq) - 1;
    const lastDiscardedBridgeOutboundSeq = firstUnappliedEntry.bridgeOutboundSeq <= historicalBoundary
      ? historicalBoundary
      : lastAvailableBridgeOutboundSeq;
    return {
      expectedBridgeOutboundSeq: lastAppliedBridgeOutboundSeq + 1,
      firstAvailableBridgeOutboundSeq: firstUnappliedEntry.bridgeOutboundSeq,
      lastDiscardedBridgeOutboundSeq: Math.max(lastAppliedBridgeOutboundSeq, lastDiscardedBridgeOutboundSeq),
    };
  }

  function sendBufferedReplayGapMarker(sendWireMessage, replayGap) {
    const activeSession = getActiveSession();
    if (!activeSession?.isResumed || typeof sendWireMessage !== "function" || !replayGap) {
      return;
    }

    sendTransientReplayMarker(sendWireMessage, {
      method: "agnt/bufferedReplay/gap",
      params: {
        agntBufferedReplayGap: true,
        ...replayGap,
      },
    });
  }

  function sendBufferedReplayResetMarker(
    sendWireMessage,
    resetBridgeOutboundSeqTo,
    replayEpoch
  ) {
    const activeSession = getActiveSession();
    if (!activeSession?.isResumed || typeof sendWireMessage !== "function") {
      return;
    }

    sendTransientReplayMarker(sendWireMessage, {
      method: "agnt/bufferedReplay/reset",
      params: {
        agntBufferedReplayReset: true,
        resetBridgeOutboundSeqTo,
        bridgeReplayEpoch: replayEpoch,
      },
    });
  }

  function sendBufferedReplayCompleteMarker(sendWireMessage) {
    const activeSession = getActiveSession();
    if (!activeSession?.isResumed || typeof sendWireMessage !== "function") {
      return;
    }

    sendTransientReplayMarker(sendWireMessage, {
      method: "agnt/bufferedReplay/completed",
      params: { agntBufferedReplayComplete: true },
    });
  }

  function sendTransientReplayMarker(sendWireMessage, payload) {
    const activeSession = getActiveSession();
    const envelope = encryptEnvelopePayload(
      {
        payloadText: JSON.stringify(payload),
      },
      activeSession.macToPhoneKey,
      SECURE_SENDER_MAC,
      activeSession.nextOutboundCounter,
      getSessionId(),
      activeSession.keyEpoch,
      protocolVersion
    );
    activeSession.nextOutboundCounter += 1;
    sendWireMessage(JSON.stringify(envelope));
  }

  // Only prior secure-session backlog is catch-up history; same-session retries
  // may be the phone's first delivery of a still-live turn.
  function replayTaggedEntryIfHistorical(entry) {
    const activeSession = getActiveSession();
    if (
      !activeSession
      || entry.bridgeOutboundSeq >= activeSession.firstOutboundSeq
    ) {
      return entry;
    }

    return replayTaggedEntry(entry);
  }

  // Marks replayed notifications so clients hydrate them as catch-up content
  // instead of live activity. RPC responses and non-object params pass through.
  function replayTaggedEntry(entry) {
    const parsed = safeParseJSON(entry.payloadText);
    if (
      !parsed
      || typeof parsed.method !== "string"
      || parsed.id !== undefined
      || !parsed.params
      || typeof parsed.params !== "object"
      || Array.isArray(parsed.params)
    ) {
      return entry;
    }

    parsed.params.agntReplayedEvent = true;
    return {
      bridgeOutboundSeq: entry.bridgeOutboundSeq,
      payloadText: JSON.stringify(parsed),
      sizeBytes: entry.sizeBytes,
    };
  }

  return {
    handleResumeState,
    nextSeq,
    queueOutboundApplicationMessage,
    replayBufferedOutboundMessages,
    resetOutboundReplayState,
  };
}

module.exports = {
  createSecureTransportReplayBuffer,
};
