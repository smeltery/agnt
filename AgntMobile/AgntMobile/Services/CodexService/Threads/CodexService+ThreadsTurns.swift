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

enum CodexThreadStartProjectBinding {
    // Normalizes project paths before sending them to thread/start.
    static func normalizedProjectPath(_ rawValue: String?) -> String? {
        CodexThread.normalizedFilesystemProjectPath(rawValue)
    }

    static func makeThreadStartParams(
        modelIdentifier: String?,
        preferredProjectPath: String?,
        serviceTier: String?
    ) -> RPCObject {
        var params: RPCObject = [:]

        if let modelIdentifier {
            params["model"] = .string(modelIdentifier)
        }

        if let preferredProjectPath {
            params["cwd"] = .string(preferredProjectPath)
        }

        if let serviceTier {
            params["serviceTier"] = .string(serviceTier)
        }

        return params
    }

    // Preserves project grouping even when older servers omit cwd in thread/start result.
    static func applyPreferredProjectFallback(to thread: CodexThread, preferredProjectPath: String?) -> CodexThread {
        guard thread.normalizedProjectPath == nil,
              let preferredProjectPath else {
            return thread
        }

        var patchedThread = thread
        patchedThread.cwd = preferredProjectPath
        return patchedThread
    }
}

extension CodexService {
    // Reuses an in-flight thread/list request for matching caps so launch sync and sidebar refresh share one RPC.
    func fetchCoalescedServerThreads(limit: Int, archived: Bool = false) async throws -> [CodexThread] {
        let key = "\(archived ? "archived" : "active"):\(limit)"
        if let existingFetch = threadListFetchTaskByLimit[key] {
            return try await existingFetch.task.value
        }

        let fetchID = UUID()
        let task = Task { @MainActor in
            defer {
                if threadListFetchTaskByLimit[key]?.id == fetchID {
                    threadListFetchTaskByLimit[key] = nil
                }
            }
            return try await fetchServerThreads(limit: limit, archived: archived)
        }
        threadListFetchTaskByLimit[key] = (id: fetchID, task: task)

        return try await task.value
    }

    func fetchServerThreads(
        limit: Int? = nil,
        archived: Bool = false,
        onPage: ((_ page: [CodexThread], _ accumulatedThreads: [CodexThread]) -> Void)? = nil
    ) async throws -> [CodexThread] {
        var allThreads: [CodexThread] = []
        var nextCursor: JSONValue = .null
        var hasRequestedFirstPage = false

        repeat {
            var params: RPCObject = [
                // Avoid the server's narrower default sourceKinds so multi-project history
                // includes threads started from the app-server flow as well.
                "sourceKinds": .array(threadListSourceKinds.map(JSONValue.string)),
                "cursor": nextCursor,
            ]
            if let limit {
                params["limit"] = .integer(limit)
            }
            if archived {
                params["archived"] = .bool(true)
            }

            let response = try await sendRequest(method: "thread/list", params: .object(params))

            guard let resultObject = response.result?.objectValue else {
                throw CodexServiceError.invalidResponse("thread/list response missing payload")
            }

            let page =
                resultObject["data"]?.arrayValue
                ?? resultObject["items"]?.arrayValue
                ?? resultObject["threads"]?.arrayValue
            guard let page else {
                throw CodexServiceError.invalidResponse("thread/list response missing data array")
            }

            let decodedPage = page.compactMap { decodeModel(CodexThread.self, from: $0) }
            allThreads.append(contentsOf: decodedPage)
            onPage?(decodedPage, allThreads)
            nextCursor = nextThreadListCursor(from: resultObject)
            hasRequestedFirstPage = true
        } while shouldContinueThreadListPagination(
            nextCursor: nextCursor,
            limit: limit,
            hasRequestedFirstPage: hasRequestedFirstPage
        )

        return allThreads
    }

    // Requests all user-facing thread sources instead of relying on the server default.
    private var threadListSourceKinds: [String] {
        [
            "cli",
            "vscode",
            "appServer",
            "exec",
            "unknown",
        ]
    }

    // Accepts both modern and legacy cursor field names from thread/list responses.
    private func nextThreadListCursor(from resultObject: RPCObject) -> JSONValue {
        if let nextCursor = resultObject["nextCursor"] {
            return nextCursor
        }
        if let nextCursor = resultObject["next_cursor"] {
            return nextCursor
        }
        return .null
    }

