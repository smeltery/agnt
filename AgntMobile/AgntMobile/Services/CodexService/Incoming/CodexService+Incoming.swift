// FILE: CodexService+Incoming.swift
// Purpose: Inbound message decoding and event routing.
// Layer: Service
// Exports: CodexService inbound handlers
// Depends on: RPCMessage

import Foundation

typealias IncomingParamsObject = [String: JSONValue]

// Off-actor wire message classification and JSON-RPC decoding so transport callbacks
// can parse before dispatching typed results to MainActor.
enum WireMessagePreDecoder {
    enum Result: Sendable {
        case message(RPCMessage)
        case decodeFailed
        case invalidUTF8
    }

    struct Classification: Sendable {
        let isSecure: Bool
        let rpcResult: Result?
    }

    nonisolated private static let secureKindValues = [
        "\"serverHello\"", "\"secureReady\"", "\"secureError\"", "\"encryptedEnvelope\""
    ]

    nonisolated static func decodeRPCMessage(from text: String) -> Result {
        guard let data = text.data(using: .utf8) else { return .invalidUTF8 }
        do {
            let message = try JSONDecoder().decode(RPCMessage.self, from: data)
            return .message(message)
        } catch {
            return .decodeFailed
        }
    }

    nonisolated static func classify(_ text: String) -> Classification {
        if text.contains("\"kind\":") {
            for value in secureKindValues {
                if text.contains(value) {
                    return Classification(isSecure: true, rpcResult: nil)
                }
            }
        }
        return Classification(isSecure: false, rpcResult: decodeRPCMessage(from: text))
    }
}

extension CodexService {
    func processIncomingText(_ text: String) {
        guard let payloadData = text.data(using: .utf8) else {
            return
        }

        do {
            let message = try decoder.decode(RPCMessage.self, from: payloadData)
            handleIncomingRPCMessage(message)
        } catch {
            lastErrorMessage = "Unable to decode server payload"
        }
    }

    // Handles a pre-decoded RPC message from off-actor transport paths.
    func handleDecodedRPCResult(_ result: WireMessagePreDecoder.Result, rawText: String) {
        switch result {
        case .message(let message):
            lastRawMessage = rawText
            handleIncomingRPCMessage(message)
        case .decodeFailed:
            lastErrorMessage = "Unable to decode server payload"
        case .invalidUTF8:
            break
        }
    }

    func handleIncomingRPCMessage(_ message: RPCMessage) {
        if let method = message.method {
            let normalizedMethod = normalizedIncomingMethodName(method)
            if let requestID = message.id {
                handleServerRequest(method: normalizedMethod, requestID: requestID, params: message.params)
            } else {
                handleNotification(method: normalizedMethod, params: message.params)
            }
            return
        }

        guard let responseID = message.id else {
            return
        }

        let requestKey = idKey(from: responseID)
        guard let continuation = pendingRequests.removeValue(forKey: requestKey) else {
            return
        }

        if let rpcError = message.error {
            continuation.resume(throwing: CodexServiceError.rpcError(rpcError))
        } else {
            continuation.resume(returning: message)
        }
    }

    // Handles server-initiated RPC requests like approval prompts.
    func handleServerRequest(method: String, requestID: JSONValue, params: JSONValue?) {
        if method == "item/tool/requestUserInput" || method == "tool/requestUserInput" {
            let paramsObject = params?.objectValue
            debugRuntimeLog(
                "rpc request \(method) thread=\(paramsObject?["threadId"]?.stringValue ?? "") turn=\(paramsObject?["turnId"]?.stringValue ?? "") item=\(paramsObject?["itemId"]?.stringValue ?? "")"
            )
            handleStructuredUserInputRequest(
                requestID: requestID,
                paramsObject: paramsObject
            )
            return
        }

        if method == "item/commandExecution/requestApproval"
            || method == "item/fileChange/requestApproval"
            || method.hasSuffix("requestApproval") {
            let paramsObject = params?.objectValue
            let request = CodexApprovalRequest(
                id: idKey(from: requestID),
                requestID: requestID,
                method: method,
                command: paramsObject?["command"]?.stringValue,
                reason: paramsObject?["reason"]?.stringValue,
                threadId: paramsObject?["threadId"]?.stringValue,
                turnId: paramsObject?["turnId"]?.stringValue,
                params: params
            )

            if selectedAccessMode == .fullAccess {
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    do {
                        debugRuntimeLog("auto-approve triggered method=\(method)")
                        try await sendResponse(
                            id: requestID,
                            result: approvalResponseResult(for: request, decision: "accept")
                        )
                    } catch {
                        debugRuntimeLog("auto-approve failed method=\(method): \(error.localizedDescription)")
                        enqueuePendingApproval(request)
                    }
                }
                return
            }

            enqueuePendingApproval(request)
            return
        }

