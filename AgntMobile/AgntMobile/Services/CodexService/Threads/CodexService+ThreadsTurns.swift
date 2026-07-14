// FILE: CodexService+ThreadsTurns.swift
// Purpose: Thread/turn operations exposed to the UI.
// Layer: Service
// Exports: CodexService thread+turn APIs
// Depends on: CodexThread, JSONValue

import Foundation

struct CodexPreAppendedTurnMessage: Sendable {
    let messageID: String
    let automaticTitleSeed: String?
}

extension CodexService {
    // Keeps sidebar/project loading focused on recent live conversations while
    // retaining a smaller archived slice for restart/recovery flows.
    var recentActiveThreadListLimit: Int { 70 }
    var recentArchivedThreadListLimit: Int { 10 }

    func listThreads(limit: Int? = nil) async throws {
        isLoadingThreads = true
        defer {
            isLoadingThreads = false
            flushPendingRuntimeOptionRefreshIfPossible()
        }

        let activeLimit = limit ?? recentActiveThreadListLimit
        let archivedLimit = limit ?? recentArchivedThreadListLimit
        let activeThreads = try await fetchCoalescedServerThreads(limit: activeLimit)

        var archivedThreads: [CodexThread] = []
        do {
            archivedThreads = try await fetchCoalescedServerThreads(limit: archivedLimit, archived: true)
        } catch {
            debugSyncLog("thread/list archived fetch failed (non-fatal): \(error.localizedDescription)")
        }

        reconcileLocalThreadsWithServer(activeThreads, serverArchivedThreads: archivedThreads)

        if activeThreadId == nil {
            activeThreadId = firstLiveThreadID()
        }
    }

    // Preserves the older startThread symbol used by most call sites and incremental builds.
    func startThread(
        preferredProjectPath: String? = nil,
        runtimeOverride: CodexThreadRuntimeOverride? = nil
    ) async throws -> CodexThread {
        try await startThreadImpl(
            preferredProjectPath: preferredProjectPath,
            pendingComposerAction: nil,
            runtimeOverride: runtimeOverride
        )
    }

    // Starts a new thread and seeds a one-shot composer action for the destination thread.
    func startThread(
        preferredProjectPath: String? = nil,
        pendingComposerAction: CodexPendingThreadComposerAction,
        runtimeOverride: CodexThreadRuntimeOverride? = nil
    ) async throws -> CodexThread {
        try await startThreadImpl(
            preferredProjectPath: preferredProjectPath,
            pendingComposerAction: pendingComposerAction,
            runtimeOverride: runtimeOverride
        )
    }

    // Starts a new thread and stores it in local state.
    private func startThreadImpl(
        preferredProjectPath: String? = nil,
        pendingComposerAction: CodexPendingThreadComposerAction? = nil,
        runtimeOverride: CodexThreadRuntimeOverride? = nil
    ) async throws -> CodexThread {
        let normalizedPreferredProjectPath = CodexThreadStartProjectBinding.normalizedProjectPath(preferredProjectPath)
        // Brand-new chats start from app defaults; per-chat overrides are inherited only on continuation.
        let explicitServiceTier = runtimeOverride?.overridesServiceTier == true
            ? normalizedServiceTierForSelectedModel(runtimeOverride?.serviceTier)?.rawValue
            : runtimeServiceTierForTurn()
        var includesServiceTier = explicitServiceTier != nil

        while true {
            let params = CodexThreadStartProjectBinding.makeThreadStartParams(
                modelIdentifier: runtimeModelIdentifierForTurn(),
                preferredProjectPath: normalizedPreferredProjectPath,
                serviceTier: includesServiceTier ? explicitServiceTier : nil
            )

            do {
                let response = try await sendRequestWithSandboxFallback(method: "thread/start", baseParams: params)

                guard let result = response.result,
                      let resultObject = result.objectValue,
                      let threadValue = resultObject["thread"],
                      let decodedThread = decodeModel(CodexThread.self, from: threadValue) else {
                    throw CodexServiceError.invalidResponse("thread/start response missing thread")
                }

                let thread = CodexThreadStartProjectBinding.applyPreferredProjectFallback(
                    to: decodedThread,
                    preferredProjectPath: normalizedPreferredProjectPath
                )
                if let pendingComposerAction {
                    queuePendingComposerAction(pendingComposerAction, for: thread.id)
                }
                if let runtimeOverride, !runtimeOverride.isEmpty {
                    applyThreadRuntimeOverride(runtimeOverride, to: thread.id)
                }
                // Mark the fresh thread as resumed before publishing it so the first
                // render can skip the transient loading state while the empty composer
                // is already the right answer.
                resumedThreadIDs.insert(thread.id)
                initialTurnsLoadedByThreadID.insert(thread.id)
                upsertThread(thread, treatAsServerState: true)
                if let normalizedProjectPath = thread.normalizedProjectPath,
                   CodexThread.projectIconSystemName(for: normalizedProjectPath) == "arrow.triangle.branch" {
                    rememberAssociatedManagedWorktreePath(normalizedProjectPath, for: thread.id)
                }
                activeThreadId = thread.id
                return thread
            } catch {
                guard consumeUnsupportedServiceTier(error, includesServiceTier: &includesServiceTier) else {
                    throw error
                }
            }
        }
    }

