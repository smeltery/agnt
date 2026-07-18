// FILE: TurnViewModel+Sending.swift
// Purpose: Send, new-thread send, queue, and steer workflows.
// Layer: View Model

import Foundation

extension TurnViewModel {
    func sendTurn(
        codex: CodexService,
        threadID: String
    ) {
        guard let pendingSend = buildValidatedPendingSend(codex: codex) else {
            return
        }

        let initialQueuedDraft = pendingSend.rawReviewSelection == nil
            ? makeQueuedDraft(from: pendingSend)
            : nil
        let threadBusy = isThreadBusy(codex: codex, threadID: threadID)
        let queuePaused = isQueuePaused(codex: codex, threadID: threadID)
        // Busy-state refresh may wait on the runtime. Publish the queued bubble
        // before any await so follow-ups appear above the first assistant block.
        let queuedDraft = threadBusy
            ? initialQueuedDraft.map { preAppendQueuedDraftMessageIfNeeded($0, codex: codex, threadID: threadID) }
            : initialQueuedDraft

        isSending = true
        isPlanModeArmed = false
        shouldAnchorToAssistantResponse = true
        clearComposer()

        Task { @MainActor in
            defer { isSending = false }

            let stillBusy = await refreshBusyStateIfNeeded(codex: codex, threadID: threadID, wasBusy: threadBusy)
            if stillBusy {
                await performBusyThreadSend(
                    pendingSend,
                    queuedDraft: queuedDraft,
                    codex: codex,
                    threadID: threadID
                )
                return
            }

            let preAppendedMessage = queuedDraft?.preAppendedMessageID.map {
                CodexPreAppendedTurnMessage(messageID: $0, automaticTitleSeed: nil)
            }
            if queuePaused, let queuedDraft {
                appendQueuedDraft(queuedDraft, codex: codex, threadID: threadID)
                clearLocalDraft(codex: codex, threadID: threadID, persistToDisk: true)

                resumeQueueAndFlushIfPossible(codex: codex, threadID: threadID)
                return
            }

            await performTurnSend(
                pendingSend,
                codex: codex,
                threadID: threadID,
                preAppendedMessage: preAppendedMessage
            )
        }
    }

    // Starts a real thread only when the first draft message is sent from the New Chat screen.
    @discardableResult
    func sendNewThread(
        codex: CodexService,
        draftThreadID: String,
        preferredProjectPath: String?,
        onThreadCreated: @escaping @MainActor @Sendable (CodexThread) -> Void,
        onSendFailed: (@MainActor @Sendable () -> Void)? = nil
    ) -> Bool {
        guard let pendingSend = buildValidatedPendingSend(codex: codex) else {
            return false
        }

        isSending = true
        isPlanModeArmed = false
        shouldAnchorToAssistantResponse = true
        let draftPreAppendedMessage = preAppendNewThreadUserMessageIfNeeded(
            pendingSend,
            codex: codex,
            threadID: draftThreadID
        )
        clearComposer()

        Task { @MainActor in
            defer { isSending = false }

            do {
                let thread = try await codex.startThreadIfReady(preferredProjectPath: preferredProjectPath)
                let preAppendedMessage = movePreAppendedNewThreadUserMessageIfNeeded(
                    draftPreAppendedMessage,
                    pendingSend: pendingSend,
                    codex: codex,
                    draftThreadID: draftThreadID,
                    threadID: thread.id
                )
                onThreadCreated(thread)

                do {
                    try await dispatchPendingSend(
                        pendingSend,
                        codex: codex,
                        threadID: thread.id,
                        preAppendedMessage: preAppendedMessage
                    )
                    clearLocalDraft(codex: codex, threadID: draftThreadID, persistToDisk: true)
                    clearLocalDraft(codex: codex, threadID: thread.id, persistToDisk: true)
                } catch {
                    // The real thread is already visible; startTurn owns the failed row/footer state.
                    codex.lastErrorMessage = codex.userFacingTurnErrorMessageForFooter(from: error)
                }
            } catch {
                discardPreAppendedNewThreadUserMessage(
                    draftPreAppendedMessage,
                    codex: codex,
                    draftThreadID: draftThreadID
                )
                restorePendingSendOnFailure(
                    pendingSend,
                    error: error,
                    codex: codex,
                    draftThreadID: draftThreadID
                )
                onSendFailed?()
            }
        }
        return true
    }

