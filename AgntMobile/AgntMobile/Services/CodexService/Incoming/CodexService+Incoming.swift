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