    // Sends user input as a new turn against an existing (or newly created) thread.
    func startTurn(
        userInput: String,
        threadId: String?,
        attachments: [CodexImageAttachment] = [],
        skillMentions: [CodexTurnSkillMention] = [],
        mentionMentions: [CodexTurnMention] = [],
        fileMentions: [String] = [],
        shouldAppendUserMessage: Bool = true,
        preAppendedUserMessageID: String? = nil,
        automaticTitleSeedOverride: String? = nil,
        collaborationMode: CodexCollaborationModeKind? = nil,
        preservePlanSessionState: Bool = false
    ) async throws {
        let trimmedInput = userInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInput.isEmpty
                || !attachments.isEmpty
                || hasRenderableStructuredMentions(skillMentions: skillMentions, mentionMentions: mentionMentions) else {
            throw CodexServiceError.invalidInput("User input, images, and mentions cannot all be empty")
        }

        let initialThreadId = try await resolveThreadID(threadId)
        let effectiveCollaborationMode = collaborationModeForOutgoingTurn(
            threadId: initialThreadId,
            requestedMode: collaborationMode,
            preserveExisting: preservePlanSessionState
        )
        preparePlanSessionForStart(
            threadId: initialThreadId,
            collaborationMode: effectiveCollaborationMode,
            preserveExisting: preservePlanSessionState
        )
        let outgoingDisplayText = displayTextForOutgoingTurn(
            userInput: trimmedInput,
            skillMentions: skillMentions,
            mentionMentions: mentionMentions
        )
        let normalizedPreAppendedUserMessageID = normalizedInterruptIdentifier(preAppendedUserMessageID)
        let shouldAppendOnContinuation = shouldAppendUserMessage || normalizedPreAppendedUserMessageID != nil
        let preResumeTitleSeed: String?
        if let automaticTitleSeedOverride {
            preResumeTitleSeed = automaticTitleSeedOverride
        } else if shouldAppendUserMessage && normalizedPreAppendedUserMessageID == nil {
            preResumeTitleSeed = automaticThreadTitleSeedIfNeeded(
                userInput: outgoingDisplayText,
                attachments: attachments,
                threadId: initialThreadId
            )
        } else {
            preResumeTitleSeed = nil
        }
        // Put the user's bubble in the timeline before any resume/network work so
        // sends feel instant while the runtime catches up in the background.
        let preResumePendingMessageId: String
        if let normalizedPreAppendedUserMessageID {
            preResumePendingMessageId = normalizedPreAppendedUserMessageID
        } else if shouldAppendUserMessage {
            preResumePendingMessageId = appendUserMessage(
                threadId: initialThreadId,
                text: outgoingDisplayText,
                attachments: attachments,
                fileMentions: fileMentions,
                skillMentions: skillMentions.compactMap {
                    let rawName = $0.name ?? $0.id
                    let normalized = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
                    return normalized.isEmpty ? nil : normalized
                },
                pluginMentions: mentionMentions.compactMap {
                    let normalized = $0.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    return normalized.isEmpty ? nil : normalized
                }
            )
        } else {
            preResumePendingMessageId = ""
        }

        do {
            try await ensureThreadResumed(threadId: initialThreadId)
        } catch {
            if shouldTreatAsThreadNotFound(error) {
                if shouldAppendUserMessage || !preResumePendingMessageId.isEmpty {
                    removePreResumePendingUserMessage(
                        threadId: initialThreadId,
                        messageId: preResumePendingMessageId,
                        matchingText: trimmedInput,
                        matchingAttachments: attachments
                    )
                }
                handleMissingThread(initialThreadId)

                let continuationThread = try await createContinuationThread(from: initialThreadId)
                migratePlanSessionState(from: initialThreadId, to: continuationThread.id)
                try await ensureThreadResumed(threadId: continuationThread.id)
                try await sendTurnStart(
                    trimmedInput,
                    attachments: attachments,
                    skillMentions: skillMentions,
                    mentionMentions: mentionMentions,
                    fileMentions: fileMentions,
                    to: continuationThread.id,
                    shouldAppendUserMessage: shouldAppendOnContinuation,
                    collaborationMode: effectiveCollaborationMode
                )
                activeThreadId = continuationThread.id
                lastErrorMessage = nil
                return
            }
        }

        do {
            try await sendTurnStart(
                trimmedInput,
                attachments: attachments,
                skillMentions: skillMentions,
                mentionMentions: mentionMentions,
                fileMentions: fileMentions,
                to: initialThreadId,
                shouldAppendUserMessage: false,
                collaborationMode: effectiveCollaborationMode,
                preAppendedUserMessageID: preResumePendingMessageId,
                automaticTitleSeedOverride: preResumeTitleSeed
            )
        } catch {
            if shouldTreatAsThreadNotFound(error) {
                // If turn/start explicitly says "thread not found", treat it as authoritative.
                // Some server states can make thread/read flaky, so we avoid blocking on a second check.
                if shouldAppendUserMessage || !preResumePendingMessageId.isEmpty {
                    removePreResumePendingUserMessage(
                        threadId: initialThreadId,
                        messageId: preResumePendingMessageId,
                        matchingText: trimmedInput,
                        matchingAttachments: attachments
                    )
                }
                handleMissingThread(initialThreadId)

                let continuationThread = try await createContinuationThread(from: initialThreadId)
                migratePlanSessionState(from: initialThreadId, to: continuationThread.id)
                try await sendTurnStart(
                    trimmedInput,
                    attachments: attachments,
                    skillMentions: skillMentions,
                    mentionMentions: mentionMentions,
                    fileMentions: fileMentions,
                    to: continuationThread.id,
                    shouldAppendUserMessage: shouldAppendOnContinuation,
                    collaborationMode: effectiveCollaborationMode
                )
                activeThreadId = continuationThread.id
                lastErrorMessage = nil
                return
            }
            throw error
        }

        activeThreadId = initialThreadId
    }