    // Shared validation + payload assembly used by `sendTurn` and `sendNewThread`
    // so the empty/connected/blocking/review guards stay in one place.
    func buildValidatedPendingSend(codex: CodexService) -> PendingTurnSend? {
        let payload = buildPayloadWithMentions()
        let attachments = readyComposerAttachments
        let skillMentions = composerMentionedSkills.map {
            CodexTurnSkillMention(id: $0.name, name: $0.name, path: $0.path)
        }
        let mentionMentions = composerMentionedPlugins.map {
            CodexTurnMention(name: $0.name, path: $0.path)
        }
        let reviewSelection = composerReviewSelection

        guard (!payload.isEmpty || !attachments.isEmpty || reviewSelection != nil || !skillMentions.isEmpty || !mentionMentions.isEmpty),
              !isSending,
              codex.isConnected,
              !hasBlockingAttachmentState else {
            return nil
        }

        if reviewSelection != nil, hasComposerContentConflictingWithReview {
            codex.lastErrorMessage = "Clear text, files, skills, and images before starting a code review."
            return nil
        }

        return PendingTurnSend(
            payload: payload,
            attachments: attachments,
            skillMentions: skillMentions,
            mentionMentions: mentionMentions,
            collaborationMode: isPlanModeArmed ? .plan : nil,
            rawInput: input,
            rawFileMentions: composerMentionedFiles,
            rawSkillMentions: composerMentionedSkills,
            rawPluginMentions: composerMentionedPlugins,
            rawAttachments: composerAttachments,
            rawReviewSelection: reviewSelection,
            rawSubagentsSelectionArmed: isSubagentsSelectionArmed
        )
    }

    // Mirrors a validated PendingTurnSend into the queued-draft shape used when
    // sendTurn needs to defer the payload behind a busy thread or paused queue.
    func makeQueuedDraft(from pendingSend: PendingTurnSend) -> QueuedTurnDraft {
        QueuedTurnDraft(
            id: UUID().uuidString,
            text: pendingSend.payload,
            attachments: pendingSend.attachments,
            skillMentions: pendingSend.skillMentions,
            mentionMentions: pendingSend.mentionMentions,
            collaborationMode: pendingSend.collaborationMode,
            rawInput: pendingSend.rawInput,
            rawFileMentions: pendingSend.rawFileMentions,
            rawSkillMentions: pendingSend.rawSkillMentions,
            rawPluginMentions: pendingSend.rawPluginMentions,
            rawAttachments: pendingSend.rawAttachments,
            rawSubagentsSelectionArmed: pendingSend.rawSubagentsSelectionArmed,
            createdAt: Date()
        )
    }

    // Moves the immediate draft bubble onto the real thread; falls back to appending
    // there if the draft row was pruned before thread/start returned.
    func movePreAppendedNewThreadUserMessageIfNeeded(
        _ draftPreAppendedMessage: CodexPreAppendedTurnMessage?,
        pendingSend: PendingTurnSend,
        codex: CodexService,
        draftThreadID: String,
        threadID: String
    ) -> CodexPreAppendedTurnMessage? {
        if let movedMessage = codex.movePreAppendedOutgoingUserMessage(
            draftPreAppendedMessage,
            from: draftThreadID,
            to: threadID
        ) {
            return movedMessage
        }

        return preAppendNewThreadUserMessageIfNeeded(
            pendingSend,
            codex: codex,
            threadID: threadID
        )
    }

    // Cleans up the draft-only optimistic row if thread/start itself fails.
    func discardPreAppendedNewThreadUserMessage(
        _ draftPreAppendedMessage: CodexPreAppendedTurnMessage?,
        codex: CodexService,
        draftThreadID: String
    ) {
        guard let draftPreAppendedMessage else { return }
        codex.removeUserMessage(
            threadId: draftThreadID,
            messageId: draftPreAppendedMessage.messageID
        )
    }

    // Pre-publishes the first New Chat user row before ContentView swaps in TurnView.
    // Reviews use their own runtime event stream, so only normal turns get a row here.
    func preAppendNewThreadUserMessageIfNeeded(
        _ pendingSend: PendingTurnSend,
        codex: CodexService,
        threadID: String
    ) -> CodexPreAppendedTurnMessage? {
        guard pendingSend.rawReviewSelection == nil else {
            return nil
        }

        return codex.preAppendOutgoingUserMessage(
            userInput: pendingSend.payload,
            threadId: threadID,
            attachments: pendingSend.attachments,
            skillMentions: pendingSend.skillMentions,
            mentionMentions: pendingSend.mentionMentions,
            fileMentions: confirmedFileMentionPaths(from: pendingSend.rawFileMentions)
        )
    }