    // Paginates until the server reports no cursor or the caller requested a capped page.
    private func shouldContinueThreadListPagination(
        nextCursor: JSONValue,
        limit: Int?,
        hasRequestedFirstPage: Bool
    ) -> Bool {
        guard hasRequestedFirstPage, limit == nil else {
            return false
        }

        switch nextCursor {
        case .null:
            return false
        case let .string(value):
            return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default:
            return true
        }
    }

    func createContinuationThread(from archivedThreadId: String) async throws -> CodexThread {
        let continuationRuntimeOverride = threadRuntimeOverride(for: archivedThreadId)
        let continuationThread = try await startThread(runtimeOverride: continuationRuntimeOverride)
        appendSystemMessage(
            threadId: continuationThread.id,
            text: "Continued from archived thread `\(archivedThreadId)`"
        )
        return continuationThread
    }

    @discardableResult
    func ensureThreadResumed(
        threadId: String,
        force: Bool = false,
        preferredProjectPath: String? = nil,
        modelIdentifierOverride: String? = nil
    ) async throws -> CodexThread? {
        guard !threadId.isEmpty else {
            return nil
        }

        if force {
            forcedResumeEscalationThreadIDs.insert(threadId)
        }
        if !force, resumedThreadIDs.contains(threadId) {
            return thread(for: threadId)
        }
        let requestedSignature = CodexThreadResumeRequestSignature(
            projectPath: CodexThreadStartProjectBinding.normalizedProjectPath(preferredProjectPath)
                ?? thread(for: threadId)?.gitWorkingDirectory,
            modelIdentifier: modelIdentifierOverride ?? runtimeModelIdentifierForTurn()
        )
        let refreshGeneration = currentPerThreadRefreshGeneration(for: threadId)
        if let existingTask = threadResumeTaskByThreadID[threadId] {
            if threadResumeRequestSignatureByThreadID[threadId] == requestedSignature {
                return try await existingTask.value
            }

            _ = try await existingTask.value
            return try await ensureThreadResumed(
                threadId: threadId,
                force: force,
                preferredProjectPath: preferredProjectPath,
                modelIdentifierOverride: modelIdentifierOverride
            )
        }

        let task = Task<CodexThread?, Error> { @MainActor in
            defer {
                // Ignore stale refreshes so an older task cannot clear newer state.
                if isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) {
                    threadResumeTaskByThreadID.removeValue(forKey: threadId)
                    threadResumeRequestSignatureByThreadID.removeValue(forKey: threadId)
                    forcedResumeEscalationThreadIDs.remove(threadId)
                }
            }

            var params: RPCObject = [
                "threadId": .string(threadId),
            ]
            let resolvedProjectPath = requestedSignature.projectPath
            if let workingDirectory = resolvedProjectPath {
                params["cwd"] = .string(workingDirectory)
            }
            if let modelIdentifier = requestedSignature.modelIdentifier {
                params["model"] = .string(modelIdentifier)
            }
            if supportsTurnPagination {
                params["excludeTurns"] = .bool(true)
            }
            var didRequestExcludedTurns = params["excludeTurns"] != nil
            let response: RPCMessage
            do {
                response = try await sendRequestWithSandboxFallback(method: "thread/resume", baseParams: params)
            } catch {
                guard didRequestExcludedTurns, consumeUnsupportedTurnPagination(error) else {
                    throw error
                }

                params.removeValue(forKey: "excludeTurns")
                didRequestExcludedTurns = false
                response = try await sendRequestWithSandboxFallback(method: "thread/resume", baseParams: params)
            }
            guard !Task.isCancelled,
                  isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                throw CancellationError()
            }

            guard let resultObject = response.result?.objectValue else {
                resumedThreadIDs.insert(threadId)
                return nil
            }