    // Lets the New Chat handoff publish the first user row before the real
    // TurnView appears, while `startTurn` still owns the single `turn/start`.
    func preAppendOutgoingUserMessage(
        userInput: String,
        threadId: String,
        attachments: [CodexImageAttachment] = [],
        skillMentions: [CodexTurnSkillMention] = [],
        mentionMentions: [CodexTurnMention] = [],
        fileMentions: [String] = []
    ) -> CodexPreAppendedTurnMessage? {
        let normalizedThreadID = normalizedInterruptIdentifier(threadId) ?? threadId
        let outgoingDisplayText = displayTextForOutgoingTurn(
            userInput: userInput.trimmingCharacters(in: .whitespacesAndNewlines),
            skillMentions: skillMentions,
            mentionMentions: mentionMentions
        )
        let automaticTitleSeed = automaticThreadTitleSeedIfNeeded(
            userInput: outgoingDisplayText,
            attachments: attachments,
            threadId: normalizedThreadID
        )
        let messageID = appendUserMessage(
            threadId: normalizedThreadID,
            text: outgoingDisplayText,
            attachments: attachments,
            fileMentions: fileMentions,
            skillMentions: skillMentions.compactMap {
                let rawName = $0.name ?? $0.id
                let normalized = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
                return normalized.isEmpty ? nil : normalized
            },
            pluginMentions: mentionMentions.compactMap {
                let normalized = $0.name.trimmingCharacters(in: .whitespacesAndNewlines)
                return normalized.isEmpty ? nil : normalized
            }
        )

        guard !messageID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return CodexPreAppendedTurnMessage(
            messageID: messageID,
            automaticTitleSeed: automaticTitleSeed
        )
    }

