import Foundation

extension CodexService {
    func scheduleAsyncAnswerVerification(threadId: String, delay: TimeInterval, retryCount: Int = 0) {
        guard asyncInput.verifying.insert(threadId).inserted else { return }
        let generation = asyncInput.generation
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, self.asyncInput.generation == generation else { return }
            guard self.messagesByThread[threadId]?.contains(where: {
                $0.asyncUserInput?.status == .uncertain || $0.asyncUserInput?.status == .answered
            }) == true else {
                self.asyncInput.verifying.remove(threadId)
                return
            }
            guard self.isConnected, self.isInitialized else {
                self.asyncInput.verifying.remove(threadId)
                return
            }
            do {
                // The initial turns page can omit older items. Verify removal only
                // against a full thread/read, then re-read once more before reopening.
                let threadObject = try await self.fetchLegacyThreadHistoryObject(threadId: threadId)
                guard self.asyncInput.generation == generation else { return }
                let canonical = self.decodeMessagesFromThreadRead(threadId: threadId, threadObject: threadObject)
                if self.canVerifyAsyncAnswerAbsence(threadId: threadId, threadObject: threadObject),
                   var messages = self.messagesByThread[threadId] {
                    let nextDelay = CodexAsyncUserInputProjection.reopenRepliesMissingFromCanonicalHistory(
                        &messages,
                        canonical: canonical
                    )
                    if messages != self.messagesByThread[threadId] {
                        self.messagesByThread[threadId] = messages
                        self.persistMessages()
                        self.updateCurrentOutput(for: threadId)
                    }
                    self.asyncInput.verifying.remove(threadId)
                    if let nextDelay {
                        self.scheduleAsyncAnswerVerification(
                            threadId: threadId,
                            delay: nextDelay,
                            retryCount: retryCount + 1
                        )
                    } else {
                        self.retryUncertainAsyncAnswerVerification(
                            threadId: threadId,
                            delay: delay,
                            retryCount: retryCount
                        )
                    }
                } else {
                    self.asyncInput.verifying.remove(threadId)
                    // A running turn or a read without canonical turns cannot
                    // prove absence. Retry a few times without sending twice.
                    self.retryUncertainAsyncAnswerVerification(
                        threadId: threadId,
                        delay: delay,
                        retryCount: retryCount
                    )
                }
            } catch {
                guard self.asyncInput.generation == generation else { return }
                self.asyncInput.verifying.remove(threadId)
                self.retryUncertainAsyncAnswerVerification(
                    threadId: threadId,
                    delay: delay,
                    retryCount: retryCount
                )
            }
        }
    }

    private func retryUncertainAsyncAnswerVerification(
        threadId: String,
        delay: TimeInterval,
        retryCount: Int
    ) {
        guard retryCount < 5,
              isConnected, isInitialized,
              messagesByThread[threadId]?.contains(where: { $0.asyncUserInput?.status == .uncertain }) == true else {
            return
        }
        scheduleAsyncAnswerVerification(
            threadId: threadId,
            delay: min(max(delay * 2, 5), 30),
            retryCount: retryCount + 1
        )
    }

    func canVerifyAsyncAnswerAbsence(threadId: String, threadObject: RPCObject) -> Bool {
        guard !threadHasActiveOrRunningTurn(threadId),
              let turns = threadObject["turns"]?.arrayValue else { return false }
        let snapshot = turnStateSnapshot(from: turns.compactMap(\.objectValue), newestFirst: false)
        return snapshot.interruptibleTurnID == nil && !snapshot.hasInterruptibleTurnWithoutID
    }

}