        switch method {
        default:
            Task { [requestID] in
                try? await sendErrorResponse(
                    id: requestID,
                    code: -32601,
                    message: "Unsupported request method: \(method)"
                )
            }
        }
    }

    // Handles stream notifications to keep UI state in sync.
    func handleNotification(method: String, params: JSONValue?) {
        let paramsObject = params?.objectValue
        let previousReplayScope = isApplyingReplayedBridgeEvent
        if isBufferedReplayResetEvent(method: method, paramsObject: paramsObject) {
            handleBufferedReplayReset(paramsObject)
            return
        }
        if isBufferedReplayGapEvent(method: method, paramsObject: paramsObject) {
            handleBufferedReplayGap(paramsObject)
            return
        }
        if isReplayedBridgeEvent(paramsObject) {
            isApplyingReplayedBridgeEvent = true
        }
        defer { isApplyingReplayedBridgeEvent = previousReplayScope }

        switch method {
        case "item/completed":
            recordCompactRuntimeItemCompletion(itemType: debugNotificationItemType(paramsObject: paramsObject))
        case "turn/plan/updated", "item/plan/delta", "serverRequest/resolved":
            debugRuntimeLog(
                debugNotificationSummary(method: method, paramsObject: paramsObject)
            )
        default:
            break
        }

        switch method {
        case "thread/started":
            handleThreadStarted(paramsObject)

        case "thread/name/updated":
            handleThreadNameUpdated(paramsObject)

        case "thread/status/changed":
            handleThreadStatusChanged(paramsObject)

        case "thread/goal/updated":
            handleThreadGoalUpdated(paramsObject)

        case "thread/goal/cleared":
            handleThreadGoalCleared(paramsObject)

        case "turn/started":
            handleTurnStarted(paramsObject)

        case "turn/completed":
            handleTurnCompleted(paramsObject)

        case "turn/plan/updated":
            handleTurnPlanUpdated(paramsObject)

        case "item/agentMessage/delta",
             "codex/event/agent_message_content_delta",
             "codex/event/agent_message_delta":
            appendAgentDelta(from: paramsObject)

        case "codex/event/user_message":
            appendMirroredUserMessage(from: paramsObject)

        case "item/plan/delta":
            appendPlanDelta(from: paramsObject)

        case "item/reasoning/summaryTextDelta",
             "item/reasoning/summaryPartAdded",
             "item/reasoning/textDelta":
            appendReasoningDelta(from: paramsObject, method: method)

        case "item/fileChange/outputDelta":
            appendFileChangeDelta(from: paramsObject)

        case "item/toolCall/outputDelta",
             "item/toolCall/output_delta",
             "item/tool_call/outputDelta",
             "item/tool_call/output_delta":
            appendToolCallDelta(from: paramsObject)

        case "item/commandExecution/outputDelta",
             "item/command_execution/outputDelta":
            appendCommandExecutionDelta(from: paramsObject)

        case "item/commandExecution/terminalInteraction",
             "item/command_execution/terminalInteraction":
            handleCommandExecutionTerminalInteraction(from: paramsObject)

        case "codex/event/exec_command_begin",
             "codex/event/exec_command_output_delta",
             "codex/event/exec_command_end",
             "codex/event/background_event",
             "codex/event/read",
             "codex/event/search",
             "codex/event/list_files",
             "codex/event/image_generation_end":
            if handleLegacyCodexNamedEvent(method: method, paramsObject: paramsObject) {
                return
            }

        case "turn/diff/updated", "codex/event/turn_diff_updated", "codex/event/turn_diff":
            handleTurnDiffUpdated(paramsObject)

        case "codex/event/patch_apply_begin", "codex/event/patch_apply_end":
            if handleLegacyPatchApplyMethod(method: method, paramsObject: paramsObject) {
                return
            }

        case "codex/event":
            if handleLegacyCodexEnvelopeEvent(paramsObject) {
                return
            }

        case "image_generation_end":
            if handleLegacyCodexEventType(
                eventType: "image_generation_end",
                payload: paramsObject ?? [:],
                paramsObject: paramsObject
            ) {
                return
            }

        case "thread/tokenUsage/updated":
            handleThreadTokenUsageUpdated(paramsObject)

        case "thread/replaced":
            handleThreadReplaced(paramsObject)

        case "account/updated":
            handleGPTAccountUpdated(paramsObject)

        case "account/login/completed":
            handleGPTLoginCompletedNotification(paramsObject)

        case "account/rateLimits/updated":
            handleRateLimitsUpdated(paramsObject)

        case "item/completed", "codex/event/item_completed", "codex/event/agent_message":
            appendCompletedAgentText(from: paramsObject)

        case "item/started", "codex/event/item_started":
            handleItemStarted(paramsObject)

        case "error", "codex/event/error", "turn/failed":
            handleErrorNotification(paramsObject)

        case "serverRequest/resolved":
            handleServerRequestResolved(paramsObject)

        case "git/stackedAction/progress":
            handleGitStackedActionProgress(paramsObject)

        case "terminal/event":
            handleTerminalEvent(paramsObject)

        default:
            if method.hasPrefix("codex/event/"),
               handleLegacyCodexNamedEvent(method: method, paramsObject: paramsObject) {
                return
            }
            if handleToolCallNotificationFallback(method: method, paramsObject: paramsObject) {
                return
            }
            if handleDiffNotificationFallback(method: method, paramsObject: paramsObject) {
                return
            }
            if handleFileChangeNotificationFallback(method: method, paramsObject: paramsObject) {
                return
            }
        }
    }

    // Captures file-change notifications even when the server uses variant method names.
    private func handleFileChangeNotificationFallback(
        method: String,
        paramsObject: IncomingParamsObject?
    ) -> Bool {
        let normalizedMethod = method
            .lowercased()
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")

        guard normalizedMethod.contains("filechange") else {
            return false
        }

        if normalizedMethod.contains("delta") || normalizedMethod.contains("partadded") {
            appendFileChangeDelta(from: paramsObject)
            return true
        }

        if normalizedMethod.contains("started") {
            handleFileChangeLifecycleFallback(paramsObject, isCompleted: false)
            return true
        }

        if normalizedMethod.contains("completed")
            || normalizedMethod.contains("finished")
            || normalizedMethod.contains("done") {
            handleFileChangeLifecycleFallback(paramsObject, isCompleted: true)
            return true
        }

        // Unknown file-change notification shape: try best-effort lifecycle decode.
        handleFileChangeLifecycleFallback(paramsObject, isCompleted: false)
        return true
    }

    // Captures tool-call notifications that carry file-change payloads under generic names.
    private func handleToolCallNotificationFallback(
        method: String,
        paramsObject: IncomingParamsObject?
    ) -> Bool {
        let normalizedMethod = method
            .lowercased()
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")

        guard normalizedMethod.contains("toolcall") else {
            return false
        }

        if normalizedMethod.contains("delta") || normalizedMethod.contains("partadded") {
            appendToolCallDelta(from: paramsObject)
            return true
        }

        if normalizedMethod.contains("started") {
            handleToolCallLifecycleFallback(paramsObject, isCompleted: false)
            return true
        }

        if normalizedMethod.contains("completed")
            || normalizedMethod.contains("finished")
            || normalizedMethod.contains("done") {
            handleToolCallLifecycleFallback(paramsObject, isCompleted: true)
            return true
        }

        handleToolCallLifecycleFallback(paramsObject, isCompleted: false)
        return true
    }

    // Captures diff-centric notifications when servers emit non-standard method aliases.
    private func handleDiffNotificationFallback(
        method: String,
        paramsObject: IncomingParamsObject?
    ) -> Bool {
        let normalizedMethod = method
            .lowercased()
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")

        let isDiffMethod = normalizedMethod.contains("turndiff")
            || normalizedMethod.contains("/diff/")
            || normalizedMethod.hasPrefix("diff/")
            || normalizedMethod.hasSuffix("/diff")
            || normalizedMethod.contains("itemdiff")
        guard isDiffMethod else {
            return false
        }

        let payloadObject = envelopeEventObject(from: paramsObject) ?? paramsObject
        guard let payloadObject else {
            return false
        }

        _ = handleStructuredItemLifecycle(
            itemObject: payloadObject,
            paramsObject: paramsObject,
            itemType: "diff",
            isCompleted: true
        )
        return true
    }

    private func handleThreadStarted(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject,
              let threadValue = paramsObject["thread"],
              let thread = decodeModel(CodexThread.self, from: threadValue) else {
            return
        }

        upsertThread(thread, treatAsServerState: true)
        if activeThreadId == nil {
            activeThreadId = thread.id
        }
        requestImmediateSync(threadId: thread.id)
    }

    private func handleThreadReplaced(_ paramsObject: IncomingParamsObject?) {
        guard let threadId = extractThreadID(from: paramsObject)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !threadId.isEmpty else {
            return
        }

        projectedTerminalStateByThreadID.removeValue(forKey: threadId)
        pendingCanonicalSourceReplacementThreadIDs.insert(threadId)
        forcedHistoryLoadThreadIDs.insert(threadId)
        markThreadNeedingCanonicalHistoryReconcile(threadId, requestImmediateSync: true)
    }

    // Mirrors desktop behavior: when server pushes a thread rename, update local
    // title immediately instead of waiting for the next thread/list refresh.
    private func handleThreadNameUpdated(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject else {
            return
        }

        guard let threadId = extractThreadID(from: paramsObject)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !threadId.isEmpty else {
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let renameKeys = ["threadName", "thread_name", "name", "title"]
        let hasExplicitRenameField = hasAnyValue(in: paramsObject, keys: renameKeys)
            || hasAnyValue(in: eventObject, keys: renameKeys)
        let threadName = firstStringValue(in: paramsObject, keys: renameKeys)
            ?? firstStringValue(in: eventObject, keys: renameKeys)
        let normalizedThreadName = normalizedIdentifier(threadName)
        let hasLocalRename = persistedThreadRename(for: threadId) != nil

        if let normalizedThreadName, !normalizedThreadName.isEmpty {
            guard !hasLocalRename else {
                return
            }
            if let existingIndex = threadIndex(for: threadId) {
                threads[existingIndex].title = normalizedThreadName
                threads[existingIndex].name = normalizedThreadName
            } else {
                threads.append(
                    CodexThread(
                        id: threadId,
                        title: normalizedThreadName,
                        name: normalizedThreadName
                    )
                )
            }
            threads = sortThreads(threads)
            requestImmediateSync(threadId: threadId)
            return
        }

        // If server explicitly sends an empty/null name, clear local custom title.
        guard hasExplicitRenameField,
              !hasLocalRename,
              let existingIndex = threadIndex(for: threadId) else {
            return
        }

        threads[existingIndex].title = nil
        threads[existingIndex].name = nil
        threads = sortThreads(threads)
        requestImmediateSync(threadId: threadId)
    }

    private func handleTurnStarted(_ paramsObject: IncomingParamsObject?) {
        let threadId = resolveThreadID(from: paramsObject)
        let turnID = extractTurnIDForTurnLifecycleEvent(from: paramsObject)
        let isReplayedEvent = isReplayedBridgeEvent(paramsObject)

        if let threadId, !isReplayedEvent {
            markThreadAsRunning(threadId)
        }

        if let threadId, let turnID {
            threadIdByTurnID[turnID] = threadId
            confirmLatestPendingUserMessage(threadId: threadId, turnId: turnID)
            if !isReplayedEvent {
                setActiveTurnID(turnID, for: threadId)
                setProtectedRunningFallback(false, for: threadId)
            }
            // Do NOT create the assistant placeholder here.
            // It will be created lazily by ensureStreamingAssistantMessage()
            // when the first agent message delta arrives. Creating it here
            // gives it an orderIndex lower than thinking/reasoning messages
            // that arrive before the actual response, causing wrong visual order.
        } else if let threadId, !isReplayedEvent {
            setProtectedRunningFallback(true, for: threadId)
        }

        if let turnID, !isReplayedEvent {
            activeTurnId = turnID
        }

        requestImmediateSync(threadId: threadId ?? activeThreadId)
    }

    private func handleTurnCompleted(_ paramsObject: IncomingParamsObject?) {
        let completedTurnID = extractTurnIDForTurnLifecycleEvent(from: paramsObject)
        let turnFailureMessage = parseTurnFailureMessage(from: paramsObject)

        if let threadId = resolveThreadID(from: paramsObject, turnIdHint: completedTurnID) {
            if let completedTurnID {
                confirmLatestPendingUserMessage(threadId: threadId, turnId: completedTurnID)
            }
            let resolvedTurnID = completedTurnID ?? activeTurnIdByThread[threadId]
            let terminalState = parseTurnTerminalState(
                from: paramsObject,
                turnFailureMessage: turnFailureMessage
            )
            recordTurnTerminalState(threadId: threadId, turnId: resolvedTurnID, state: terminalState)
            noteTurnFinished(threadId: threadId, turnId: resolvedTurnID)
            markTurnCompleted(threadId: threadId, turnId: resolvedTurnID)
            if terminalState == .completed {
                Task { @MainActor [weak self] in
                    await self?.captureTurnEndWorkspaceCheckpointIfPossible(
                        threadId: threadId,
                        turnId: resolvedTurnID
                    )
                }
                markReadyIfUnread(threadId: threadId)
                notifyRunCompletionIfNeeded(threadId: threadId, turnId: resolvedTurnID, result: .completed)
            } else if terminalState == .failed {
                discardTurnStartWorkspaceCheckpointCopyIfNeeded(turnId: resolvedTurnID)
                markFailedIfUnread(threadId: threadId)
                notifyRunCompletionIfNeeded(threadId: threadId, turnId: resolvedTurnID, result: .failed)
            } else {
                discardTurnStartWorkspaceCheckpointCopyIfNeeded(turnId: resolvedTurnID)
            }
            requestImmediateSync(threadId: threadId)
            if terminalState == .completed {
                scheduleAppReviewPromptAfterSuccessfulRun(threadId: threadId, turnId: resolvedTurnID)
            }

            guard let turnFailureMessage else {
                return
            }

            let userFacingFailureMessage = userFacingRuntimeMessage(for: turnFailureMessage)
                ?? turnFailureMessage
            lastErrorMessage = shouldSuppressRuntimeMessageInChat(turnFailureMessage) ? nil : userFacingFailureMessage
            if !shouldSuppressRuntimeMessageInChat(turnFailureMessage) {
                appendSystemMessage(
                    threadId: threadId,
                    text: "Turn error: \(userFacingFailureMessage)",
                    turnId: completedTurnID
                )
            }
            return
        }

        finalizeAllStreamingState()

        guard let turnFailureMessage else {
            return
        }
        lastErrorMessage = shouldSuppressRuntimeMessageInChat(turnFailureMessage)
            ? nil
            : (userFacingRuntimeMessage(for: turnFailureMessage) ?? turnFailureMessage)
    }

    // Runs after turn completion bookkeeping so review prompting cannot affect runtime state.
    private func scheduleAppReviewPromptAfterSuccessfulRun(threadId: String, turnId: String?) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.appReviewPromptCoordinator.noteSuccessfulRun(
                threadId: threadId,
                turnId: turnId,
                isCurrentThreadVisible: self.activeThreadId == threadId
            )
        }
    }

    private func handleErrorNotification(_ paramsObject: IncomingParamsObject?) {
        if shouldRetryTurnError(from: paramsObject) {
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let paramsErrorObject = paramsObject?["error"]?.objectValue
        let eventErrorObject = eventObject?["error"]?.objectValue
        let nestedEventObject = paramsObject?["event"]?.objectValue
        let errorMessage = firstNonEmptyString([
            firstStringValue(in: paramsObject, keys: ["message"]),
            firstStringValue(in: paramsErrorObject, keys: ["message"]),
            firstStringValue(in: eventObject, keys: ["message"]),
            firstStringValue(in: eventErrorObject, keys: ["message"]),
            firstStringValue(in: nestedEventObject, keys: ["message"]),
        ]) ?? "Server error"
        let shouldSuppressErrorMessage = shouldSuppressRuntimeMessageInChat(errorMessage)
        let userFacingErrorMessage = userFacingRuntimeMessage(for: errorMessage) ?? errorMessage
        lastErrorMessage = shouldSuppressErrorMessage ? nil : userFacingErrorMessage

        let turnId = extractTurnID(from: paramsObject)
        if let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) {
            let resolvedTurnID = turnId ?? activeTurnIdByThread[threadId]
            if !shouldSuppressErrorMessage {
                appendSystemMessage(threadId: threadId, text: "Error: \(userFacingErrorMessage)", turnId: turnId)
            }
            recordTurnTerminalState(threadId: threadId, turnId: resolvedTurnID, state: .failed)
            noteTurnFinished(threadId: threadId, turnId: resolvedTurnID)
            markTurnCompleted(threadId: threadId, turnId: resolvedTurnID)
            discardTurnStartWorkspaceCheckpointCopyIfNeeded(turnId: resolvedTurnID)
            markFailedIfUnread(threadId: threadId)
            notifyRunCompletionIfNeeded(threadId: threadId, turnId: resolvedTurnID, result: .failed)
        } else {
            finalizeAllStreamingState()
        }
    }

    private func handleThreadTokenUsageUpdated(_ paramsObject: IncomingParamsObject?) {
        guard let threadId = extractThreadID(from: paramsObject), !threadId.isEmpty else {
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let usageObject = paramsObject?["usage"]?.objectValue
            ?? eventObject?["usage"]?.objectValue
            ?? paramsObject

        guard let usage = extractContextWindowUsage(from: usageObject) else { return }
        contextWindowUsageByThread[threadId] = usage
    }

    private func handleThreadStatusChanged(_ paramsObject: IncomingParamsObject?) {
        guard let threadId = extractThreadID(from: paramsObject), !threadId.isEmpty else {
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let nestedEventObject = paramsObject?["event"]?.objectValue
        let statusObject = paramsObject?["status"]?.objectValue
            ?? eventObject?["status"]?.objectValue
            ?? nestedEventObject?["status"]?.objectValue

        let rawStatusType = firstNonEmptyString([
            firstStringValue(in: statusObject, keys: ["type", "statusType", "status_type"]),
            firstStringValue(in: paramsObject, keys: ["status"]),
            firstStringValue(in: eventObject, keys: ["status"]),
            firstStringValue(in: nestedEventObject, keys: ["status"]),
        ]) ?? ""

        let normalizedStatusType = normalizeThreadStatusType(rawStatusType)

        if normalizedStatusType == "active"
            || normalizedStatusType == "running"
            || normalizedStatusType == "processing"
            || normalizedStatusType == "inprogress"
            || normalizedStatusType == "started"
            || normalizedStatusType == "pending" {
            guard !isApplyingReplayedBridgeEvent else {
                return
            }
            markThreadAsRunning(threadId)
            return
        }

        if normalizedStatusType == "idle"
            || normalizedStatusType == "notloaded"
            || normalizedStatusType == "completed"
            || normalizedStatusType == "done"
            || normalizedStatusType == "finished"
            || normalizedStatusType == "stopped"
            || normalizedStatusType == "systemerror" {
            // Keep only the protected fallback alive until a real turn lifecycle event lands.
            if activeTurnIdByThread[threadId] != nil
                || protectedRunningFallbackThreadIDs.contains(threadId)
                || hasStreamingMessage(in: threadId) {
                return
            }

            let activeTurnIdForThread = activeTurnIdByThread[threadId]
            let terminalState = threadTerminalState(from: normalizedStatusType)
            if let terminalState {
                recordTurnTerminalState(
                    threadId: threadId,
                    turnId: activeTurnIdForThread,
                    state: terminalState
                )
                noteTurnFinished(threadId: threadId, turnId: activeTurnIdForThread)
                if let completionResult = runCompletionResult(for: terminalState) {
                    notifyRunCompletionIfNeeded(
                        threadId: threadId,
                        turnId: activeTurnIdForThread,
                        result: completionResult
                    )
                }
            }
            markTurnCompleted(threadId: threadId, turnId: activeTurnIdForThread)
            clearRunningState(for: threadId)

            if normalizedStatusType.contains("error") {
                markFailedIfUnread(threadId: threadId)
            }
        }
    }

    // Parses the real terminal outcome so UI can distinguish completion from interruption.
    private func parseTurnTerminalState(
        from paramsObject: IncomingParamsObject?,
        turnFailureMessage: String?
    ) -> CodexTurnTerminalState {
        if turnFailureMessage != nil {
            return .failed
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let turnObject = paramsObject?["turn"]?.objectValue
        let statusObject = turnObject?["status"]?.objectValue
            ?? paramsObject?["status"]?.objectValue
            ?? eventObject?["status"]?.objectValue

        let rawStatus = firstNonEmptyString([
            firstStringValue(in: turnObject, keys: ["status"]),
            firstStringValue(in: paramsObject, keys: ["status"]),
            firstStringValue(in: eventObject, keys: ["status"]),
            firstStringValue(in: statusObject, keys: ["type", "statusType", "status_type"]),
        ]) ?? ""

        let normalizedStatus = normalizeThreadStatusType(rawStatus)
        if normalizedStatus.contains("cancel")
            || normalizedStatus.contains("abort")
            || normalizedStatus.contains("interrupt")
            || normalizedStatus.contains("stopped") {
            return .stopped
        }
        if normalizedStatus.contains("fail")
            || normalizedStatus.contains("error") {
            return .failed
        }
        return .completed
    }

    // Maps terminal runtime states onto the smaller notification vocabulary.
    private func runCompletionResult(for state: CodexTurnTerminalState) -> CodexRunCompletionResult? {
        switch state {
        case .completed:
            .completed
        case .failed:
            .failed
        case .stopped:
            nil
        }
    }

    private func parseTurnFailureMessage(from paramsObject: IncomingParamsObject?) -> String? {
        let turnObject = paramsObject?["turn"]?.objectValue
        let status = turnObject?["status"]?.stringValue
            ?? paramsObject?["status"]?.stringValue

        guard status == "failed" else {
            return nil
        }

        return turnObject?["error"]?.objectValue?["message"]?.stringValue
            ?? paramsObject?["error"]?.objectValue?["message"]?.stringValue
            ?? paramsObject?["errorMessage"]?.stringValue
            ?? "Turn failed with no details"
    }

    private func appendReasoningDelta(
        from paramsObject: IncomingParamsObject?,
        method: String
    ) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)

        let delta: String
        if method == "item/reasoning/summaryPartAdded" {
            let summaryIndex = paramsObject["summaryIndex"]?.intValue
                ?? paramsObject["summary_index"]?.intValue
                ?? eventObject?["summaryIndex"]?.intValue
                ?? eventObject?["summary_index"]?.intValue
                ?? 0
            let embeddedDelta = extractTextDelta(from: paramsObject)
            delta = "\(summaryIndex > 0 ? "\n\n" : "")\(embeddedDelta)"
        } else {
            delta = extractTextDelta(from: paramsObject)
        }
        guard !delta.isEmpty else { return }

        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return
        }
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]

        if let resolvedTurnId {
            threadIdByTurnID[resolvedTurnId] = threadId
        }

        let isReasoningTurnActive: Bool
        if let resolvedTurnId, !resolvedTurnId.isEmpty {
            if activeTurnIdByThread[threadId] == resolvedTurnId {
                isReasoningTurnActive = true
            } else {
                isReasoningTurnActive = activeTurnIdByThread[threadId] == nil
                    && runningThreadIDs.contains(threadId)
            }
        } else {
            isReasoningTurnActive = activeTurnIdByThread[threadId] != nil
                || runningThreadIDs.contains(threadId)
        }
        if !isReasoningTurnActive {
            let lateItemId = extractItemID(from: paramsObject, eventObject: eventObject)
            _ = mergeLateReasoningDeltaIfPossible(
                threadId: threadId,
                turnId: resolvedTurnId,
                itemId: lateItemId,
                delta: delta
            )
            return
        }

        let itemId = extractItemID(from: paramsObject, eventObject: eventObject)
        if let itemId, !itemId.isEmpty {
            appendStreamingSystemItemDelta(
                threadId: threadId,
                turnId: resolvedTurnId,
                itemId: itemId,
                kind: .thinking,
                delta: delta
            )
            return
        }

        if let resolvedTurnId, !resolvedTurnId.isEmpty {
            appendStreamingSystemTurnDelta(
                threadId: threadId,
                turnId: resolvedTurnId,
                kind: .thinking,
                delta: delta
            )
            return
        }

        appendSystemMessage(
            threadId: threadId,
            text: delta,
            turnId: resolvedTurnId,
            kind: .thinking
        )
    }

    private func appendFileChangeDelta(from paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)

        let delta = extractTextDelta(from: paramsObject)
        guard !delta.isEmpty else { return }

        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return
        }
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]

        if let resolvedTurnId {
            threadIdByTurnID[resolvedTurnId] = threadId
        }

        let itemId = extractItemID(from: paramsObject, eventObject: eventObject)
        if let itemId, !itemId.isEmpty {
            appendStreamingSystemItemDelta(
                threadId: threadId,
                turnId: resolvedTurnId,
                itemId: itemId,
                kind: .fileChange,
                delta: delta
            )
            return
        }

        if let resolvedTurnId, !resolvedTurnId.isEmpty {
            appendStreamingSystemTurnDelta(
                threadId: threadId,
                turnId: resolvedTurnId,
                kind: .fileChange,
                delta: delta
            )
            return
        }

        appendSystemMessage(
            threadId: threadId,
            text: delta,
            turnId: resolvedTurnId,
            kind: .fileChange
        )
    }

    private func appendToolCallDelta(from paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)
        let itemObject = extractIncomingItemObject(from: paramsObject, eventObject: eventObject)

        let delta = extractTextDelta(from: paramsObject)
        guard !delta.isEmpty else { return }
        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return
        }
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]

        if let resolvedTurnId {
            threadIdByTurnID[resolvedTurnId] = threadId
        }

        guard isLikelyFileChangeToolCall(itemObject: itemObject, fallbackText: delta) else {
            let activityLines = extractToolCallActivityLines(from: delta)
            guard !activityLines.isEmpty else {
                return
            }
            let itemId = extractItemID(from: paramsObject, eventObject: eventObject, itemObject: itemObject)
            let activityText = activityLines.joined(separator: "\n")
            if let itemId, !itemId.isEmpty {
                appendStreamingSystemItemDelta(
                    threadId: threadId,
                    turnId: resolvedTurnId,
                    itemId: itemId,
                    kind: .toolActivity,
                    delta: activityText
                )
                return
            }
            if let resolvedTurnId, !resolvedTurnId.isEmpty {
                appendStreamingSystemTurnDelta(
                    threadId: threadId,
                    turnId: resolvedTurnId,
                    kind: .toolActivity,
                    delta: activityText
                )
                return
            }
            appendSystemMessage(
                threadId: threadId,
                text: activityText,
                turnId: resolvedTurnId,
                kind: .toolActivity
            )
            return
        }

        let itemId = extractItemID(from: paramsObject, eventObject: eventObject, itemObject: itemObject)
        if let itemId, !itemId.isEmpty {
            appendStreamingSystemItemDelta(
                threadId: threadId,
                turnId: resolvedTurnId,
                itemId: itemId,
                kind: .fileChange,
                delta: delta
            )
            return
        }

        if let resolvedTurnId, !resolvedTurnId.isEmpty {
            appendStreamingSystemTurnDelta(
                threadId: threadId,
                turnId: resolvedTurnId,
                kind: .fileChange,
                delta: delta
            )
            return
        }

        appendSystemMessage(
            threadId: threadId,
            text: delta,
            turnId: resolvedTurnId,
            kind: .fileChange
        )
    }

    // Consumes turn-level aggregated diffs only after a real file-change item exists;
    // repo-wide dirty snapshots must not create turn-local change UI or undo state.
    func handleTurnDiffUpdated(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }

        let eventObject = envelopeEventObject(from: paramsObject)
        let nestedEventObject = paramsObject["event"]?.objectValue
        let diffCandidate = firstStringValue(in: paramsObject, keys: ["diff", "unified_diff"])
            ?? firstStringValue(in: eventObject, keys: ["diff", "unified_diff"])
            ?? firstStringValue(in: nestedEventObject, keys: ["diff", "unified_diff"])
        guard let diffText = normalizedUnifiedPatchPayload(diffCandidate ?? "") else { return }

        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return
        }
        if let turnId {
            threadIdByTurnID[turnId] = threadId
            if shouldRecordTurnDiffChangeSet(threadId: threadId, turnId: turnId, diff: diffText) {
                recordTurnDiffChangeSet(threadId: threadId, turnId: turnId, diff: diffText)
            }
        }
    }

    private func shouldRecordTurnDiffChangeSet(threadId: String, turnId: String, diff: String) -> Bool {
        let diffPaths = normalizedPatchPaths(from: diff)
        guard !diffPaths.isEmpty else {
            return false
        }

        let fileChangePaths = normalizedFileChangeEvidencePaths(threadId: threadId, turnId: turnId)
        guard !fileChangePaths.isEmpty else {
            return false
        }

        return diffPaths.isSubset(of: fileChangePaths)
    }

    private func normalizedPatchPaths(from diff: String) -> Set<String> {
        Set(AIUnifiedPatchParser.analyze(diff).fileChanges.compactMap {
            normalizedTurnDiffPath($0.path)
        })
    }

    private func normalizedFileChangeEvidencePaths(threadId: String, turnId: String) -> Set<String> {
        let fileChangeMessages = messagesByThread[threadId] ?? []
        return fileChangeMessages.reduce(into: Set<String>()) { paths, message in
            guard message.role == .system,
                  message.kind == .fileChange,
                  message.turnId == turnId else {
                return
            }

            for line in message.text.split(separator: "\n", omittingEmptySubsequences: false) {
                let trimmedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard trimmedLine.lowercased().hasPrefix("path:") else { continue }
                let rawPath = String(trimmedLine.dropFirst("Path:".count))
                if let normalizedPath = normalizedTurnDiffPath(rawPath) {
                    paths.insert(normalizedPath)
                }
            }
        }
    }

    private func normalizedTurnDiffPath(_ rawPath: String) -> String? {
        var normalized = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized != "/dev/null" else {
            return nil
        }

        if normalized.hasPrefix("a/") || normalized.hasPrefix("b/") {
            normalized = String(normalized.dropFirst(2))
        }
        if normalized.hasPrefix("./") {
            normalized = String(normalized.dropFirst(2))
        }

        normalized = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized.lowercased()
    }

    // Handles non-standard file-change started/completed envelopes without dropping UI updates.
    private func handleFileChangeLifecycleFallback(
        _ paramsObject: IncomingParamsObject?,
        isCompleted: Bool
    ) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)

        if let itemObject = extractIncomingItemObject(from: paramsObject, eventObject: eventObject) {
            _ = handleStructuredItemLifecycle(
                itemObject: itemObject,
                paramsObject: paramsObject,
                itemType: "filechange",
                isCompleted: isCompleted
            )
            return
        }

        let payloadObject = eventObject ?? paramsObject
        let body = decodeFileChangeItemBody(payloadObject)
        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return
        }

        if let turnId {
            threadIdByTurnID[turnId] = threadId
        }

        let itemId = extractItemID(from: paramsObject, eventObject: eventObject)
        if let itemId, !itemId.isEmpty {
            if isCompleted {
                completeStreamingSystemItemMessage(
                    threadId: threadId,
                    turnId: turnId,
                    itemId: itemId,
                    kind: .fileChange,
                    text: body
                )
            } else {
                upsertStreamingSystemItemMessage(
                    threadId: threadId,
                    turnId: turnId,
                    itemId: itemId,
                    kind: .fileChange,
                    text: body,
                    isStreaming: true
                )
            }
            return
        }

        if let turnId, !turnId.isEmpty {
            if isCompleted {
                completeStreamingSystemTurnMessage(
                    threadId: threadId,
                    turnId: turnId,
                    kind: .fileChange,
                    text: body
                )
            } else {
                upsertStreamingSystemTurnMessage(
                    threadId: threadId,
                    turnId: turnId,
                    kind: .fileChange,
                    text: body,
                    isStreaming: true
                )
            }
            return
        }

        appendSystemMessage(
            threadId: threadId,
            text: body,
            turnId: turnId,
            kind: .fileChange,
            isStreaming: !isCompleted
        )
    }

    private func handleToolCallLifecycleFallback(
        _ paramsObject: IncomingParamsObject?,
        isCompleted: Bool
    ) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)

        if let itemObject = extractIncomingItemObject(from: paramsObject, eventObject: eventObject) {
            _ = handleStructuredItemLifecycle(
                itemObject: itemObject,
                paramsObject: paramsObject,
                itemType: "toolcall",
                isCompleted: isCompleted
            )
            return
        }

        let payloadObject = eventObject ?? paramsObject
        _ = handleStructuredItemLifecycle(
            itemObject: payloadObject,
            paramsObject: paramsObject,
            itemType: "toolcall",
            isCompleted: isCompleted
        )
    }

    func handleStructuredItemLifecycle(
        itemObject: IncomingParamsObject,
        paramsObject: IncomingParamsObject?,
        itemType: String,
        isCompleted: Bool
    ) -> Bool {
        guard itemType == "reasoning"
            || itemType == "filechange"
            || itemType == "toolcall"
            || itemType == "commandexecution"
            || itemType == "collabagenttoolcall"
            || itemType == "collabtoolcall"
            || itemType.hasPrefix("collabagentspawn")
            || itemType.hasPrefix("collabwaiting")
            || itemType.hasPrefix("collabclose")
            || itemType.hasPrefix("collabresume")
            || itemType.hasPrefix("collabagentinteraction")
            || itemType == "diff"
            || itemType == "plan"
            || itemType == "todolist"
            || itemType == "enteredreviewmode"
            || itemType == "contextcompaction" else {
            return false
        }

        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return true
        }
        if let turnId {
            threadIdByTurnID[turnId] = threadId
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let itemId = extractItemID(from: paramsObject, eventObject: eventObject, itemObject: itemObject)

        let kind: CodexMessageKind
        let body: String
        var planState: CodexPlanState? = nil
        switch itemType {
        case "reasoning":
            kind = .thinking
            body = decodeReasoningItemBody(itemObject)
        case "filechange":
            kind = .fileChange
            body = decodeFileChangeItemBody(itemObject)
        case "toolcall":
            if let resolvedBody = decodeToolCallFileChangeBody(itemObject, isCompleted: isCompleted) {
                kind = .fileChange
                body = resolvedBody
            } else if let resolvedBody = decodeToolCallActivityBody(itemObject, isCompleted: isCompleted) {
                kind = .toolActivity
                body = resolvedBody
            } else {
                return false
            }
        case "commandexecution":
            kind = .commandExecution
            body = decodeCommandExecutionStatusText(itemObject, isCompleted: isCompleted)
        case let collabType where collabType == "collabagenttoolcall"
            || collabType == "collabtoolcall"
            || collabType.hasPrefix("collabagentspawn")
            || collabType.hasPrefix("collabwaiting")
            || collabType.hasPrefix("collabclose")
            || collabType.hasPrefix("collabresume")
            || collabType.hasPrefix("collabagentinteraction"):
            guard let subagentAction = decodeSubagentActionItem(from: itemObject) else {
                return false
            }
            upsertSubagentActionMessage(
                threadId: threadId,
                turnId: turnId,
                itemId: itemId,
                action: subagentAction,
                isStreaming: !isCompleted
            )
            return true
        case "diff":
            guard let resolvedBody = decodeDiffItemBody(itemObject, isCompleted: isCompleted) else {
                return false
            }
            kind = .fileChange
            body = resolvedBody
        case "plan", "todolist":
            kind = .plan
            body = decodePlanItemBody(itemObject)
            planState = decodePlanState(from: itemObject)
        case "enteredreviewmode":
            kind = .commandExecution
            let reviewLabel = firstNonEmptyString([
                itemObject["review"]?.stringValue,
                firstString(forKey: "review", in: .object(itemObject)),
            ]) ?? "changes"
            body = "Reviewing \(reviewLabel)..."
        case "contextcompaction":
            kind = .commandExecution
            body = isCompleted ? "Context compacted" : "Compacting context…"
        default:
            kind = .fileChange
            body = ""
        }

        if isCompleted,
           kind == .fileChange,
           let turnId,
           let patch = extractChangeSetUnifiedPatch(from: itemObject, itemType: itemType) {
            recordFallbackFileChangePatch(threadId: threadId, turnId: turnId, patch: patch)
        }

        if kind == .plan {
            guard CodexPlanUpdateVisibilityPolicy.shouldApply(
                text: body,
                planState: planState
            ) else {
                if isCompleted {
                    finalizeExistingPlanMessage(
                        threadId: threadId,
                        turnId: turnId,
                        itemId: itemId
                    )
                }
                return true
            }
            upsertPlanMessage(
                threadId: threadId,
                turnId: turnId,
                itemId: itemId,
                text: body,
                explanation: planState?.explanation,
                steps: planState?.steps,
                isStreaming: !isCompleted,
                planPresentation: isCompleted ? .resultCompletedItem : .resultStreaming
            )
            return true
        }

        if let itemId, !itemId.isEmpty {
            if isCompleted {
                completeStreamingSystemItemMessage(
                    threadId: threadId,
                    turnId: turnId,
                    itemId: itemId,
                    kind: kind,
                    text: body
                )
            } else {
                upsertStreamingSystemItemMessage(
                    threadId: threadId,
                    turnId: turnId,
                    itemId: itemId,
                    kind: kind,
                    text: body,
                    isStreaming: true
                )
            }
            return true
        }

        if let turnId, !turnId.isEmpty {
            if isCompleted {
                completeStreamingSystemTurnMessage(
                    threadId: threadId,
                    turnId: turnId,
                    kind: kind,
                    text: body
                )
            } else {
                upsertStreamingSystemTurnMessage(
                    threadId: threadId,
                    turnId: turnId,
                    kind: kind,
                    text: body,
                    isStreaming: true
                )
            }
            return true
        }

        appendSystemMessage(
            threadId: threadId,
            text: body,
            turnId: turnId,
            kind: kind,
            isStreaming: !isCompleted
        )
        return true
    }

    // Cleans up any server-owned request once app-server confirms the specific request id is resolved.
    func handleServerRequestResolved(_ paramsObject: IncomingParamsObject?) {
        guard let requestID = paramsObject?["requestId"] else {
            return
        }

        let threadId = normalizedResolvedRequestThreadID(paramsObject?["threadId"]?.stringValue)
        removeStructuredUserInputPrompt(requestID: requestID, threadIdHint: threadId)
        removePendingApproval(requestID: requestID)
    }

    // Routes phase notifications from `git/runStackedAction` to the per-call subscriber.
    func handleGitStackedActionProgress(_ paramsObject: IncomingParamsObject?) {
        guard let progressId = paramsObject?["progressId"]?.stringValue,
              let phase = paramsObject?["phase"]?.stringValue,
              let status = paramsObject?["status"]?.stringValue else {
            return
        }
        gitStackedActionProgressHandlers[progressId]?(phase, status)
    }

    func registerGitStackedActionProgressHandler(
        progressId: String,
        handler: @escaping (String, String) -> Void
    ) {
        gitStackedActionProgressHandlers[progressId] = handler
    }

    func unregisterGitStackedActionProgressHandler(progressId: String) {
        gitStackedActionProgressHandlers.removeValue(forKey: progressId)
    }
}

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
}

private extension CodexService {
    func normalizedResolvedRequestThreadID(_ rawValue: String?) -> String? {
        guard let rawValue else {
            return nil
        }

        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