    // Carries a draft-thread pending row into the real thread created by thread/start.
    func movePreAppendedOutgoingUserMessage(
        _ preAppendedMessage: CodexPreAppendedTurnMessage?,
        from sourceThreadID: String,
        to targetThreadID: String
    ) -> CodexPreAppendedTurnMessage? {
        guard let preAppendedMessage,
              let messageID = normalizedInterruptIdentifier(preAppendedMessage.messageID),
              let normalizedSourceThreadID = normalizedInterruptIdentifier(sourceThreadID),
              let normalizedTargetThreadID = normalizedInterruptIdentifier(targetThreadID) else {
            return nil
        }
        guard normalizedSourceThreadID != normalizedTargetThreadID else {
            return preAppendedMessage
        }
        guard var sourceMessages = messagesByThread[normalizedSourceThreadID],
              let sourceIndex = sourceMessages.firstIndex(where: { $0.id == messageID }),
              sourceMessages[sourceIndex].role == .user else {
            return nil
        }

        let sourceMessage = sourceMessages.remove(at: sourceIndex)
        let movedMessage = CodexMessage(
            id: sourceMessage.id,
            threadId: normalizedTargetThreadID,
            role: sourceMessage.role,
            kind: sourceMessage.kind,
            assistantPhase: sourceMessage.assistantPhase,
            text: sourceMessage.text,
            fileMentions: sourceMessage.fileMentions,
            skillMentions: sourceMessage.skillMentions,
            pluginMentions: sourceMessage.pluginMentions,
            createdAt: sourceMessage.createdAt,
            turnId: sourceMessage.turnId,
            itemId: sourceMessage.itemId,
            isStreaming: sourceMessage.isStreaming,
            deliveryState: sourceMessage.deliveryState,
            attachments: sourceMessage.attachments,
            planState: sourceMessage.planState,
            planPresentation: sourceMessage.planPresentation,
            proposedPlan: sourceMessage.proposedPlan,
            subagentAction: sourceMessage.subagentAction,
            structuredUserInputRequest: sourceMessage.structuredUserInputRequest,
            orderIndex: sourceMessage.orderIndex
        )

        if sourceMessages.isEmpty {
            messagesByThread.removeValue(forKey: normalizedSourceThreadID)
        } else {
            messagesByThread[normalizedSourceThreadID] = sourceMessages
        }

        var targetMessages = messagesByThread[normalizedTargetThreadID] ?? []
        targetMessages.removeAll { $0.id == movedMessage.id }
        targetMessages.append(movedMessage)
        targetMessages.sort(by: { $0.orderIndex < $1.orderIndex })
        messagesByThread[normalizedTargetThreadID] = targetMessages
        messageIndexCacheByThread[normalizedSourceThreadID] = nil
        messageIndexCacheByThread[normalizedTargetThreadID] = nil
        persistMessages()
        updateCurrentOutput(for: normalizedSourceThreadID)
        updateCurrentOutput(for: normalizedTargetThreadID)
        return preAppendedMessage
    }

    // Removes the optimistic row by id first because structured mention-only rows may not match raw composer text.
    private func removePreResumePendingUserMessage(
        threadId: String,
        messageId: String,
        matchingText: String,
        matchingAttachments: [CodexImageAttachment]
    ) {
        if removeUserMessage(threadId: threadId, messageId: messageId) {
            return
        }

        markMessageDeliveryState(threadId: threadId, messageId: messageId, state: .failed)
        removeLatestFailedUserMessage(
            threadId: threadId,
            matchingText: matchingText,
            matchingAttachments: matchingAttachments
        )
    }

}
