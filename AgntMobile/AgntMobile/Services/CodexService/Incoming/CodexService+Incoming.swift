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
        case "system/notice":
            handleSystemNotice(paramsObject)

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

        case "item/autoApprovalReview":
            handleAutoApprovalReviewNotification(paramsObject)

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

}
