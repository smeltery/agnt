import Foundation

extension CodexService {
    static let locallyArchivedThreadIDsKey = "codex.locallyArchivedThreadIDs"
    func threadHasPendingAsyncUserInput(_ threadId: String) -> Bool {
        messagesByThread[threadId]?.contains { message in
            guard let status = message.asyncUserInput?.status else { return false }
            return status == .unanswered || status == .uncertain
        } == true
    }

    /// Keeps the question on its original assistant item, including question-only items.
    func upsertAsyncUserInput(
        _ input: CodexAsyncUserInput,
        threadId: String,
        turnId: String?,
        itemId: String?,
        text: String,
        completed: Bool
    ) {
        guard let itemId, !itemId.isEmpty else { return }
        if let index = messagesByThread[threadId]?.lastIndex(where: {
            $0.role == .assistant && $0.itemId == itemId
        }) {
            let old = messagesByThread[threadId]![index]
            messagesByThread[threadId]?[index].asyncUserInput = .merge(local: old.asyncUserInput, incoming: input)
            if old.turnId == nil { messagesByThread[threadId]?[index].turnId = turnId }
            if completed { messagesByThread[threadId]?[index].isStreaming = false }
            if !text.isEmpty { messagesByThread[threadId]?[index].text = text }
        } else {
            appendMessage(CodexMessage(
                id: Self.stableAssistantMessageID(threadId: threadId, turnId: turnId, itemId: itemId)
                    ?? UUID().uuidString,
                threadId: threadId,
                role: .assistant,
                text: text,
                turnId: turnId,
                itemId: itemId,
                isStreaming: !completed,
                asyncUserInput: input
            ))
        }
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    func submitAsyncUserInput(threadId: String, messageID: String, answers: [String]) async {
        guard let index = messagesByThread[threadId]?.firstIndex(where: { $0.id == messageID }),
              var input = messagesByThread[threadId]?[index].asyncUserInput,
              input.status == .unanswered,
              answers.count == input.questions.count,
              answers.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { return }
        input.answers = answers.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let responseText = input.responseText else { return }
        setAsyncUserInputError(nil, threadId: threadId)
        guard isConnected, isInitialized else {
            messagesByThread[threadId]?[index].asyncUserInput = input
            persistMessages()
            updateCurrentOutput(for: threadId)
            setAsyncUserInputError("Reconnect to send your answer.", threadId: threadId)
            return
        }
        let responseMessageID = appendUserMessage(threadId: threadId, text: responseText)
        guard !responseMessageID.isEmpty else { return }
        if let userIndex = findMessageIndex(threadId: threadId, messageId: responseMessageID) {
            messagesByThread[threadId]?[userIndex].kind = .asyncUserInputAnswer
        }
        input.responseMessageID = responseMessageID
        input.responseRecordedAt = Date()
        input.status = .submitting
        messagesByThread[threadId]?[index].asyncUserInput = input
        persistMessages()
        updateCurrentOutput(for: threadId)
        await deliverAsyncUserInput(threadId: threadId, messageID: messageID)
    }

    private func deliverAsyncUserInput(threadId: String, messageID: String) async {
        guard let index = messagesByThread[threadId]?.firstIndex(where: { $0.id == messageID }),
              let input = messagesByThread[threadId]?[index].asyncUserInput,
              let responseText = input.responseText,
              let responseMessageID = input.responseMessageID,
              input.status == .submitting || input.status == .queued else { return }

        let generation = asyncInput.generation
        var deliveryMayHaveStarted = false
        do {
            guard isConnected, isInitialized else { throw CodexServiceError.disconnected }
            if threadHasActiveOrRunningTurn(threadId) {
                let turnID = try await resolveInFlightTurnID(threadId: threadId)
                guard generation == asyncInput.generation else { return }
                guard let turnID, !CodexSyntheticIdentifiers.isBridgeMintedTurnID(turnID) else {
                    setAsyncUserInputStatus(.queued, threadId: threadId, messageID: messageID)
                    await refreshAndFlushQueuedAsyncInput(threadId: threadId)
                    return
                }
                // The turn may have completed while resolving its id. In that
                // case the reply belongs in a new turn, not a stale steer.
                guard threadHasActiveOrRunningTurn(threadId) else {
                    setAsyncUserInputStatus(.queued, threadId: threadId, messageID: messageID)
                    await flushQueuedAsyncUserInput(threadId: threadId)
                    return
                }
                let payload: RPCObject = [
                    "threadId": .string(threadId),
                    "expectedTurnId": .string(turnID),
                    "clientUserMessageId": .string(responseMessageID),
                    "input": .array([.object([
                        "type": .string("text"),
                        "text": .string(responseText),
                        "text_elements": .array([]),
                    ])]),
                ]
                guard isConnected, isInitialized else { throw CodexServiceError.disconnected }
                _ = try await sendRequest(
                    method: "turn/steer",
                    params: .object(payload),
                    timeoutNanoseconds: 30_000_000_000,
                    timeoutMessage: "The answer may have reached the agent, but confirmation timed out. Check on your computer.",
                    onDispatch: { deliveryMayHaveStarted = true }
                )
                markMessageDeliveryState(
                    threadId: threadId,
                    messageId: responseMessageID,
                    state: .confirmed,
                    turnId: turnID
                )
            } else {
                // Keep answers bound to their original chat; never create a
                // replacement thread when its owner reports it missing.
                try await ensureThreadResumed(threadId: threadId)
                try await waitForRuntimeSettingsUpdate(threadId: threadId)
                guard generation == asyncInput.generation else { return }
                guard !threadHasActiveOrRunningTurn(threadId) else {
                    setAsyncUserInputStatus(.queued, threadId: threadId, messageID: messageID)
                    return
                }
                try await sendTurnStart(
                    responseText, to: threadId, shouldAppendUserMessage: false,
                    preAppendedUserMessageID: responseMessageID,
                    onDispatch: { deliveryMayHaveStarted = true }
                )
            }
            guard generation == asyncInput.generation else { return }
            setAsyncUserInputStatus(.answered, threadId: threadId, messageID: messageID)
            setAsyncUserInputError(nil, threadId: threadId)
        } catch {
            guard generation == asyncInput.generation else { return }
            // History may have confirmed the reply while the request was in flight.
            if messagesByThread[threadId]?.first(where: { $0.id == messageID })?.asyncUserInput?.status == .answered {
                return
            }
            if isActiveTurnNotSteerable(error) {
                setAsyncUserInputStatus(.queued, threadId: threadId, messageID: messageID)
                await refreshAndFlushQueuedAsyncInput(threadId: threadId)
            } else if !deliveryMayHaveStarted || isDefinitiveAsyncAnswerRejection(error) {
                resetAsyncUserInputForRetry(threadId: threadId, messageID: messageID)
                setAsyncUserInputError(error.localizedDescription, threadId: threadId)
            } else {
                // Transport errors can mean the Mac accepted the reply before the socket fell.
                // Preserve the answer and wait for history instead of sending it twice.
                setAsyncUserInputStatus(.uncertain, threadId: threadId, messageID: messageID)
                scheduleAsyncAnswerVerification(threadId: threadId, delay: 3)
            }
        }
    }

    private func setAsyncUserInputError(_ message: String?, threadId: String) {
        let previous = asyncInput.errors[threadId]
        asyncInput.errors[threadId] = message
        if activeThreadId == threadId, (message != nil || lastErrorMessage == previous) {
            lastErrorMessage = message
        }
    }

    func presentAsyncUserInputError(threadId: String) {
        if let lastErrorMessage, asyncInput.errors.contains(where: { $0.key != threadId && $0.value == lastErrorMessage }) {
            self.lastErrorMessage = asyncInput.errors[threadId]
        } else if let error = asyncInput.errors[threadId] {
            lastErrorMessage = error
        }
    }

    func dismissVisibleError(threadId: String) {
        guard activeThreadId == threadId else { return }
        if lastErrorMessage == asyncInput.errors[threadId] {
            asyncInput.errors.removeValue(forKey: threadId)
        }
        lastErrorMessage = nil
    }

    private func refreshAndFlushQueuedAsyncInput(threadId: String) async {
        if threadHasActiveOrRunningTurn(threadId) {
            await syncActiveThreadState(threadId: threadId)
        }
        await flushQueuedAsyncUserInput(threadId: threadId)
    }

    private func isActiveTurnNotSteerable(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else { return false }
        let normalized = rpcError.message.lowercased().filter(\.isLetter)
        return normalized.contains("activeturnnotsteerable")
            || normalized.contains("turnisnotsteerable")
    }

    private func isDefinitiveAsyncAnswerRejection(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError = serviceError else { return false }
        // An RPC error is a server response to the request, unlike a timeout or
        // dropped socket. The answer was rejected, so the draft is safe to retry.
        return true
    }

    func flushQueuedAsyncUserInput(threadId: String) async {
        if messagesByThread[threadId]?.contains(where: { $0.asyncUserInput?.status == .uncertain }) == true {
            scheduleAsyncAnswerVerification(threadId: threadId, delay: 3)
        }
        guard isConnected, isInitialized, !threadHasActiveOrRunningTurn(threadId) else { return }
        let ids = messagesByThread[threadId]?.compactMap { message in
            message.asyncUserInput?.status == .queued ? message.id : nil
        } ?? []
        for id in ids {
            guard !threadHasActiveOrRunningTurn(threadId) else { return }
            setAsyncUserInputStatus(.submitting, threadId: threadId, messageID: id)
            await deliverAsyncUserInput(threadId: threadId, messageID: id)
        }
    }

    private func resetAsyncUserInputForRetry(threadId: String, messageID: String) {
        guard let index = messagesByThread[threadId]?.firstIndex(where: { $0.id == messageID }),
              var input = messagesByThread[threadId]?[index].asyncUserInput else { return }
        let responseID = input.responseMessageID
        input.prepareForRetry()
        messagesByThread[threadId]?[index].asyncUserInput = input
        messagesByThread[threadId]?.removeAll { $0.id == responseID && $0.kind == .asyncUserInputAnswer }
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    func reopenUncertainAsyncUserInputForRetry(threadId: String, messageID: String) {
        guard messagesByThread[threadId]?.first(where: { $0.id == messageID })?.asyncUserInput?.status == .uncertain else {
            return
        }
        resetAsyncUserInputForRetry(threadId: threadId, messageID: messageID)
    }

    private func setAsyncUserInputStatus(
        _ status: CodexAsyncUserInputStatus,
        threadId: String,
        messageID: String
    ) {
        guard let index = messagesByThread[threadId]?.firstIndex(where: { $0.id == messageID }) else { return }
        messagesByThread[threadId]?[index].asyncUserInput?.status = status
        persistMessages()
        updateCurrentOutput(for: threadId)
    }
}