            var resumedThread: CodexThread?
            var didReceiveEmbeddedHistory = false
            if let threadValue = resultObject["thread"],
               var decodedThread = decodeModel(CodexThread.self, from: threadValue) {
                decodedThread.syncState = .live
                upsertThread(decodedThread, treatAsServerState: true)
                resumedThread = decodedThread

                if let threadObject = threadValue.objectValue {
                    if didRequestExcludedTurns,
                       threadObject["turns"]?.arrayValue?.isEmpty == false {
                        markTurnPaginationUnsupportedForCurrentRuntime()
                        didRequestExcludedTurns = false
                    }
                    let historyMessages = decodeMessagesFromThreadRead(threadId: threadId, threadObject: threadObject)
                    registerSubagentThreads(from: historyMessages, parentThreadId: threadId)
                    if !historyMessages.isEmpty {
                        didReceiveEmbeddedHistory = true
                        initialTurnsLoadedByThreadID.insert(threadId)
                        updateThreadTimelineProjectionForEmbeddedHistory(
                            threadId: threadId,
                            decodedMessageCount: historyMessages.count
                        )
                        let existingMessages = messagesByThread[threadId] ?? []
                        let activeThreadIDs = Set(activeTurnIdByThread.keys)
                        let runningIDs = runningThreadIDs
                        let usedRecentWindow = threadHasActiveOrRunningTurn(threadId)
                            && Self.shouldPreferRecentHistoryWindow(
                                existingCount: existingMessages.count,
                                historyCount: historyMessages.count
                            )
                        if !usedRecentWindow {
                            markThreadLocalHistoryStartAuthoritative(threadId, clearRemoteCursor: true)
                        }
                        if usedRecentWindow {
                            markThreadNeedingCanonicalHistoryReconcile(threadId)
                        }
                        let merged = try await mergeHistoryMessagesOffMainActor(
                            existing: existingMessages,
                            history: historyMessages,
                            activeThreadIDs: activeThreadIDs,
                            runningThreadIDs: runningIDs,
                            preferRecentWindow: usedRecentWindow
                        )
                        guard !Task.isCancelled,
                              isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                            throw CancellationError()
                        }
                        let shouldForceMerge = force || forcedResumeEscalationThreadIDs.contains(threadId)
                        // Forced resumes are used when reopening a running thread, so merge the
                        // latest snapshot even mid-run and let mergeHistoryMessages preserve
                        // existing streaming rows instead of waiting for the final block.
                        if (shouldForceMerge || !threadHasActiveOrRunningTurn(threadId) || existingMessages.isEmpty)
                            && merged != existingMessages {
                            messagesByThread[threadId] = merged
                            persistMessages()
                            updateCurrentOutput(for: threadId)
                        }
                        if usedRecentWindow, !threadHasActiveOrRunningTurn(threadId) {
                            scheduleCanonicalHistoryReconcileIfNeeded(for: threadId)
                        } else if !threadHasActiveOrRunningTurn(threadId) {
                            markThreadCanonicalHistoryReconciled(threadId)
                        }
                    }
                }
            } else if let index = threadIndex(for: threadId) {
                threads[index].syncState = .live
            }

            guard !Task.isCancelled,
                  isPerThreadRefreshCurrent(for: threadId, generation: refreshGeneration) else {
                throw CancellationError()
            }
            if !didRequestExcludedTurns || didReceiveEmbeddedHistory {
                hydratedThreadIDs.insert(threadId)
                if !supportsTurnPagination {
                    initialTurnsLoadedByThreadID.insert(threadId)
                }
            }
            resumedThreadIDs.insert(threadId)
            return resumedThread
        }

        threadResumeTaskByThreadID[threadId] = task
        threadResumeRequestSignatureByThreadID[threadId] = requestedSignature
        return try await task.value
    }

    func isThreadMissingOnServer(_ threadId: String) async -> Bool {
        let params: JSONValue = .object([
            "threadId": .string(threadId),
            "includeTurns": .bool(false),
        ])

        do {
            _ = try await sendRequest(method: "thread/read", params: params)
            return false
        } catch {
            return shouldTreatAsThreadNotFound(error)
        }
    }

    // Rebuilds active turn/running state from server truth after reconnect/background transitions.
    // Returns false when the snapshot could not be refreshed, so callers can fall back to history sync.
    func refreshInFlightTurnState(threadId: String) async -> Bool {
        let normalizedThreadID = normalizedInterruptIdentifier(threadId)
        guard let normalizedThreadID,
              isConnected,
              isInitialized else {
            return false
        }

        let refreshGeneration = currentPerThreadRefreshGeneration(for: normalizedThreadID)
        if let existingTask = turnStateRefreshTaskByThreadID[normalizedThreadID] {
            return await existingTask.value
        }

        let task = Task<Bool, Never> { @MainActor in
            defer {
                if isPerThreadRefreshCurrent(for: normalizedThreadID, generation: refreshGeneration) {
                    turnStateRefreshTaskByThreadID.removeValue(forKey: normalizedThreadID)
                }
            }

            do {
                let snapshot = try await readThreadTurnStateSnapshot(threadId: normalizedThreadID)
                guard !Task.isCancelled,
                      isPerThreadRefreshCurrent(for: normalizedThreadID, generation: refreshGeneration) else {
                    return false
                }

                if let runningTurnID = snapshot.interruptibleTurnID {
                    markThreadAsRunning(normalizedThreadID)
                    setProtectedRunningFallback(false, for: normalizedThreadID)
                    setActiveTurnID(runningTurnID, for: normalizedThreadID)
                    threadIdByTurnID[runningTurnID] = normalizedThreadID
                    activeTurnId = runningTurnID
                    return true
                }

                if snapshot.hasInterruptibleTurnWithoutID {
                    markThreadAsRunning(normalizedThreadID)
                    setProtectedRunningFallback(true, for: normalizedThreadID)
                } else {
                    clearRunningState(for: normalizedThreadID)
                }

                if let existingTurnID = activeTurnID(for: normalizedThreadID) {
                    setActiveTurnID(nil, for: normalizedThreadID)
                    if threadIdByTurnID[existingTurnID] == normalizedThreadID {
                        threadIdByTurnID.removeValue(forKey: existingTurnID)
                    }
                    if activeTurnId == existingTurnID {
                        activeTurnId = nil
                    }
                }
                return true
            } catch {
                debugSyncLog("in-flight turn refresh failed thread=\(normalizedThreadID): \(error.localizedDescription)")
                return false
            }
        }

        turnStateRefreshTaskByThreadID[normalizedThreadID] = task
        return await task.value
    }

    func sendTurnStart(
        _ userInput: String,
        attachments: [CodexImageAttachment] = [],
        skillMentions: [CodexTurnSkillMention] = [],
        mentionMentions: [CodexTurnMention] = [],
        fileMentions: [String] = [],
        to threadId: String,
        shouldAppendUserMessage: Bool = true,
        collaborationMode: CodexCollaborationModeKind? = nil,
        preAppendedUserMessageID: String? = nil,
        automaticTitleSeedOverride: String? = nil
    ) async throws {
        let outgoingDisplayText = displayTextForOutgoingTurn(
            userInput: userInput,
            skillMentions: skillMentions,
            mentionMentions: mentionMentions
        )
        let automaticTitleSeed = automaticTitleSeedOverride ?? (shouldAppendUserMessage
            ? automaticThreadTitleSeedIfNeeded(
                userInput: outgoingDisplayText,
                attachments: attachments,
                threadId: threadId
            )
            : nil)
        let pendingMessageId: String
        if let preAppendedUserMessageID,
           !preAppendedUserMessageID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            pendingMessageId = preAppendedUserMessageID
        } else if shouldAppendUserMessage {
            pendingMessageId = appendUserMessage(
                threadId: threadId,
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
            pendingMessageId = ""
        }
        activeThreadId = threadId
        markThreadAsRunning(threadId)
        setProtectedRunningFallback(true, for: threadId)
        let messageStartCheckpointTask = scheduleMessageStartWorkspaceCheckpointIfPossible(
            threadId: threadId,
            messageId: pendingMessageId
        )

        var includeStructuredSkillItems = supportsStructuredSkillInput && !skillMentions.isEmpty
        var includeStructuredMentionItems = supportsStructuredMentionInput && !mentionMentions.isEmpty
        var imageURLKey = "url"
        var effectiveCollaborationMode = supportsTurnCollaborationMode ? collaborationMode : nil
        var didDowngradePlanModeForRuntime = false
        var includesServiceTier = runtimeServiceTierForTurn(threadId: threadId) != nil

        if collaborationMode != nil, effectiveCollaborationMode == nil {
            debugRuntimeLog(
                "turn/start dropping collaborationMode requested=\(collaborationMode?.rawValue ?? "") thread=\(threadId) supportsTurnCollaborationMode=\(supportsTurnCollaborationMode)"
            )
        }

        while true {
            do {
                let requestParams = try buildTurnStartRequestParams(
                    threadId: threadId,
                    userInput: userInput,
                    attachments: attachments,
                    skillMentions: skillMentions,
                    mentionMentions: mentionMentions,
                    imageURLKey: imageURLKey,
                    includeStructuredSkillItems: includeStructuredSkillItems,
                    includeStructuredMentionItems: includeStructuredMentionItems,
                    collaborationMode: effectiveCollaborationMode,
                    includeServiceTier: includesServiceTier
                )
                // The pre-turn snapshot must settle before the runtime can mutate files.
                if let messageStartCheckpointTask {
                    await messageStartCheckpointTask.value
                }
                let response = try await sendRequestWithSandboxFallback(
                    method: "turn/start",
                    baseParams: requestParams
                )
                let resolvedTurnID = handleSuccessfulTurnStartResponse(
                    response,
                    pendingMessageId: pendingMessageId,
                    threadId: threadId
                )
                if let resolvedTurnID {
                    scheduleMessageStartWorkspaceCheckpointCopyIfPossible(
                        threadId: threadId,
                        messageId: pendingMessageId,
                        turnId: resolvedTurnID
                    )
                }
                scheduleAutomaticThreadTitleGenerationIfNeeded(
                    seed: automaticTitleSeed,
                    threadId: threadId,
                    attachments: attachments
                )
                if didDowngradePlanModeForRuntime {
                    appendSystemMessage(
                        threadId: threadId,
                        text: "Plan mode is not supported by this runtime. Sent as a normal turn instead."
                    )
                }
                return
            } catch {
                if includeStructuredSkillItems,
                   shouldRetryTurnStartWithoutSkillItems(error) {
                    // Disable structured skill input for this runtime after first incompatibility signal.
                    supportsStructuredSkillInput = false
                    includeStructuredSkillItems = false
                    continue
                }

                if includeStructuredMentionItems,
                   shouldRetryTurnStartWithoutMentionItems(error) {
                    supportsStructuredMentionInput = false
                    includeStructuredMentionItems = false
                    continue
                }

                if imageURLKey == "url",
                   !attachments.isEmpty,
                   shouldRetryTurnStartWithImageURLField(error) {
                    imageURLKey = "image_url"
                    continue
                }

                if effectiveCollaborationMode != nil,
                   shouldRetryTurnStartWithoutCollaborationMode(error) {
                    // Remember the runtime limitation so future plan-mode sends skip the rejected field.
                    supportsTurnCollaborationMode = false
                    clearPlanSessionIfRuntimeDowngraded(
                        threadId: threadId,
                        collaborationMode: effectiveCollaborationMode
                    )
                    effectiveCollaborationMode = nil
                    didDowngradePlanModeForRuntime = true
                    continue
                }

                if consumeUnsupportedServiceTier(error, includesServiceTier: &includesServiceTier) {
                    continue
                }

                try handleTurnStartFailure(
                    error,
                    pendingMessageId: pendingMessageId,
                    threadId: threadId
                )
                return
            }
        }
    }

    // Generates a compact first-turn title without blocking turn/start or overwriting user renames.
    private func scheduleAutomaticThreadTitleGenerationIfNeeded(
        seed: String?,
        threadId: String,
        attachments: [CodexImageAttachment]
    ) {
        guard let seed,
              !seed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }

        let fallbackTitle = fallbackThreadTitle(from: seed)
        let allowedTitles: Set<String> = [
            CodexThread.defaultDisplayTitle,
            "Conversation",
            fallbackTitle,
        ]
        applyAutomaticThreadTitle(fallbackTitle, for: threadId, replacing: allowedTitles)

        Task { @MainActor [weak self] in
            guard let self else { return }
            guard let generatedTitle = await self.generatedThreadTitleOrNil(
                seed: seed,
                threadId: threadId,
                attachmentCount: attachments.count
            ) else {
                return
            }

            self.applyAutomaticThreadTitle(
                generatedTitle,
                for: threadId,
                replacing: allowedTitles
            )
        }
    }

    private func generatedThreadTitleOrNil(
        seed: String,
        threadId: String,
        attachmentCount: Int
    ) async -> String? {
        var params: [String: JSONValue] = [
            "message": .string(seed),
            "attachmentCount": .integer(attachmentCount),
        ]
        if let model = gitWriterModelIdentifier(),
           !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            params["model"] = .string(model)
        }
        if let workingDirectory = thread(for: threadId)?.gitWorkingDirectory,
           !workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            params["cwd"] = .string(workingDirectory)
        }

        do {
            let response = try await sendRequest(method: "thread/generateTitle", params: .object(params))
            let title = response.result?.objectValue?["title"]?.stringValue?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return title?.isEmpty == false ? title : nil
        } catch {
            return nil
        }
    }

    private func automaticThreadTitleSeedIfNeeded(
        userInput: String,
        attachments: [CodexImageAttachment],
        threadId: String
    ) -> String? {
        guard persistedThreadRename(for: threadId) == nil,
              let thread = thread(for: threadId),
              CodexThread.isGenericPlaceholderTitle(thread.title) || thread.displayTitle == CodexThread.defaultDisplayTitle,
              !hasExistingUserChatMessage(threadId: threadId) else {
            return nil
        }

        let trimmedInput = userInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedInput.isEmpty {
            return trimmedInput
        }
        return attachments.isEmpty ? nil : "Image request"
    }

    private func hasExistingUserChatMessage(threadId: String) -> Bool {
        (messagesByThread[threadId] ?? []).contains { message in
            message.role == .user && message.kind == .chat
        }
    }

    private func fallbackThreadTitle(from seed: String) -> String {
        let words = seed
            .components(separatedBy: .whitespacesAndNewlines)
            .map { word in
                word.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
            }
            .filter { !$0.isEmpty }
            .prefix(4)
        let title = words.joined(separator: " ")
        guard !title.isEmpty else {
            return CodexThread.defaultDisplayTitle
        }
        return title.prefix(1).uppercased() + title.dropFirst()
    }

    // Steers an active turn using the same mixed input-item encoding as turn/start.
    func steerTurn(
        userInput: String,
        threadId: String,
        expectedTurnId: String?,
        attachments: [CodexImageAttachment] = [],
        skillMentions: [CodexTurnSkillMention] = [],
        mentionMentions: [CodexTurnMention] = [],
        fileMentions: [String] = [],
        shouldAppendUserMessage: Bool = true,
        preAppendedUserMessageID: String? = nil,
        collaborationMode: CodexCollaborationModeKind? = nil
    ) async throws {
        let normalizedThreadID = normalizedInterruptIdentifier(threadId) ?? threadId
        let effectiveRequestedCollaborationMode = collaborationModeForOutgoingTurn(
            threadId: normalizedThreadID,
            requestedMode: collaborationMode
        )
        preparePlanSessionForSteer(
            threadId: normalizedThreadID,
            collaborationMode: effectiveRequestedCollaborationMode
        )
        let normalizedPreAppendedUserMessageID = normalizedInterruptIdentifier(preAppendedUserMessageID)
        let pendingMessageId: String
        if let normalizedPreAppendedUserMessageID {
            pendingMessageId = normalizedPreAppendedUserMessageID
        } else if shouldAppendUserMessage {
            pendingMessageId = appendUserMessage(
                threadId: normalizedThreadID,
                text: displayTextForOutgoingTurn(
                    userInput: userInput,
                    skillMentions: skillMentions,
                    mentionMentions: mentionMentions
                ),
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
            pendingMessageId = ""
        }
        var resolvedExpectedTurnID = normalizedInterruptIdentifier(expectedTurnId)
        if resolvedExpectedTurnID == nil {
            do {
                resolvedExpectedTurnID = try await resolveInFlightTurnID(threadId: normalizedThreadID)
            } catch {
                handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
                throw error
            }
        }

        guard let initialTurnID = resolvedExpectedTurnID else {
            let error = CodexServiceError.invalidInput("No active turn available to steer")
            handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
            throw error
        }

        var includeStructuredSkillItems = supportsStructuredSkillInput && !skillMentions.isEmpty
        var includeStructuredMentionItems = supportsStructuredMentionInput && !mentionMentions.isEmpty
        var imageURLKey = "url"
        var effectiveCollaborationMode = supportsTurnCollaborationMode ? effectiveRequestedCollaborationMode : nil
        var currentExpectedTurnID = initialTurnID
        var didRetryWithRefreshedTurnID = false

        if effectiveRequestedCollaborationMode != nil, effectiveCollaborationMode == nil {
            debugRuntimeLog(
                "turn/steer dropping collaborationMode requested=\(effectiveRequestedCollaborationMode?.rawValue ?? "") thread=\(normalizedThreadID) supportsTurnCollaborationMode=\(supportsTurnCollaborationMode)"
            )
        }

        while true {
            var params: RPCObject = [
                "threadId": .string(normalizedThreadID),
                "expectedTurnId": .string(currentExpectedTurnID),
                "input": .array(
                    makeTurnInputPayload(
                        userInput: userInput,
                        attachments: attachments,
                        imageURLKey: imageURLKey,
                        skillMentions: skillMentions,
                        mentionMentions: mentionMentions,
                        includeStructuredSkillItems: includeStructuredSkillItems,
                        includeStructuredMentionItems: includeStructuredMentionItems
                    )
                ),
            ]
            if let collaborationModePayload = try buildCollaborationModePayload(
                for: effectiveCollaborationMode,
                threadId: normalizedThreadID
            ) {
                params["collaborationMode"] = collaborationModePayload
            }

            do {
                let response = try await sendRequest(method: "turn/steer", params: .object(params))
                let resolvedTurnID = extractTurnID(from: response.result) ?? currentExpectedTurnID
                markMessageDeliveryState(
                    threadId: normalizedThreadID,
                    messageId: pendingMessageId,
                    state: .confirmed,
                    turnId: resolvedTurnID
                )
                activeTurnId = resolvedTurnID
                setActiveTurnID(resolvedTurnID, for: normalizedThreadID)
                threadIdByTurnID[resolvedTurnID] = normalizedThreadID
                markThreadAsRunning(normalizedThreadID)
                setProtectedRunningFallback(false, for: normalizedThreadID)
                return
            } catch {
                if includeStructuredSkillItems,
                   shouldRetryTurnStartWithoutSkillItems(error) {
                    supportsStructuredSkillInput = false
                    includeStructuredSkillItems = false
                    continue
                }

                if includeStructuredMentionItems,
                   shouldRetryTurnStartWithoutMentionItems(error) {
                    supportsStructuredMentionInput = false
                    includeStructuredMentionItems = false
                    continue
                }

                if imageURLKey == "url",
                   !attachments.isEmpty,
                   shouldRetryTurnStartWithImageURLField(error) {
                    imageURLKey = "image_url"
                    continue
                }

                if effectiveCollaborationMode != nil,
                   shouldRetryTurnStartWithoutCollaborationMode(error) {
                    // Keep steer compatible with runtimes that only support plain turns.
                    supportsTurnCollaborationMode = false
                    clearPlanSessionIfRuntimeDowngraded(
                        threadId: normalizedThreadID,
                        collaborationMode: effectiveCollaborationMode
                    )
                    effectiveCollaborationMode = nil
                    continue
                }

                if !didRetryWithRefreshedTurnID,
                   shouldRetrySteerWithRefreshedTurnID(error) {
                    do {
                        if let refreshedTurnID = try await resolveInFlightTurnID(threadId: normalizedThreadID),
                           refreshedTurnID != currentExpectedTurnID {
                            didRetryWithRefreshedTurnID = true
                            currentExpectedTurnID = refreshedTurnID
                            activeTurnId = refreshedTurnID
                            setActiveTurnID(refreshedTurnID, for: normalizedThreadID)
                            threadIdByTurnID[refreshedTurnID] = normalizedThreadID
                            continue
                        }
                    } catch {
                        handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
                        throw error
                    }
                }

                handleSteerFailure(error, pendingMessageId: pendingMessageId, threadId: normalizedThreadID)
                throw error
            }
        }
    }

    // Applies common failure bookkeeping for turn/start primary and fallback attempts.
    func handleTurnStartFailure(
        _ error: Error,
        pendingMessageId: String,
        threadId: String
    ) throws {
        markMessageDeliveryState(threadId: threadId, messageId: pendingMessageId, state: .failed)
        clearRunningState(for: threadId)
        if shouldTreatAsThreadNotFound(error) {
            throw error
        }

        if let footerMessage = userFacingTurnErrorMessageForFooter(from: error) {
            lastErrorMessage = footerMessage
        } else {
            lastErrorMessage = nil
        }
        if !shouldSuppressRuntimeErrorInChat(error),
           let errorMessage = userFacingTurnErrorMessageForFooter(from: error) {
            appendSystemMessage(threadId: threadId, text: "Send error: \(errorMessage)")
        }
        throw error
    }

    // Handles successful turn/start bookkeeping for both primary and fallback payload schemas.
    @discardableResult
    func handleSuccessfulTurnStartResponse(
        _ response: RPCMessage,
        pendingMessageId: String,
        threadId: String
    ) -> String? {
        let turnID = extractTurnID(from: response.result)
        let resolvedTurnID = turnID ?? activeTurnIdByThread[threadId]
        let deliveryState: CodexMessageDeliveryState = (resolvedTurnID == nil) ? .pending : .confirmed
        markMessageDeliveryState(
            threadId: threadId,
            messageId: pendingMessageId,
            state: deliveryState,
            turnId: resolvedTurnID
        )

        if let turnID = resolvedTurnID {
            activeTurnId = turnID
            setActiveTurnID(turnID, for: threadId)
            threadIdByTurnID[turnID] = threadId
            setProtectedRunningFallback(false, for: threadId)
            beginAssistantMessage(threadId: threadId, turnId: turnID)
        }

        if let index = threadIndex(for: threadId) {
            threads[index].updatedAt = Date()
            threads[index].syncState = .live
            threads = sortThreads(threads)
        }

        return resolvedTurnID
    }

    // Applies steer failure bookkeeping for optimistic user rows without adding an extra system error card.
    func handleSteerFailure(
        _ error: Error,
        pendingMessageId: String,
        threadId: String
    ) {
        markMessageDeliveryState(threadId: threadId, messageId: pendingMessageId, state: .failed)
        lastErrorMessage = userFacingTurnErrorMessageForFooter(from: error)
    }

    // Some server versions expect `image_url` instead of `url` for image items.
    func shouldRetryTurnStartWithImageURLField(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("image_url") else {
            return false
        }

        return message.contains("missing")
            || message.contains("unknown field")
            || message.contains("expected")
            || message.contains("invalid")
    }

    // Detects legacy servers that reject input items with `type: "skill"`.
    func shouldRetryTurnStartWithoutSkillItems(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("skill") || isGenericStructuredInputItemRejection(message) else {
            return false
        }

        return message.contains("unknown")
            || message.contains("unsupported")
            || message.contains("invalid")
            || message.contains("expected")
            || message.contains("unrecognized")
            || message.contains("type")
            || message.contains("field")
    }

    // Detects legacy runtimes that reject input items with `type: "mention"`.
    func shouldRetryTurnStartWithoutMentionItems(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("mention") || isGenericStructuredInputItemRejection(message) else {
            return false
        }

        return message.contains("unknown")
            || message.contains("unsupported")
            || message.contains("invalid")
            || message.contains("expected")
            || message.contains("unrecognized")
            || message.contains("type")
            || message.contains("field")
    }

    private func isGenericStructuredInputItemRejection(_ message: String) -> Bool {
        let mentionsInputShape = message.contains("input")
            && (message.contains("item") || message.contains("type") || message.contains("array") || message.contains("schema"))
        let rejectsShape = message.contains("unknown")
            || message.contains("unsupported")
            || message.contains("invalid")
            || message.contains("expected")
            || message.contains("unrecognized")
            || message.contains("field")
        return mentionsInputShape && rejectsShape
    }

    // Detects runtimes that reject plan-mode `collaborationMode` without `experimentalApi`.
    func shouldRetryTurnStartWithoutCollaborationMode(_ error: Error) -> Bool {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let rpcError) = serviceError else {
            return false
        }

        let message = rpcError.message.lowercased()
        guard message.contains("collaborationmode") || message.contains("collaboration_mode") else {
            return false
        }

        return message.contains("experimentalapi")
            || message.contains("unsupported")
            || message.contains("unknown")
            || message.contains("unexpected")
            || message.contains("unrecognized")
            || message.contains("invalid")
            || message.contains("field")
            || message.contains("mode")
    }

    // Starts the app-server's manual context compaction turn for the selected thread.
    func compactThread(_ threadId: String) async throws {
        activeThreadId = threadId
        markThreadAsRunning(threadId)
        setProtectedRunningFallback(true, for: threadId)

        do {
            _ = try await sendRequest(
                method: "thread/compact/start",
                params: .object(["threadId": .string(threadId)])
            )
            lastErrorMessage = nil
        } catch {
            clearRunningState(for: threadId)
            let errorMessage = userFacingTurnErrorMessage(from: error)
            lastErrorMessage = errorMessage
            appendSystemMessage(threadId: threadId, text: "Compact error: \(errorMessage)")
            throw error
        }
    }
}