    // Routes a PendingTurnSend through the right runtime call (review vs turn)
    // so sendNewThread doesn't have to duplicate the review branch from
    // performTurnSend. Errors bubble to the caller for context-specific recovery.
    func dispatchPendingSend(
        _ pendingSend: PendingTurnSend,
        codex: CodexService,
        threadID: String,
        preAppendedMessage: CodexPreAppendedTurnMessage? = nil
    ) async throws {
        if let reviewSelection = pendingSend.rawReviewSelection {
            try await codex.startReview(
                threadId: threadID,
                target: reviewSelection.target?.codexReviewTarget,
                baseBranch: reviewBaseBranchName(for: reviewSelection)
            )
        } else {
            try await codex.startTurn(
                userInput: pendingSend.payload,
                threadId: threadID,
                attachments: pendingSend.attachments,
                skillMentions: pendingSend.skillMentions,
                mentionMentions: pendingSend.mentionMentions,
                fileMentions: confirmedFileMentionPaths(from: pendingSend.rawFileMentions),
                shouldAppendUserMessage: preAppendedMessage == nil,
                preAppendedUserMessageID: preAppendedMessage?.messageID,
                automaticTitleSeedOverride: preAppendedMessage?.automaticTitleSeed,
                collaborationMode: pendingSend.collaborationMode
            )
        }
    }

    // Shared failure recovery for both performTurnSend and sendNewThread: restores
    // the exact composer payload so the user can retry without re-typing, persists
    // it under the right thread id, and rebuilds the footer error message.
    func restorePendingSendOnFailure(
        _ pendingSend: PendingTurnSend,
        error: Error,
        codex: CodexService,
        draftThreadID: String
    ) {
        shouldAnchorToAssistantResponse = false
        restoreComposerState(from: pendingSend)
        saveLocalDraft(codex: codex, threadID: draftThreadID, persistToDisk: true)
        if pendingSend.collaborationMode == .plan,
           shouldRearmPlanModeAfterSendFailure(error) {
            isPlanModeArmed = true
        }
        let fallbackMessage = codex.userFacingTurnErrorMessage(from: error)
        if (codex.lastErrorMessage?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
            && !fallbackMessage.isEmpty {
            codex.lastErrorMessage = fallbackMessage
        }
    }

    func flushQueueIfPossible(codex: CodexService, threadID: String) {
        guard !queuedDrafts(codex: codex, threadID: threadID).isEmpty,
              !isSending,
              steeringDraftID == nil,
              codex.isConnected,
              !isQueuePaused(codex: codex, threadID: threadID),
              !isThreadBusy(codex: codex, threadID: threadID) else {
            return
        }

        guard let nextDraft = dequeueQueuedDraft(codex: codex, threadID: threadID) else {
            return
        }
        isSending = true
        shouldAnchorToAssistantResponse = true

        Task { @MainActor in
            defer { isSending = false }

            do {
                try await codex.startTurn(
                    userInput: nextDraft.text,
                    threadId: threadID,
                    attachments: nextDraft.attachments,
                    skillMentions: nextDraft.skillMentions,
                    mentionMentions: nextDraft.mentionMentions,
                    fileMentions: confirmedFileMentionPaths(from: nextDraft.rawFileMentions),
                    shouldAppendUserMessage: nextDraft.preAppendedMessageID == nil,
                    preAppendedUserMessageID: nextDraft.preAppendedMessageID,
                    collaborationMode: nextDraft.collaborationMode
                )
            } catch {
                shouldAnchorToAssistantResponse = false
                prependQueuedDraft(nextDraft, codex: codex, threadID: threadID)
                let queueErrorMessage = codex.userFacingTurnErrorMessage(from: error)
                setQueuePauseState(.paused(errorMessage: queueErrorMessage), codex: codex, threadID: threadID)
                codex.lastErrorMessage = "Queue paused: \(queueErrorMessage)"
            }
        }
    }

    func shouldRearmPlanModeAfterSendFailure(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError else {
            return false
        }

        guard case .invalidResponse(let reason) = serviceError else {
            return false
        }

        return reason.localizedCaseInsensitiveContains("plan mode requires an available model")
    }

    // Sends one queued draft into the active turn without disturbing the rest of the queue.
    func steerQueuedDraft(id: String, codex: CodexService, threadID: String) {
        guard codex.isConnected,
              steeringDraftID == nil,
              isThreadBusy(codex: codex, threadID: threadID),
              let draft = queuedDrafts(codex: codex, threadID: threadID).first(where: { $0.id == id }) else {
            return
        }

        steeringDraftID = id
        shouldAnchorToAssistantResponse = true

        Task { @MainActor in
            defer { steeringDraftID = nil }

            do {
                let stillBusy = await refreshBusyStateIfNeeded(codex: codex, threadID: threadID, wasBusy: true)
                if !stillBusy {
                    try await codex.startTurn(
                        userInput: draft.text,
                        threadId: threadID,
                        attachments: draft.attachments,
                        skillMentions: draft.skillMentions,
                        mentionMentions: draft.mentionMentions,
                        fileMentions: confirmedFileMentionPaths(from: draft.rawFileMentions),
                        shouldAppendUserMessage: draft.preAppendedMessageID == nil,
                        preAppendedUserMessageID: draft.preAppendedMessageID,
                        collaborationMode: draft.collaborationMode
                    )
                    removeQueuedDraft(id: id, codex: codex, threadID: threadID, removeOptimisticMessage: false)
                    return
                }

                let expectedTurnID = try await resolveSteerExpectedTurnID(
                    codex: codex,
                    threadID: threadID
                )
                try await codex.steerTurn(
                    userInput: draft.text,
                    threadId: threadID,
                    expectedTurnId: expectedTurnID,
                    attachments: draft.attachments,
                    skillMentions: draft.skillMentions,
                    mentionMentions: draft.mentionMentions,
                    fileMentions: confirmedFileMentionPaths(from: draft.rawFileMentions),
                    shouldAppendUserMessage: draft.preAppendedMessageID == nil,
                    preAppendedUserMessageID: draft.preAppendedMessageID,
                    collaborationMode: draft.collaborationMode
                )
                removeQueuedDraft(id: id, codex: codex, threadID: threadID, removeOptimisticMessage: false)
            } catch {
                shouldAnchorToAssistantResponse = false
                clearQueuedDraftOptimisticMessage(id: id, draft: draft, codex: codex, threadID: threadID)
                codex.lastErrorMessage = codex.userFacingTurnErrorMessage(from: error)
            }
        }
    }

    func resumeQueueAndFlushIfPossible(codex: CodexService, threadID: String) {
        setQueuePauseState(.active, codex: codex, threadID: threadID)
        flushQueueIfPossible(codex: codex, threadID: threadID)
    }
    func refreshBusyStateIfNeeded(
        codex: CodexService,
        threadID: String,
        wasBusy: Bool
    ) async -> Bool {
        guard wasBusy,
              codex.activeTurnID(for: threadID) == nil,
              (codex.runningThreadIDs.contains(threadID)
                || codex.protectedRunningFallbackThreadIDs.contains(threadID)) else {
            return wasBusy
        }

        _ = await codex.refreshInFlightTurnState(threadId: threadID)
        return isThreadBusy(codex: codex, threadID: threadID)
    }

    func isThreadBusy(codex: CodexService, threadID: String) -> Bool {
        codex.threadHasActiveOrRunningTurn(threadID)
    }

    // Queues normal follow-ups while a run is active; explicit steer stays behind the queued-draft action.
    func performBusyThreadSend(
        _ pendingSend: PendingTurnSend,
        queuedDraft: QueuedTurnDraft?,
        codex: CodexService,
        threadID: String
    ) async {
        if pendingSend.rawReviewSelection != nil {
            restoreComposerState(from: pendingSend)
            shouldAnchorToAssistantResponse = false
            codex.lastErrorMessage = "Wait for the current run to finish before starting a code review."
            return
        }

        guard let queuedDraft else {
            restoreComposerState(from: pendingSend)
            shouldAnchorToAssistantResponse = false
            return
        }

        isPlanModeArmed = false
        shouldAnchorToAssistantResponse = true
        appendQueuedDraft(
            preAppendQueuedDraftMessageIfNeeded(queuedDraft, codex: codex, threadID: threadID),
            codex: codex,
            threadID: threadID
        )
        clearLocalDraft(codex: codex, threadID: threadID, persistToDisk: true)
    }

    // Sends the already-cleared composer payload and restores exact raw state if startTurn fails.
    func performTurnSend(
        _ pendingSend: PendingTurnSend,
        codex: CodexService,
        threadID: String,
        preAppendedMessage: CodexPreAppendedTurnMessage? = nil
    ) async {
        do {
            try await dispatchPendingSend(
                pendingSend,
                codex: codex,
                threadID: threadID,
                preAppendedMessage: preAppendedMessage
            )
            clearLocalDraft(codex: codex, threadID: threadID, persistToDisk: true)
        } catch {
            restorePendingSendOnFailure(
                pendingSend,
                error: error,
                codex: codex,
                draftThreadID: threadID
            )
        }
    }

}
